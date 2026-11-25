'use strict';

const fs = require('fs');
const path = require('path');
const {
  compareVersions,
  normalizeScript,
  isSecureScriptUrl,
  isJavaScriptFilename,
  safeScriptName,
  parseUserscriptMeta,
  looksLikeHtmlDocument,
} = require('./script-utils');
const { writeFileAtomic, writeJsonAtomicSync, readJsonSafeSync } = require('./fs-atomic');

const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

function assertScriptContent(content) {
  const text = String(content == null ? '' : content);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) throw new Error('脚本内容为空');
  if (bytes > MAX_SCRIPT_BYTES) throw new Error(`脚本超过 ${MAX_SCRIPT_BYTES / 1024 / 1024} MB 限制`);
  return text;
}

function createScriptManager({ getUserDataDir, fetchUrl }) {
  const scriptsDir = () => path.join(getUserDataDir(), 'scripts');
  const metaPath = () => path.join(getUserDataDir(), 'scripts-meta.json');

  function ensureScriptsDir() {
    const dir = scriptsDir();
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
  }

  function loadScriptsMeta() {
    return readJsonSafeSync(metaPath(), {});
  }

  function saveScriptsMeta(meta) {
    try {
      writeJsonAtomicSync(metaPath(), meta && typeof meta === 'object' ? meta : {});
      return true;
    } catch (_) {
      return false;
    }
  }

  async function writeScriptFile(name, content) {
    const safeName = safeScriptName(name);
    if (!safeName) throw new Error('脚本文件名无效');
    const text = assertScriptContent(content);
    const dir = ensureScriptsDir();
    const target = path.resolve(dir, safeName);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('脚本路径越界');

    await writeFileAtomic(target, text, 'utf8');
    return safeName;
  }

  function scriptSourceUrl(name, content, metaCache) {
    const meta = metaCache || loadScriptsMeta();
    const saved = (meta[name] && meta[name].sourceUrl) || '';
    if (saved) return saved;
    const parsed = parseUserscriptMeta(content || '');
    return parsed.downloadURL || parsed.updateURL || '';
  }

  async function listScriptFiles() {
    const dir = ensureScriptsDir();
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && isJavaScriptFilename(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  }

  async function listInjectableScripts() {
    const files = await listScriptFiles();
    const meta = loadScriptsMeta();
    return files.filter((name) => !meta[name] || meta[name].enabled !== false);
  }

  async function readScriptSummary(dir, name, savedMeta, runStatus) {
    const filePath = path.join(dir, name);
    const stat = await fs.promises.stat(filePath);
    const bytesToRead = Math.min(stat.size, 64 * 1024);
    const handle = await fs.promises.open(filePath, 'r');
    let content = '';
    try {
      const buf = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buf, 0, bytesToRead, 0);
      content = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const parsed = parseUserscriptMeta(content);
    const meta = savedMeta || {};
    return {
      name,
      mtime: stat.mtimeMs,
      size: stat.size,
      sourceUrl: meta.sourceUrl || parsed.downloadURL || parsed.updateURL || '',
      version: meta.version || parsed.version || '',
      description: parsed.description || '',
      nameFromMeta: parsed.name || '',
      enabled: meta.enabled !== false,
      lastError: runStatus && runStatus.error ? String(runStatus.error) : '',
    };
  }

  async function readScriptSummaries(runStatusMap) {
    const dir = ensureScriptsDir();
    const meta = loadScriptsMeta();
    const files = await listScriptFiles();
    return Promise.all(files.map((name) => readScriptSummary(
      dir,
      name,
      meta[name],
      runStatusMap ? runStatusMap.get(name) : null,
    )));
  }

  async function checkScriptUpdate(name, opts = {}) {
    const useCache = opts.noCache === false;
    const safeName = safeScriptName(name);
    if (!safeName) return { ok: false, error: '脚本文件名无效' };
    const dir = ensureScriptsDir();
    const filePath = path.join(dir, safeName);
    try {
      let localContent;
      try { localContent = await fs.promises.readFile(filePath, 'utf-8'); }
      catch (err) {
        if (err && err.code === 'ENOENT') return { ok: false, error: '脚本不存在' };
        throw err;
      }
      const sourceUrl = scriptSourceUrl(safeName, localContent);
      if (!sourceUrl) return { ok: false, error: '无来源 URL，无法检测更新', noUrl: true };
      if (!isSecureScriptUrl(sourceUrl)) return { ok: false, error: '脚本更新链接必须使用 HTTPS' };

      const localParsed = parseUserscriptMeta(localContent);
      const localVersion = localParsed.version || '';

      const { content: remoteContent } = await fetchUrl(sourceUrl, 90000, { noCache: !useCache });
      if (!remoteContent || !remoteContent.trim()) return { ok: false, error: '远端内容为空（可能被限流或链接失效）' };
      if (looksLikeHtmlDocument(remoteContent)) {
        return { ok: false, error: '远端返回的是网页而不是脚本（链接可能失效或被拦截）' };
      }

      const remoteParsed = parseUserscriptMeta(remoteContent);
      const remoteVersion = remoteParsed.version || '';
      const sameContent = normalizeScript(remoteContent) === normalizeScript(localContent);

      let hasUpdate = false;
      let reason = '';
      if (localVersion && remoteVersion) {
        const cmp = compareVersions(remoteVersion, localVersion);
        if (cmp > 0) {
          hasUpdate = true;
          reason = `版本 ${localVersion} → ${remoteVersion}`;
        } else if (cmp < 0) {
          hasUpdate = false;
          reason = `本地版本更新（${localVersion} > ${remoteVersion}）`;
        } else if (!sameContent) {
          hasUpdate = true;
          reason = `版本号未变（${localVersion}），内容有变化`;
        } else {
          reason = `已是最新版本（${localVersion}）`;
        }
      } else {
        hasUpdate = !sameContent;
        reason = hasUpdate ? '远程内容有变化' : '内容一致，无需更新';
      }

      return {
        ok: true,
        hasUpdate,
        reason,
        localVersion,
        remoteVersion,
        remoteContent: hasUpdate ? remoteContent : '',
      };
    } catch (err) {
      return { ok: false, error: err.message || '检测更新失败' };
    }
  }

  async function applyScriptUpdate(name, content) {
    const safeName = safeScriptName(name);
    if (!safeName) return { ok: false, error: '脚本文件名无效' };
    try {
      await writeScriptFile(safeName, content);
      const meta = loadScriptsMeta();
      if (!meta[safeName]) {
        const src = scriptSourceUrl(safeName, content, meta);
        meta[safeName] = { sourceUrl: src || '', version: '', updatedAt: 0, enabled: true };
      }
      meta[safeName].updatedAt = Date.now();
      if (meta[safeName].enabled === undefined) meta[safeName].enabled = true;
      const parsed = parseUserscriptMeta(content);
      if (parsed.version) meta[safeName].version = parsed.version;
      if (!meta[safeName].sourceUrl) {
        const src = parsed.downloadURL || parsed.updateURL || '';
        if (src) meta[safeName].sourceUrl = src;
      }
      saveScriptsMeta(meta);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function importFromUrl(url, filename) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:') {
        return { ok: false, error: '脚本链接必须使用 HTTPS' };
      }
      const { content } = await fetchUrl(url);
      if (!content || !content.trim()) return { ok: false, error: '下载内容为空' };
      if (looksLikeHtmlDocument(content)) {
        return { ok: false, error: '该链接返回的是网页而非脚本，请使用 .user.js 直链' };
      }

      let name = filename;
      if (!name) {
        const pathname = parsedUrl.pathname;
        const base = path.posix.basename(pathname);
        if (base && /\.(user\.js|js)$/i.test(base)) {
          name = base;
        } else {
          const parsed = parseUserscriptMeta(content);
          name = (parsed.name || 'imported') + '.user.js';
        }
      }
      name = safeScriptName(name, { fallback: 'imported.user.js', ensureExtension: true });

      await writeScriptFile(name, content);

      const meta = loadScriptsMeta();
      const parsed = parseUserscriptMeta(content);
      const prevEnabled = meta[name] ? meta[name].enabled !== false : true;
      meta[name] = {
        sourceUrl: url,
        version: parsed.version || '',
        updatedAt: Date.now(),
        enabled: prevEnabled,
      };
      saveScriptsMeta(meta);

      return { ok: true, name, version: parsed.version || '' };
    } catch (err) {
      return { ok: false, error: err.message || '下载失败' };
    }
  }

  async function importFromFilePaths(filePaths) {
    const items = [];
    const failed = [];
    const meta = loadScriptsMeta();
    for (const fp of filePaths || []) {
      try {
        const stat = await fs.promises.stat(fp);
        if (stat.size > MAX_SCRIPT_BYTES) throw new Error(`超过 ${MAX_SCRIPT_BYTES / 1024 / 1024} MB 限制`);
        const content = await fs.promises.readFile(fp, 'utf8');
        const name = safeScriptName(path.basename(fp), { fallback: 'script.user.js', ensureExtension: true });
        await writeScriptFile(name, content);
        const parsed = parseUserscriptMeta(content);
        const prevEnabled = meta[name] ? meta[name].enabled !== false : true;
        meta[name] = {
          sourceUrl: parsed.downloadURL || parsed.updateURL || '',
          version: parsed.version || '',
          updatedAt: Date.now(),
          enabled: prevEnabled,
        };
        items.push({ name, to: parsed.version || '' });
      } catch (err) {
        failed.push({ name: path.basename(fp), error: err.message });
      }
    }
    if (items.length) saveScriptsMeta(meta);
    return { ok: items.length > 0, items, failed };
  }

  async function setScriptEnabled(name, enabled) {
    const safeName = safeScriptName(name);
    if (!safeName) return { ok: false, error: '脚本文件名无效' };
    const target = path.join(ensureScriptsDir(), safeName);
    try {
      await fs.promises.access(target);
    } catch (_) {
      return { ok: false, error: '脚本不存在' };
    }
    const meta = loadScriptsMeta();
    const prev = meta[safeName] || {};
    meta[safeName] = {
      sourceUrl: prev.sourceUrl || '',
      version: prev.version || '',
      updatedAt: prev.updatedAt || Date.now(),
      enabled: enabled !== false,
    };
    const ok = saveScriptsMeta(meta);
    return ok ? { ok: true, name: safeName, enabled: enabled !== false } : { ok: false, error: '保存脚本状态失败' };
  }

  async function deleteScript(name) {
    const safeName = safeScriptName(name);
    if (!safeName) return { ok: false, error: '脚本文件名无效' };
    const target = path.join(scriptsDir(), safeName);
    try {
      try {
        await fs.promises.unlink(target);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      const meta = loadScriptsMeta();
      if (meta[safeName]) { delete meta[safeName]; saveScriptsMeta(meta); }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    MAX_SCRIPT_BYTES,
    scriptsDir,
    ensureScriptsDir,
    loadScriptsMeta,
    saveScriptsMeta,
    writeScriptFile,
    listScriptFiles,
    listInjectableScripts,
    readScriptSummaries,
    checkScriptUpdate,
    applyScriptUpdate,
    importFromUrl,
    importFromFilePaths,
    setScriptEnabled,
    deleteScript,
  };
}

module.exports = {
  MAX_SCRIPT_BYTES,
  createScriptManager,
};
