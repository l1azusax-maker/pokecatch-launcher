const { app, BrowserWindow, WebContentsView, session, shell, ipcMain, Menu, dialog, net, screen } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { compareVersions, normalizeScript, isSecureScriptUrl, isJavaScriptFilename } = require('./lib/script-utils');
const { mapLimit } = require('./lib/concurrency');
const { pruneScriptBackups } = require('./lib/script-backups');
const { setupAppUpdater } = require('./lib/app-updater');

// ============ 轻量优化开关 ============
const CONFIG = {
  gameUrl: 'https://pokecatch-online.netlify.app/',
  disableHardwareAcceleration: false,
};

// 硬件加速默认开启：游戏是 DOM/Canvas 密集渲染，关掉反而更卡。
// 真正的关闭开关是 --disable-gpu；--enable-gpu 保留为「显式确认开启」，
// 两个参数同时给时以 --enable-gpu 为准（旧版语义就是强制开启）。
CONFIG.disableHardwareAcceleration = process.argv.includes('--disable-gpu')
  && !process.argv.includes('--enable-gpu');
if (CONFIG.disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// 后台降频不再通过全局命令行开关永久关闭。创建游戏视图后由
// applyKeepActive() 调用 webContents.setBackgroundThrottling() 动态切换：
// 用户关闭「保持在线」时，Chromium 才能真正降低后台 CPU / GPU 占用。

// ============ UA 伪装成普通 Chrome ============
// Google 登录页会按 UA 判定「嵌入式浏览器」并直接拒绝（提示"此浏览器或应用可能不安全"），
// Electron 默认 UA 里带 Electron/31.x 和产品名，这里去掉，只保留标准 Chrome 段。
const CLEAN_UA = (() => {
  const base = app.userAgentFallback || '';
  const out = base
    .replace(/\sElectron\/[\d.]+/gi, '')
    .replace(/\sPokeCatch\/[\d.]+/gi, '')
    .replace(/\spokecatch-launcher\/[\d.]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || base;
})();
app.userAgentFallback = CLEAN_UA;

// Windows 应用标识：必须和 package.json 里 build.appId 一致（快捷方式用的就是它）。
// 不设的话主进程和 Chromium 派生的子进程可能各自被任务管理器当成不同应用，
// 于是任务管理器里出现两组「PokeCatch」（PokeCatch (3) / PokeCatch）。
// 设了之后它们共用同一个 AppUserModelID，合并成一条；顺带让任务栏图标、
// 跳转列表、Toast 归属都正确。
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.pokecatch.launcher'); } catch (_) {}
  dbg('[app] AppUserModelID =', (() => { try { return app.getName(); } catch (_) { return '?'; } })());
}


const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// 不吞掉未捕获异常：monitor 只负责补充日志，随后仍由 Node/Electron 的默认机制终止
// 已经进入未知状态的主进程，避免带着损坏的窗口/文件状态继续运行。
process.on('uncaughtExceptionMonitor', (err) => {
  try { console.error('[main] uncaughtException', err && err.stack ? err.stack : err); } catch (_) {}
});

let mainWindow = null;
let gameView = null;       // 装游戏页面的 WebContentsView（标题栏在窗口层，不在游戏页里）
let gameReady = false;     // 游戏是否已就绪
let gameReadyTimer = null;
let gameReadyRun = 0;

// 游戏页面的 webContents（所有注入 / 就绪检测 / 导航策略都作用在它上面）
function gameWC() {
  try {
    if (!gameView) return null;
    const wc = gameView.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  } catch (_) { return null; }
}

// 把游戏视图摆到「标题栏下方的那块区域」。
// 全屏时铺满整个窗口（标题栏隐藏）。这样游戏拿到的视口 = 窗口内容区 − 36px，
// 和浏览器里的 100vh 语义完全一致，不需要给游戏注入任何布局补偿。
//
// 细节（防「闪一下 / 画面缩一下又复原」）：
//   · 最大化/全屏动画期间 Windows 会连续发很多次 resize，某些中间帧里
//     getContentSize() 会给出 0 或极小的值 —— 直接 setBounds 会让游戏只画一帧
//     很小的画面，再在下一帧被撑回原尺寸，看起来就是闪一下 + 缩一下。
//     所以这里对「明显不合理的尺寸」（<1px，或比最小窗口还小）直接忽略，
//     等最后一次真实的 resize 再落位。
//   · 同一轮事件里的多次调用合并到下一帧只做一次（窗口尺寸以最后一次为准）。
let viewLayoutTimer = null;
function layoutGameView() {
  if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
  if (viewLayoutTimer) return;                       // 已经排了下一次，合并掉
  viewLayoutTimer = setTimeout(() => {
    viewLayoutTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
    try {
      const [w, h] = mainWindow.getContentSize();
      // 过渡中的异常尺寸：不跟随，等下一次
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
      const top = isFullscreenNow(mainWindow) ? 0 : PC_TB;
      const bw = Math.max(1, w);
      const bh = Math.max(1, h - top);
      const cur = (() => { try { return gameView.getBounds(); } catch (_) { return null; } })();
      if (cur && cur.x === 0 && cur.y === top && cur.width === bw && cur.height === bh) return;   // 没变就不动
      dbg('[view] layout', `${bw}x${bh}`, 'top', top, 'win', mainWindow.getBounds());
      gameView.setBounds({ x: 0, y: top, width: bw, height: bh });
    } catch (_) {}
  }, 0);
}

// 立刻按当前窗口尺寸落位（过渡结束后用来对齐到最终尺寸）
function flushGameViewLayout() {
  if (viewLayoutTimer) { clearTimeout(viewLayoutTimer); viewLayoutTimer = null; }
  if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
  try {
    const [w, h] = mainWindow.getContentSize();
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
    const top = isFullscreenNow(mainWindow) ? 0 : PC_TB;
    const bw = Math.max(1, w);
    const bh = Math.max(1, h - top);
    // 尺寸没变就别再 setBounds：重复设置会触发一次多余的布局/重绘，
    // 过渡动画里就是这类冗余重排让画面看起来「抖一下」。
    const cur = (() => { try { return gameView.getBounds(); } catch (_) { return null; } })();
    if (cur && cur.x === 0 && cur.y === top && cur.width === bw && cur.height === bh) return;
    gameView.setBounds({ x: 0, y: top, width: bw, height: bh });
    dbg('[view] flush', `${bw}x${bh}`, 'top', top, 'win', mainWindow.getBounds());
  } catch (_) {}
}

// ============ 最大化时的窗口区域（只为了多屏那条灰线） ============
// 窗口本身**不做任何圆角裁剪**：没有窗口区域的窗口才是普通矩形窗口，DWM 能直接
// 硬件直出（hardware overlay / Independent Flip）；一旦 SetWindowRgn，每帧都要多
// 经过一次整窗合成，改一次区域还要整窗重画，成本按窗口面积走。
//
// 这里唯一保留的裁剪是「最大化 / 全屏 + 多屏」：可缩放的无边框窗口最大化时，系统
// 会加一圈 8px 不可见的调整边框（副屏 720 宽的屏上，窗口矩形 -727,-7 736×1168，
// 客户区只有 -720,0 720×1152），边框会伸出屏幕、落到相邻显示器上，系统还在边框上
// 画 1px 线 —— 看起来就是窗口边缘挂一条浅灰竖线。单屏没有这个问题，什么都不做。
let lastShapeSig = '';

function setWindowShapeRects(win, rects) {
  const sig = rects.length + '|' + rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';');
  if (sig === lastShapeSig) return;
  lastShapeSig = sig;
  try { win.setShape(rects); } catch (_) {}
}

// 撤销区域，回到「没有区域」的矩形窗口（空列表 = 恢复矩形）
function clearWindowShape(win) {
  if (lastShapeSig === 'none') return;
  lastShapeSig = 'none';
  try { win.setShape([]); } catch (_) {}
}

function hasMultipleDisplays() {
  try { return screen.getAllDisplays().length > 1; } catch (_) { return true; }
}

// 最大化/全屏且多屏时，把窗口区域裁到客户区（去掉那圈 8px 调整边框伸到隔壁屏幕的灰线）。
// 单屏或非最大化/全屏时恢复矩形（无区域）。
function applyMaximizedClip() {
  if (process.platform !== 'win32') return;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    const maxed = win.isMaximized() || isFullscreenNow(win);
    if (!maxed || !hasMultipleDisplays()) { clearWindowShape(win); return; }

    const b = win.getBounds();
    const w = Math.max(1, Math.round(b.width));
    const h = Math.max(1, Math.round(b.height));

    // 用客户区而不是「显示器范围减窗口位置」来算：后者会因取整偏 1px，
    // 结果一边裁掉 1px 内容（顶部/左侧出现一条空白），另一边留下 1px 边框（灰线依旧）。
    const cb = (() => { try { return win.getContentBounds(); } catch (_) { return null; } })();
    if (cb && cb.width >= 1 && cb.height >= 1) {
      // Electron 45 已把 Windows 最大化客户区原点修正为真实偏移：例如副屏上
      // 窗口 x=-727、客户区 x=-720，正确区域起点就是 7。旧内核时代这里会额外
      // 减 1；继续沿用会得到 x=6，即全局范围 [-721,-1)，把最右一列裁掉，形成
      // 最大化与「保持最大化进入全屏」时右侧 1~2px 的缝隙。
      const offX = cb.x - b.x;
      const offY = cb.y - b.y;
      // 再夹一次，保证区域永远落在窗口矩形内、且不为 0
      const rx = Math.max(0, Math.min(w - 1, offX));
      const ry = Math.max(0, Math.min(h - 1, offY));
      const rw = Math.max(1, Math.min(cb.width, w - rx));
      const rh = Math.max(1, Math.min(cb.height, h - ry));
      setWindowShapeRects(win, [{ x: rx, y: ry, width: rw, height: rh }]);
      dbg('[shape] clip to content', { win: b, content: cb, region: { x: rx, y: ry, w: rw, h: rh } });
      return;
    }
    setWindowShapeRects(win, [{ x: 0, y: 0, width: w, height: h }]);
  } catch (_) {}
}

// ============ 设置持久化 ============
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  const defaults = {
    keepActive: true,    // 最小化/失焦时仍让游戏认为玩家在线（不结算离开）
    shinyEgg: true,      // 培育屋里提前把确定为异色的蛋标出来（只读存档）
  };
  try {
    if (fs.existsSync(settingsPath())) {
      const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
      // 老版本写进去的 noGlass / roundCorners 已经没有对应功能了，读的时候丢掉
      delete saved.noGlass;
      delete saved.roundCorners;
      return { ...defaults, ...saved };
    }
  } catch (_) {}
  return defaults;
}
function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (_) { return false; }
}

// 用户脚本目录
const scriptsDir = () => path.join(app.getPath('userData'), 'scripts');
const scriptsBackupDir = () => path.join(app.getPath('userData'), 'scripts-backups');
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

function ensureScriptsDir() {
  const dir = scriptsDir();
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function safeScriptName(name, { fallback = '', ensureExtension = false } = {}) {
  let out = path.basename(String(name || '')).replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '');
  if (!out || out === '.' || out === '..') out = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (ensureExtension && out && !/\.(user\.js|js)$/i.test(out)) out += '.user.js';
  return out;
}

function assertScriptContent(content) {
  const text = String(content == null ? '' : content);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) throw new Error('脚本内容为空');
  if (bytes > MAX_SCRIPT_BYTES) throw new Error(`脚本超过 ${MAX_SCRIPT_BYTES / 1024 / 1024} MB 限制`);
  return text;
}

// 更新前保留上一版；临时文件以点开头，不会被脚本注入器枚举执行。
async function writeScriptFile(name, content, { backup = true } = {}) {
  const safeName = safeScriptName(name);
  if (!safeName) throw new Error('脚本文件名无效');
  const text = assertScriptContent(content);
  const dir = ensureScriptsDir();
  const target = path.resolve(dir, safeName);
  if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('脚本路径越界');

  if (backup) {
    const backupDir = scriptsBackupDir();
    try {
      await fs.promises.access(target);
      await fs.promises.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.promises.copyFile(target, path.join(backupDir, `${safeName}.${stamp}.bak`));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }

  const temp = path.join(dir, `.${safeName}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.promises.rename(temp, target);
  } catch (err) {
    // Windows 上 rename 可能无法直接替换已存在的文件；已有备份时安全回退为覆盖复制。
    try { await fs.promises.access(target); }
    catch (_) { throw err; }
    await fs.promises.copyFile(temp, target);
    await fs.promises.unlink(temp);
  }
  await pruneScriptBackups(scriptsBackupDir(), safeName);
  return safeName;
}

// ============ 脚本元数据（来源 URL / 版本） ============
const metaPath = () => path.join(app.getPath('userData'), 'scripts-meta.json');
function loadScriptsMeta() {
  try {
    if (fs.existsSync(metaPath())) return JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
  } catch (_) {}
  return {};
}
function saveScriptsMeta(meta) {
  try {
    fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2), 'utf-8');
    return true;
  } catch (_) { return false; }
}

// 解析油猴脚本元数据块（@name / @version / @downloadURL / @updateURL / @description）
function parseUserscriptMeta(content) {
  const meta = {};
  const m = String(content || '').match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (m) {
    const block = m[1];
    const grab = (key) => {
      const re = new RegExp('@' + key + '\\s+(.+)');
      const mm = block.match(re);
      return mm ? mm[1].trim() : '';
    };
    meta.name = grab('name');
    meta.version = grab('version');
    meta.downloadURL = grab('downloadURL');
    meta.updateURL = grab('updateURL');
    meta.description = grab('description');
  }
  return meta;
}

// 下载 URL 内容（供脚本导入与更新检测）
// noCache：默认强制绕过 HTTP 缓存。GitHub 的 raw 地址带 `Cache-Control: max-age=300`
// （实测 gist raw 就是 300 秒），刚推上去的新版本会在 5 分钟内被浏览器缓存挡住，
// 表现出来就是「设置里点检查更新，永远说已是最新」；而重启后缓存过期，启动自检又能更新。
// 除了请求头，再挂一个时间戳参数，避免代理 / CDN 侧把旧响应直接返回。
// timeoutMs 默认 60s：脚本本体动辄 2MB，15s 在慢速线路上必然半路截断。
function fetchUrl(url, timeoutMs = 60000, opts = {}) {
  const noCache = opts.noCache !== false;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_SCRIPT_BYTES;
  return new Promise((resolve, reject) => {
    let target = String(url);
    if (!isSecureScriptUrl(target)) {
      reject(new Error('脚本链接必须使用 HTTPS'));
      return;
    }
    if (noCache && !/[?&]_pc=/.test(target)) {
      target += (target.includes('?') ? '&' : '?') + '_pc=' + Date.now().toString(36);
    }
    const request = net.request({ url: target, redirect: 'manual' });
    request.setHeader('User-Agent', 'Mozilla/5.0 PokeCatchLauncher/1.0');
    if (noCache) {
      request.setHeader('Cache-Control', 'no-cache');
      request.setHeader('Pragma', 'no-cache');
    }
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; request.abort(); reject(new Error('下载超时')); }
    }, timeoutMs);
    request.on('redirect', (_statusCode, _method, redirectUrl) => {
      if (settled) return;
      if (!isSecureScriptUrl(redirectUrl)) {
        settled = true;
        clearTimeout(timer);
        request.abort();
        reject(new Error('脚本下载被重定向到非 HTTPS 地址，已拒绝'));
        return;
      }
      request.followRedirect();
    });
    request.on('response', (response) => {
      const status = response.statusCode;
      if (status >= 400) {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('HTTP ' + status)); }
        return;
      }
      // 声明了 Content-Length 就按它校验：慢速线路下连接被掐断时，
      // 'end' 照样会触发、拿到的是半个脚本，写进脚本目录就是坏文件。
      // 注意 gzip / br 时 content-length 是压缩后的长度，和读到的字节数对不上，不能比。
      const enc = String(response.headers['content-encoding'] || '').toLowerCase();
      const declared = /^$|identity/.test(enc) ? Number(response.headers['content-length'] || 0) : 0;
      if (declared > maxBytes) {
        settled = true;
        clearTimeout(timer);
        request.abort();
        reject(new Error(`脚本超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`));
        return;
      }
      let received = 0;
      response.on('data', (c) => {
        if (settled) return;
        received += c.length;
        if (received > maxBytes) {
          settled = true;
          clearTimeout(timer);
          request.abort();
          reject(new Error(`脚本超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`));
          return;
        }
        chunks.push(c);
      });
      response.on('end', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          if (declared > 0 && buf.length !== declared) {
            reject(new Error(`下载不完整（${buf.length}/${declared} 字节）`));
            return;
          }
          resolve({ content: buf.toString('utf-8'), status });
        }
      });
      response.on('error', (e) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      });
    });
    request.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
    request.end();
  });
}

// ============ 单个脚本的「检查更新 / 应用更新」（设置页与启动自检共用） ============
// 更新来源优先级：scripts-meta.json 里记录的导入 URL → 脚本自身的 @downloadURL/@updateURL。
// 后者能让「从文件导入、但元数据里写了更新地址」的脚本也支持自动更新。
function scriptSourceUrl(name, content) {
  const meta = loadScriptsMeta();
  const saved = (meta[name] && meta[name].sourceUrl) || '';
  if (saved) return saved;
  const parsed = parseUserscriptMeta(content || '');
  return parsed.downloadURL || parsed.updateURL || '';
}

// 版本号比较：把 "1.29.20" 这类拆成数字段；非数字段退回字符串比较。
// 返回 >0 表示 a 比 b 新。
function compareVersion(a, b) {
  return compareVersions(a, b);
}

async function checkScriptUpdate(name, opts = {}) {
  // 手动点「检查更新」时必须绕过缓存（noCache 默认 true）；启动自检可以让缓存帮忙，
  // 免得每次开程序都重下一遍几 MB 的脚本。
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

    const localParsed = parseUserscriptMeta(localContent);
    const localVersion = localParsed.version || '';

    const { content: remoteContent } = await fetchUrl(sourceUrl, 90000, { noCache: !useCache });
    if (!remoteContent || !remoteContent.trim()) return { ok: false, error: '远端内容为空（可能被限流或链接失效）' };
    // 拿回来的是网页（登录页 / 404 / 限流页）就明确报错，别把 HTML 写进脚本目录。
    // 不用「必须含 ==UserScript==」这种硬判据：有些脚本会去掉元数据块，那样会误报。
    if (/^\s*</.test(remoteContent) || /<html[\s>]/i.test(remoteContent.slice(0, 3000))) {
      return { ok: false, error: '远端返回的是网页而不是脚本（链接可能失效或被拦截）' };
    }

    const remoteParsed = parseUserscriptMeta(remoteContent);
    const remoteVersion = remoteParsed.version || '';
    const sameContent = normalizeScript(remoteContent) === normalizeScript(localContent);

    let hasUpdate = false;
    let reason = '';
    if (localVersion && remoteVersion) {
      const cmp = compareVersion(remoteVersion, localVersion);
      if (cmp > 0) {
        hasUpdate = true;
        reason = `版本 ${localVersion} → ${remoteVersion}`;
      } else if (cmp < 0) {
        // 远端比本地旧（作者回滚 / gist 被改），不要去覆盖用户的文件
        hasUpdate = false;
        reason = `本地版本更新（${localVersion} > ${remoteVersion}）`;
      } else if (!sameContent) {
        // 版本号没动但内容变了：作者常常改完忘了改 @version，
        // 只比版本号就会永远「检测不到」。
        hasUpdate = true;
        reason = `版本号未变（${localVersion}），内容有变化`;
      } else {
        reason = `已是最新版本（${localVersion}）`;
      }
    } else {
      // 没有版本号的脚本只能比内容
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
    await writeScriptFile(safeName, content, { backup: true });
    const meta = loadScriptsMeta();
    // 元数据不存在时补一条：文件导入的脚本也可能带可用的更新地址
    if (!meta[safeName]) {
      const src = scriptSourceUrl(safeName, content);
      meta[safeName] = { sourceUrl: src || '', version: '', updatedAt: 0 };
    }
    meta[safeName].updatedAt = Date.now();
    const parsed = parseUserscriptMeta(content);
    if (parsed.version) meta[safeName].version = parsed.version;
    if (!meta[safeName].sourceUrl) {
      const src = parsed.downloadURL || parsed.updateURL || '';
      if (src) meta[safeName].sourceUrl = src;
    }
    saveScriptsMeta(meta);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ============ 脚本注入引擎（内置篡改猴） ============
// 内置脚本在应用生命周期内不会变化，缓存后避免每次刷新重复读盘。
const builtinScriptCache = new Map();

async function readBuiltinScript(filePath) {
  if (builtinScriptCache.has(filePath)) return builtinScriptCache.get(filePath);
  const code = await fs.promises.readFile(filePath, 'utf-8');
  builtinScriptCache.set(filePath, code);
  return code;
}

function executeInjectedScript(wc, code) {
  // 强制求值结果为 undefined：若用户脚本最后一个表达式恰好返回一个长驻 Promise，
  // Electron 就不会等待那个 Promise 才继续注入后续脚本。
  return wc.executeJavaScript(String(code) + '\n;void 0;');
}

async function injectScripts(wc) {
  if (!wc || wc.isDestroyed()) return;
  const builtinDir = path.join(__dirname, 'scripts');
  // 内置脚本，按顺序注入：设置（通用页里的启动器块）→ 异色蛋 → 优化。
  // 注意：这里**没有任何「改游戏布局」的脚本** —— 标题栏在窗口层、游戏在独立视图里，
  // 视口与浏览器一致，不需要补偿；审美偏好也别加在这里（想改外观请走用户脚本）。
  const builtinFiles = ['launcher-tab.user.js', 'shiny-egg.user.js', 'builtin-optimize.user.js'];
  for (const f of builtinFiles) {
    const fp = path.join(builtinDir, f);
    try {
      const code = await readBuiltinScript(fp);
      if (wc.isDestroyed()) return;
      await executeInjectedScript(wc, code);
    } catch (err) {
      console.error('[scripts] 内置脚本注入失败', f, err && err.message ? err.message : err);
    }
  }
  // 用户自定义脚本
  try {
    const entries = await fs.promises.readdir(ensureScriptsDir(), { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && isJavaScriptFilename(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    for (const f of files) {
      const code = await fs.promises.readFile(path.join(scriptsDir(), f), 'utf-8');
      if (wc.isDestroyed()) return;
      try { await executeInjectedScript(wc, code); }
      catch (err) { console.error('[scripts] 用户脚本注入失败', f, err && err.message ? err.message : err); }
    }
  } catch (err) {
    console.error('[scripts] 枚举用户脚本失败', err && err.message ? err.message : err);
  }
}

// ============ 滚动条外观：把游戏自己那套样式铺到「它没写样式的容器」上 ============
// 游戏只给 html / .timeline / .mp-pk / .side / .ev-board / .cr-pks / .mk-pc 写了
// ::-webkit-scrollbar；其余可滚容器（.modal、.modal>.modal-body、
// .evt-pick>#evt-pc、.raid-scroll、.ug-rk-grid、.gd-page …）只有 overflow，
// 于是用 Chromium 的原生滚动条 —— 形状、配色都跟游戏不一致。
//
// 这些容器**逐个列出来，不要写 `*::-webkit-scrollbar`**：
//   · 通配符会把规则放进「通用失效集」，页面里任何一次 class / 属性变更都会让整篇
//     文档重算一遍样式。这游戏是 DOM 密集型：战斗页一帧动几十上百个节点，开一次面板
//     要插入上千个节点 —— 实测同一界面 94fps → 120fps，点按钮时的顿感也来自这里。
//   · 逐个列的时候 Chromium 用选择器索引命中，只有真正命中的容器才付代价。
//     实测「插入 300 节点并强制样式+布局」：通配符 4.4ms / 清单 3.8ms（无皮肤 3.8ms）。
//   · 分成 6 条「选择器列表」规则而不是 39×6 条，规则总数更少。
//
// 清单来源：游戏 app.css 里所有 overflow:auto|scroll 的容器，**剔除游戏自己写过
// ::-webkit-scrollbar 的那几个**（html / .timeline / .mp-pk / .side / .ev-board /
// .cr-pks / .mk-pc）。原因：insertCSS 插在游戏样式表之后，
// `.side::-webkit-scrollbar` 与 `.side, .modal::-webkit-scrollbar` 的 specificity 同为
// (0,1,0)，同分时后插入的胜出 —— 列进去反而会把游戏自己的 8px 滚动条改粗成 10px。
// 颜色取游戏的 --line / --bg / --line-hover，所以切换主题时滚动条自动跟着换。
//
// 另外**不写** scrollbar-width / scrollbar-color —— 一旦写了标准属性，
// Chromium 会忽略 ::-webkit-scrollbar，样式反而失效。
const SCROLLBAR_CONTAINERS = [
  '.modal',
  '.modal > .modal-body',
  '.news-list',
  '.rg-bar',
  '.news-feed',
  '#screen-adventure .zone-scroll',
  '.badge-stats .bs-body',
  '.tc-locks',
  '.pg-regions',
  '.evt-pick',
  '.evt-pick > #evt-pc',
  '.rp-pks',
  '.dexcard-modal .modal-body',
  '.title-fx',
  '.ot-grid',
  '.ot-dr-list',
  '.adm-pl',
  '.adm-pg-wrap',
  '.adm-pick',
  '.adm-take',
  '.hb-scroll',
  '.mvd-road',
  '.pg-narrow .pg-info',
  '.rc-board',
  '.wb-rc-body',
  '.raid-scroll',
  '.cs-shop',
  '.ug-back .modal-body',
  '.ug-rk-grid',
  '.gd-nav',
  '.gd-page',
  '.gd-modal.narrow .gd-nav',
];

const SCROLLBAR_SKIN_CSS = (() => {
  const sel = (suffix) => SCROLLBAR_CONTAINERS.map((s) => `${s}${suffix}`).join(',\n');
  return `
${sel('::-webkit-scrollbar')} { width: 10px; height: 10px; }
${sel('::-webkit-scrollbar-track')} { background: var(--bg, #141826); }
${sel('::-webkit-scrollbar-thumb')} {
  background: var(--line, #333a52);
  border-radius: 10px;
  border: 2px solid var(--bg, #141826);
}
${sel('::-webkit-scrollbar-thumb:hover')} { background: var(--line-hover, var(--line, #333a52)); }
${sel('::-webkit-scrollbar-button')} { display: none; }
${sel('::-webkit-scrollbar-corner')} { background: var(--bg, #141826); }
`;
})();

// 每个文档插一次（导航后是新文档，需要重插）。key 记在 WeakMap 里，
// 同一文档重复调用时只保留一份，避免样式叠加。
const scrollbarSkinKeys = new WeakMap();
async function applyScrollbarSkin(wc) {
  if (!wc) return;
  // PC_NO_SKIN=1：不注入滚动条皮肤，用来 A/B 对比「某个滚动条到底是不是它带来的」
  if (process.env.PC_NO_SKIN === '1') return;
  try {
    const existed = scrollbarSkinKeys.get(wc);
    if (existed) {
      try { await wc.removeInsertedCSS(existed); } catch (_) {}
      scrollbarSkinKeys.delete(wc);
    }
    const key = await wc.insertCSS(SCROLLBAR_SKIN_CSS);
    if (key) scrollbarSkinKeys.set(wc, key);
    dbg('[skin] scrollbar css inserted', key || '(no key)');
  } catch (e) {
    dbg('[skin] scrollbar css failed', String(e && e.message));
  }
}

// 游戏界面固定使用深色主题（不再提供切换）
//
// 顺带把根元素的 color-scheme 也设成 dark。原因：
//   游戏的深色主题只给几个「舞台」元素（.evo-stage / .bf-stage / .raid-hero …）
//   写了 color-scheme: dark，:root 上只有 :root[data-theme=light]{color-scheme:light}。
//   我们又把 data-theme 去掉了，于是根元素的 color-scheme 退回 normal（= 浅色），
//   原生 UI 部件（下拉、表单控件、以及没被上面 SCROLLBAR_SKIN_CSS 覆盖的滚动条）
//   都会按浅色渲染。实测同一元素：normal 时滚动条亮度 241，dark 时 66。
//   只改根元素的 UA 配色提示，不动游戏的任何文件与布局；
//   游戏自己声明了 color-scheme 的元素仍然按它自己的来。
function applyThemeToGame(wc) {
  if (!wc) return;
  const code = `
    (function () {
      try {
        var h = document.documentElement;
        if (h) h.removeAttribute('data-theme');
        if (window.Theme && typeof window.Theme.set === 'function') {
          window.Theme.set('dark');
        }
        // 让原生 UI 部件（滚动条 / 下拉 / 表单控件）跟着深色主题走
        if (h) h.style.setProperty('color-scheme', 'dark');
        return h ? getComputedStyle(h).colorScheme : null;
      } catch (e) { return 'err:' + e; }
    })();
  `;
  wc.executeJavaScript(code).then((scheme) => dbg('[theme] color-scheme =', scheme)).catch(() => {});
  applyScrollbarSkin(wc);
}

// ============ 帧率计（PC_FPS=1 时注入） ============
// 排查「点按钮卡一下 / 战斗掉帧」用：左下角显示最近半秒的平均 fps 和最坏单帧耗时。
// 只在环境变量 PC_FPS=1 时进页面，正常启动完全不碰 DOM。
function installFpsMeter(wc) {
  if (!wc || process.env.PC_FPS !== '1') return;
  const code = `
    (function () {
      if (window.__pcFpsMeter) return true;
      window.__pcFpsMeter = true;
      var el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;'
        + 'font:12px/1.4 ui-monospace,Consolas,monospace;color:#9fe6a0;background:#05070ccc;'
        + 'border:1px solid #333a52;border-radius:6px;padding:2px 6px;pointer-events:none;white-space:pre';
      el.textContent = 'fps --';
      (document.body || document.documentElement).appendChild(el);
      var frames = 0, worst = 0, start = performance.now(), last = start;
      function tick(now) {
        frames++;
        var dt = now - last; last = now;
        if (dt > worst) worst = dt;
        if (now - start >= 500) {
          var fps = Math.round(frames * 1000 / (now - start));
          el.textContent = 'fps ' + fps + '   worst ' + Math.round(worst) + 'ms';
          el.style.color = fps >= 55 ? '#9fe6a0' : (fps >= 40 ? '#ffd23f' : '#ff7b72');
          frames = 0; worst = 0; start = now;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      return true;
    })();
  `;
  wc.executeJavaScript(code).catch(() => {});
}

// ============ 最小化 / 遮挡时保持「在线」 ============
// 游戏用 document.hidden + visibilitychange 判断玩家是否在场：窗口一最小化，
// Chromium 就把它标成 hidden，游戏随即停止主循环并在恢复时结算「离开期间的进度」。
//
// 这里在页面里把可见性伪装成永远 visible，并吞掉由窗口最小化引发的
// visibilitychange，游戏就会当成玩家一直在线。开关即时生效（无需重启）。
function applyKeepActive(wc, settings) {
  if (!wc) return;
  const on = (settings || loadSettings()).keepActive !== false;
  try {
    // false = 不允许 Chromium 在后台降频；用户关闭功能时恢复默认节流。
    wc.setBackgroundThrottling(!on);
    dbg('[background] keepActive=' + on, 'throttling=' + wc.getBackgroundThrottling());
  } catch (_) {}
  const code = `
    (function () {
      var WANT = ${on ? 'true' : 'false'};
      var P = window.__pcKeepAwake;
      if (!P) P = window.__pcKeepAwake = { on: false, saved: null, handler: null };

      function install() {
        if (P.on) return;
        try {
          var D = Document.prototype;
          P.saved = {
            hidden: Object.getOwnPropertyDescriptor(D, 'hidden'),
            visibilityState: Object.getOwnPropertyDescriptor(D, 'visibilityState'),
            webkitHidden: Object.getOwnPropertyDescriptor(D, 'webkitHidden'),
            webkitVisibilityState: Object.getOwnPropertyDescriptor(D, 'webkitVisibilityState')
          };
          Object.defineProperty(D, 'hidden', { configurable: true, get: function () { return false; } });
          Object.defineProperty(D, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
          if (P.saved.webkitHidden) Object.defineProperty(D, 'webkitHidden', { configurable: true, get: function () { return false; } });
          if (P.saved.webkitVisibilityState) Object.defineProperty(D, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });
          // 在 window 上捕获阶段截断，document 上的监听器收不到该事件
          P.handler = function (e) { e.stopImmediatePropagation(); };
          window.addEventListener('visibilitychange', P.handler, true);
          document.addEventListener('visibilitychange', P.handler, true);
          P.on = true;
        } catch (e) {}
      }

      function uninstall() {
        if (!P.on) return;
        try {
          var D = Document.prototype;
          ['hidden', 'visibilityState', 'webkitHidden', 'webkitVisibilityState'].forEach(function (k) {
            if (P.saved && P.saved[k]) {
              try { Object.defineProperty(D, k, P.saved[k]); } catch (e) {}
            }
          });
          if (P.handler) {
            window.removeEventListener('visibilitychange', P.handler, true);
            document.removeEventListener('visibilitychange', P.handler, true);
          }
        } catch (e) {}
        P.on = false;
      }

      if (WANT) install(); else uninstall();
      return { keepActive: P.on, hidden: document.hidden };
    })()
  `;
  wc.executeJavaScript(code).catch(() => {});
}

// ============ 窗口标题栏控制（自绘标题栏 IPC） ============
function windowAction(win, action) {
  if (!win || win.isDestroyed()) return;
  switch (action) {
    case 'minimize': win.minimize(); break;
    case 'maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'close': win.close(); break;
  }
}

// ============ 全屏（自绘无边框全屏） ============
// 为什么不用 win.setFullScreen(true)：
//   Windows 上让无边框窗口进入原生全屏时，几何由系统接管，而 Chromium 给出的全屏尺寸
//   是按「主显示器 / 创建时的缩放比」算的。窗口被拖到副屏后（尤其两块屏缩放比不同，
//   比如主屏 125%、副屏 100%）再按 F11，全屏后仍是主屏的分辨率，
//   于是比副屏还大，右边和下边直接探出屏幕外。
//   而且在原生全屏态下 setBounds 校正、退出再进、setResizable 抖动都会被系统忽略。
// 所以这里自己做无边框全屏：
//   1. 记住进入前的「还原态」bounds 和是否最大化；
//   2. 把窗口铺到「窗口当前所在显示器」的完整 bounds（含任务栏那一条，不是 workArea）；
//   3. 临时置顶（screen-saver 层），任务栏就不会盖在游戏上面 —— 视觉与原生全屏一致；
//      失焦时自动撤销置顶，不会挡住别的程序；
//   4. 退出时原样还原（位置 / 大小 / 最大化状态）。
let fsState = null;   // 非空 = 当前处于自绘全屏，值为进入前的窗口状态

function isFullscreenNow(win) {
  if (!win || win.isDestroyed()) return false;
  return !!fsState || win.isFullScreen();
}

// 窗口当前所在显示器的完整区域（DIP，与 setBounds 同一坐标系）
function fullscreenTargetBounds(win) {
  let d = null;
  try { d = screen.getDisplayMatching(win.getBounds()); } catch (_) {}
  if (!d) { try { d = screen.getPrimaryDisplay(); } catch (_) {} }
  const b = (d && d.bounds) || { x: 0, y: 0, width: 1280, height: 720 };
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

// 全屏时的层级管理。
//
// screen-saver 级置顶可以让任务栏 / 普通窗口都盖不上游戏，但只有「窗口保持置顶状态」
// 时才成立。之前为了让别的窗口能显示，我们在 blur（点到窗口外面）时把置顶撤掉了，
// 结果点一下任务栏或其它置顶窗口，它就直接盖在全屏游戏上 —— 就是「点外面会冒出来」。
//
// 现在的策略：
//   · 全屏期间始终保持 screen-saver 级置顶；
//   · 失焦（点到外面）时再 moveTop() 抬一次 —— 不抢键盘焦点，但维持在其它窗口之上；
//   · 只有确实需要给别的窗口让位时（打开系统浏览器登录、弹出登录窗）才临时撤销，
//     撤销时置 fsTopmostSuspended，看门狗不会把它顶回去；窗口重新获得焦点后恢复。
let fsTopmostSuspended = false;
let fsTopmostTimer = null;

function stopFsTopmostWatch() {
  if (fsTopmostTimer) { clearInterval(fsTopmostTimer); fsTopmostTimer = null; }
}

function startFsTopmostWatch(win) {
  stopFsTopmostWatch();
  fsTopmostTimer = setInterval(() => {
    if (!fsState || fsTopmostSuspended || !win || win.isDestroyed()) { stopFsTopmostWatch(); return; }
    try {
      // 只纠正「置顶被系统/别处掉了」的情况，不主动抢焦点
      if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
    } catch (_) { stopFsTopmostWatch(); }
  }, 1000);
  if (fsTopmostTimer && typeof fsTopmostTimer.unref === 'function') fsTopmostTimer.unref();
}

function setFullscreenTopmost(win, on, opts) {
  if (!win || win.isDestroyed()) return;
  fsTopmostSuspended = !on;
  try { win.setAlwaysOnTop(!!on, 'screen-saver'); } catch (_) {}
  if (on) {
    if (opts && opts.raise) { try { win.moveTop(); } catch (_) {} }
    startFsTopmostWatch(win);
  } else {
    stopFsTopmostWatch();
  }
}

// ============ 尺寸下限 ============
// 只做「用户能缩到多小」的限制，不再跟着显示器/拖动自动改窗口尺寸：
// 用户把窗口拖到哪块屏、多大，就是多大，启动器不去动它。
const MIN_W = 615;
const MIN_H = 480;          // 游戏可用高度（不含自绘标题栏）
// 自绘标题栏占用的高度，必须与 scripts/titlebar-inject.user.js 里的 --pc-tb 一致。
// 窗口高度 = 游戏可用高度 + PC_TB，否则游戏会少掉这 36px（底部内容被裁 / 侧栏多出滚动）。
const PC_TB = 36;

function enterFullscreen(win) {
  if (!win || win.isDestroyed() || isFullscreenNow(win)) return;
  const target = fullscreenTargetBounds(win);

  // 窗口创建时带了 minWidth/minHeight（960×600），Windows 会在 WM_GETMINMAXINFO
  // 里把它当成「最小跟踪尺寸」强制执行：setBounds 小于这个值时会被直接顶回去。
  // 副屏是竖屏 720 宽，全屏要 720 宽 → 被撑成 960 宽 → 右边 240px 探出屏幕外。
  // 所以进全屏前先放开尺寸下限，退出时按所在显示器重新算（见 exitFullscreen）。
  fsState = {
    // 原样记住进入前的几何，退出时原样还原（不做任何「收敛到屏幕」的改写）。
    bounds: (() => { try { return win.getNormalBounds(); } catch (_) { return null; } })(),
    maximized: win.isMaximized(),
    keptMaximized: false,
  };

  // ── 关键：最大化 ⇄ 全屏 在「没有任务栏的屏幕」上根本不需要动窗口几何 ──
  // 没有任务栏时（副屏/全屏工作区），Windows 的最大化矩形本来就铺满整块屏
  // （实测副屏 bounds 720×1152，最大化矩形 -728,-8 736×1168，比屏幕还大 8px，
  // 那 8px 是不可见的调整边框）。此时若照常 unmaximize()，会先恢复成 normal
  // 尺寸（比如 1440×936，在 720 宽的副屏上直接超出屏幕），再跳到全屏目标 ——
  // 就是「短暂缩小/超出屏幕再变回来」。
  // 所以这种情况直接留在最大化状态进全屏：几何零变化，视觉上只有标题栏消失。
  const disp = (() => { try { return screen.getDisplayMatching(win.getBounds()); } catch (_) { return null; } })();
  const noTaskbar = !!disp && disp.workArea.x === disp.bounds.x && disp.workArea.y === disp.bounds.y
    && disp.workArea.width === disp.bounds.width && disp.workArea.height === disp.bounds.height;
  if (win.isMaximized() && noTaskbar) {
    fsState.keptMaximized = true;
    dbg('[fs] enter fullscreen while maximized on a taskbar-less display → keep geometry', disp.bounds);
    try { win.setMinimumSize(1, 1); } catch (_) {}
    flushGameViewLayout();
    setShellFullscreen(true);
    setFullscreenTopmost(win, true);
    applyMaximizedClip(win);   // 几何零变化，直接按当前状态裁剪（避免灰线闪一下）
    setTimeout(() => { if (fsState) flushGameViewLayout(); }, 120);
    notifyMaximizeState(win);
    return;
  }

  // 有任务栏的屏（或非最大化）：先放开最小尺寸下限，再铺到全屏 bounds（盖住任务栏）。
  if (win.isMaximized()) {
    try { win.setMinimumSize(1, 1); } catch (_) {}
    try { win.unmaximize(); } catch (_) {}
  }
  try { win.setMinimumSize(1, 1); } catch (_) {}
  try { win.setBounds(target); } catch (_) {}
  // 全屏：先把游戏视图立刻铺满整个窗口，再藏标题栏 ——
  // 顺序反了会露出一帧「标题栏已隐藏、视图还没长上去」的 36px 空白（看起来就是闪一下）。
  flushGameViewLayout();
  setShellFullscreen(true);
  setFullscreenTopmost(win, true);
  // 跨 DPI 时第一次 setBounds 可能按旧缩放比换算，下一帧再对齐一次
  setTimeout(() => {
    if (!fsState || !win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (b.x !== target.x || b.y !== target.y || b.width !== target.width || b.height !== target.height) {
      try { win.setBounds(target); } catch (_) {}
    }
    flushGameViewLayout();
    applyMaximizedClip();
  }, 120);
  notifyMaximizeState(win);
}

function exitFullscreen(win) {
  if (!win || win.isDestroyed() || !isFullscreenNow(win)) return;
  const st = fsState;
  fsState = null;
  setFullscreenTopmost(win, false);
  if (win.isFullScreen()) { try { win.setFullScreen(false); } catch (_) {} }
  if (st) {
    // 顺序很关键：先把尺寸下限恢复成正常值，再还原几何。
    // 反过来的话（先 setBounds 再 setMinimumSize），Windows 会在下限被放开成 1×1
    // 的那一帧里按「当前窗口」记录跟踪尺寸，随后恢复下限时又把宽高顶一下。
    try { win.setMinimumSize(MIN_W, MIN_H + PC_TB); } catch (_) {}

    // 还原目标（上界为下限）：否则窗口的 normal 区域还停在全屏尺寸上，
    // 下次最大化/还原、以及写进 window-state.json 的都会是满屏大小。
    const normalTarget = st.bounds ? {
      x: Math.round(st.bounds.x),
      y: Math.round(st.bounds.y),
      width: Math.max(MIN_W, Math.round(st.bounds.width)),
      height: Math.max(MIN_H + PC_TB, Math.round(st.bounds.height)),
    } : null;

    // 退出全屏的收尾顺序：先把标题栏画出来，再让视图缩回 36px 处（下一帧）。
    // 标题栏先画好，随后几何动画开始，不会闪出「视图缩回但标题栏没画」的暗条。
    setShellFullscreen(false);

    if (st.keptMaximized) {
      // 进全屏时压根没动几何（最大化矩形本来就铺满这块无任务栏的屏）：
      // 退出只需还原标题栏，窗口保持最大化，零尺寸跳变。
      dbg('[fs] exit fullscreen keeping maximized geometry');
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(win); }, 260);
      notifyMaximizeState(win);
    } else if (st.maximized) {
      // 退出全屏回到「最大化」：先落位到还原态，再走系统最大化。
      try {
        if (normalTarget) win.setBounds(normalTarget);
        win.maximize();
        dbg('[fs] restore maximized', win.getBounds(), 'isMax', win.isMaximized());
      } catch (_) {}
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(win); }, 260);
      notifyMaximizeState(win);
    } else if (normalTarget) {
      // 退出全屏回到 normal：直接落位到进入前的还原矩形。
      try { win.setBounds(normalTarget); } catch (_) {}
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(win); }, 260);
      notifyMaximizeState(win);
      saveWindowStateSoon();
    } else {
      setShellFullscreen(false);
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(win); }, 260);
      notifyMaximizeState(win);
    }
  }
}

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  if (isFullscreenNow(win)) exitFullscreen(win);
  else enterFullscreen(win);
}

// 全屏时把窗口层标题栏藏起来（游戏视图此时已经铺满整个窗口）。
// 标题栏现在是独立页面（assets/shell.html），改它的 class 即可，不碰游戏页面。
function setShellFullscreen(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const code = `(function () {
    var h = document.documentElement;
    if (!h) return false;
    h.classList.toggle('fs', ${on ? 'true' : 'false'});
    return true;
  })()`;
  try { mainWindow.webContents.executeJavaScript(code).catch(() => {}); } catch (_) {}
}

// 通知窗口最大化状态变化（用于标题栏图标切换）
function notifyMaximizeState(win) {
  if (!win || win.isDestroyed()) return;
  const isMax = win.isMaximized() || isFullscreenNow(win);
  try { win.webContents.send('window-maximized', isMax); } catch (_) {}
}

// 窗口键盘：F11 全屏 / F12 设置 / Esc 退出全屏。
// 监听挂在**两个** webContents 上：游戏视图（主用）和窗口层标题栏（焦点偶尔会落在它上面，
// 例如刚启动、或点了标题栏之后）。两处共用同一个处理函数，不会重复触发。
// 不用 globalShortcut：那是全局热键，所有程序都会抢，这里只要本窗口响应。
function handleWindowKey(event, input) {
  if (input.type !== 'keyDown') return;
  if (input.key === 'F11') {
    event.preventDefault();
    toggleFullscreen(mainWindow);
  } else if (input.key === 'F12') {
    event.preventDefault();
    // 设置已经并入游戏面板：F12 打开并切到「通用」里的启动器分区，再按一次收起
    toggleLauncherSettings();
  } else if (input.key === 'Escape' && isFullscreenNow(mainWindow)) {
    event.preventDefault();
    exitFullscreen(mainWindow);
  }
}

// 窗口键盘：F11 全屏 / F12 设置 —— 仅当窗口有焦点时触发（由渲染层转发）


// ============ 启动 splash（独立窗口） ============
// 为什么 splash 必须是独立窗口，而不是「主窗口先显示本地页、再 loadURL 游戏」：
//
//   Chromium 只在窗口的「第一次导航」时，把页面的 -webkit-app-region
//   draggable regions 登记到窗口上。如果先 loadFile(splash.html) 让窗口显示，
//   之后再 loadURL(游戏)，新页面的 draggable regions 永远不会被登记。
//
//   实测证据：此时对 HWND 发 WM_NCHITTEST，标题栏、品牌区、按钮区、正文
//   一律返回 HTCLIENT（整窗没有任何拖拽区），标题栏画得再对也拖不动。
//   并且以下手段全部无法强制重登记：
//     hide/show、setResizable 切换、1px setBounds 抖动、宽度 ±60 抖动、
//     zoom 抖动、webContents.invalidate()、整页 reload。
//
//   唯一可靠的解法：主窗口的第一次导航必须是游戏页，加载动画交给独立窗口。
//   这样 draggable regions 正常登记，拖动回到纯原生实现（系统 modal move
//   loop，60fps、支持贴边分屏、绝不改变窗口尺寸）。
let splashWindow = null;
let splashShownAt = 0;   // 加载动画真正显示的起始时刻（调动画节奏时对照用）
let restoreMaximized = false;   // 上次退出时是否处于最大化，启动后需要还原

function createSplashWindow(bounds) {
  splashWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    show: false,
    // 透明窗口：加载页只有一个环绕球心左右摇晃的精灵球（不位移），其余区域完全透出桌面/其它窗口。
    // 注意：transparent 窗口必须是 resizable:false，否则 Windows 上会退化成不透明。
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });

  // 透明区域不接收鼠标：点击直接落到下面的窗口，不会挡住桌面操作
  splashWindow.setIgnoreMouseEvents(true);

  splashWindow.loadFile(path.join(__dirname, 'assets', 'splash.html'));
  // 透明窗口上 ready-to-show 偶尔不触发，用 did-finish-load 兜底 show
  let shown = false;
  const showSplash = () => {
    if (shown) return;
    if (!splashWindow || splashWindow.isDestroyed()) return;
    shown = true;
    splashShownAt = Date.now();
    splashWindow.show();
    splashWindow.focus();
  };
  splashWindow.once('ready-to-show', showSplash);
  splashWindow.webContents.once('did-finish-load', showSplash);
  splashWindow.on('closed', () => { splashWindow = null; });
}

// 淡出后销毁（透明窗口没有底色，直接 destroy 会有「球突然消失」的跳变）
function closeSplashWindow(fadeMs) {
  if (!splashWindow || splashWindow.isDestroyed()) { splashWindow = null; return; }
  const win = splashWindow;
  splashWindow = null;
  const steps = 12;
  const dur = fadeMs === undefined ? 240 : fadeMs;
  if (!dur) { try { win.destroy(); } catch (_) {} return; }
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (win.isDestroyed()) { clearInterval(timer); return; }
    try { win.setOpacity(Math.max(0, 1 - i / steps)); } catch (_) {}
    if (i >= steps) {
      clearInterval(timer);
      try { win.destroy(); } catch (_) {}
    }
  }, dur / steps);
}

// ============ 窗口位置/状态记忆 ============
// 退出时把「还原状态下（非最大化）的几何 + 是否最大化」写进 userData/window-state.json，
// 下次启动原样还原。Electron 的 bounds 是 DIP 坐标，跨 DPI 显示器由 Chromium 换算。
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf-8'));
    if (!s || typeof s !== 'object') return null;
    const maximized = s.maximized === true;
    const b = s.bounds;
    if (!b || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]))) {
      return { bounds: null, maximized };
    }
    if (b.width < 400 || b.height < 300) return { bounds: null, maximized };
    return {
      bounds: {
        x: Math.round(b.x), y: Math.round(b.y),
        width: Math.round(b.width), height: Math.round(b.height) + PC_TB,
      },
      maximized,
    };
  } catch (_) {
    return null;   // 首次启动或文件损坏，走默认几何
  }
}

// 位置必须还能在某块显示器上露出来（拔掉外接屏、改分辨率后可能整窗跑到屏幕外）
function isBoundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ox = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const oy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return ox >= 160 && oy >= 100;
  });
}

let stateSaveTimer = null;

function saveWindowStateNow() {
  if (stateSaveTimer) { clearTimeout(stateSaveTimer); stateSaveTimer = null; }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // 最大化时 getBounds 返回的是最大化后的尺寸，必须用「还原态」记住正常大小；
    // 自绘全屏时取进入全屏前记下的 bounds。
    const st = fsState;
    const b = (st && st.bounds) ? st.bounds
      : (() => { try { return mainWindow.getNormalBounds(); } catch (_) { return null; } })();
    if (!b || b.width < 400 || b.height < 300) return;
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify({
      // height 存的是「游戏可用高度」（窗口高度 - 标题栏），换版本也不会越开越高
      bounds: { x: b.x, y: b.y, width: b.width, height: Math.max(MIN_H, b.height - PC_TB) },
      maximized: st ? !!st.maximized : mainWindow.isMaximized(),
    }, null, 2), 'utf-8');
  } catch (_) {}
}

// 拖动/改尺寸时防抖保存：这样即使进程被强杀，下次也能恢复到最近的位置
function saveWindowStateSoon() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(saveWindowStateNow, 400);
}

// 临时调试日志（PC_DEBUG=1 时写入临时目录）。批量异步写，避免调试窗口动画时
// appendFileSync 反过来制造卡顿、污染性能数据。
let debugLogBuffer = [];
let debugLogTimer = null;

function flushDebugLog() {
  debugLogTimer = null;
  if (debugLogBuffer.length === 0) return;
  const chunk = debugLogBuffer.join('');
  debugLogBuffer = [];
  fs.promises.appendFile(path.join(require('os').tmpdir(), 'pc-debug.log'), chunk, 'utf8')
    .catch((err) => console.error('[debug-log] 写入失败', err && err.message ? err.message : err));
}

function dbg(...args) {
  if (process.env.PC_DEBUG !== '1') return;
  try {
    debugLogBuffer.push(new Date().toISOString() + ' '
      + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
    if (!debugLogTimer) debugLogTimer = setTimeout(flushDebugLog, 100);
  } catch (_) {}
}

// ============ 外链 / 登录跳转策略 ============
// 这个游戏的登录是 Supabase OAuth（signInWithOAuth，默认 skipBrowserRedirect=false）：
// 它直接在**当前窗口**跳走 —— 游戏页 → https://<项目>.supabase.co/auth/v1/authorize → Google/Discord
// → supabase /auth/v1/callback → 跳回游戏页。整条链路都必须在窗口内完成，
// 一旦被当成外链丢给系统浏览器，登录状态就回不来（浏览器里登录的是另一个会话）。
// 同时 window.open 出来的登录弹窗也要留在应用内并保留 window.opener（备用路径）。
const GAME_HOSTS = ['pokecatch-online.netlify.app', 'pokecatch-online.pages.dev'];
// 登录提供方（跳转式登录的各跳都在这几家之间转）
const AUTH_PROVIDER_HOSTS = [
  'accounts.google.com', 'accounts.youtube.com', 'accounts.google.cn',
  'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'discord.com', 'discordapp.com',
  'appleid.apple.com',
];
// 允许作为「应用内弹窗」打开的域
const POPUP_ALLOW_HOSTS = [
  ...GAME_HOSTS,
  ...AUTH_PROVIDER_HOSTS,
  'supabase.co', 'supabase.in',
  'firebaseapp.com', 'web.app',
];
// 允许在窗口内直接跳转的域（游戏自身 + Supabase 授权/回调 + Google 各跳）
const NAV_ALLOW_HOSTS = [
  ...GAME_HOSTS,
  ...AUTH_PROVIDER_HOSTS,
  'supabase.co', 'supabase.in',
  'firebaseapp.com', 'web.app',
];

// 登录流程状态：从「跳到授权页」开始计时，回到游戏页即结束
let authFlowUntil = 0;
const AUTH_FLOW_TTL = 5 * 60 * 1000;

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}
function hostAllowed(url, list) {
  // Firebase 常先开 about:blank 再改 location，空窗口必须放行，否则弹窗直接没了
  if (!url || url === 'about:blank') return true;
  const h = hostOf(url);
  if (!h) return false;
  return list.some((a) => h === a || h.endsWith('.' + a));
}
function isGameHost(h) {
  return GAME_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}
// OAuth 授权端点（Supabase: /auth/v1/authorize，其它: /oauth2/authorize 之类）
function isOAuthEndpoint(url) {
  try {
    const u = new URL(url);
    return /\/(auth\/v1\/authorize|oauth2?\/authorize|oauth\/authorize)/i.test(u.pathname);
  } catch (_) {
    return false;
  }
}

// 给一个窗口装上「弹窗/外链」策略：登录类弹窗留在应用内，其余外链丢系统浏览器
// 给游戏视图装上「弹窗/外链」策略：登录类弹窗留在应用内，其余外链丢系统浏览器
function attachOpenPolicy(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.setWindowOpenHandler(({ url }) => {
    // 登录授权页：不在应用内打开（谷歌会拒绝），改用系统浏览器
    if (isSupabaseAuthorizeUrl(url)) {
      startBrowserAuth(url);
      return { action: 'deny' };
    }
    if (hostAllowed(url, POPUP_ALLOW_HOSTS)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
          modal: false,
          show: true,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          title: '登录',
          webPreferences: {
            session: session.defaultSession,
            nodeIntegration: false,
            contextIsolation: true,
            // 刻意不挂 preload：第三方登录页不需要也不该拿到启动器 API
          },
        },
      };
    }
    if (isHttpUrl(url)) {
      try { shell.openExternal(url); } catch (_) {}
    }
    return { action: 'deny' };
  });

  // 弹窗里再弹出来的窗口（部分登录流会开二级窗）沿用同一套策略
  wc.on('did-create-window', (child) => {
    try { child.webContents.setUserAgent(CLEAN_UA); } catch (_) {}
    attachOpenPolicy(child.webContents);
    // 自绘全屏是 screen-saver 级置顶，先撤掉，免得登录窗被压在游戏下面
    if (fsState && mainWindow && !mainWindow.isDestroyed()) setFullscreenTopmost(mainWindow, false);
    try { child.focus(); } catch (_) {}
  });
}

// ============ 登录桥：OAuth 交给系统浏览器，登录结果回传给游戏页 ============
// 谷歌会按内核指纹把 Electron 判成「不安全的嵌入式浏览器」：实测同一台机器上 Edge 能正常进登录流程，
// 而 Electron 即使把 UA / Sec-CH-UA / navigator.userAgentData 全部伪装成一致的新版 Chrome，
// 提交账号后仍然被重定向到 /v3/signin/rejected。这类判定在 JS 层绕不过去，所以登录这一步改用系统浏览器：
//   1) 拦下游戏发起的 Supabase 授权跳转，把 redirect_to 换成 127.0.0.1 上的本地回调；
//   2) 用默认浏览器打开（多半已是登录态，点一下即可）；
//   3) 本地回调页把 #access_token / ?code 原样回传，主进程再把这段 URL 交给游戏页，
//      由 supabase-js 的 detectSessionInUrl 像正常登录一样接管，不用自己拼会话。
let authFlow = null;

const AUTH_CALLBACK_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<title>PokeCatch 登录</title><style>'
  + 'html,body{height:100%;margin:0}'
  + 'body{display:flex;align-items:center;justify-content:center;background:#141826;color:#e8eaf2;'
  + 'font:15px/1.6 "Segoe UI",system-ui,sans-serif}'
  + '.box{text-align:center;padding:26px 34px;border:1px solid #333a52;border-radius:12px;background:#1b2033;min-width:300px}'
  + 'h1{font-size:16px;margin:0 0 8px;font-weight:600}'
  + 'p{margin:0;color:#9aa3bd;font-size:13px}'
  + '.dot{width:9px;height:9px;border-radius:50%;background:#e3353b;display:inline-block;margin-right:7px;vertical-align:1px}'
  + '</style></head><body><div class="box"><h1><span class="dot"></span><span id="t">正在完成登录…</span></h1>'
  + '<p id="d">请稍候，完成后可以直接关闭此页面</p></div><script>'
  + '(function(){var raw=location.hash?location.hash.slice(1):location.search.slice(1);'
  + 'if(!raw){document.getElementById("t").textContent="没有收到登录结果";return;}'
  + 'fetch("/payload",{method:"POST",headers:{"content-type":"text/plain"},body:raw})'
  + '.then(function(){document.getElementById("t").textContent="登录成功";'
  + 'document.getElementById("d").textContent="已返回启动器，可以关闭此页面";'
  + 'setTimeout(function(){try{window.close();}catch(e){}},900);})'
  + '.catch(function(){document.getElementById("t").textContent="回传失败";'
  + 'document.getElementById("d").textContent="请回到启动器重试";});})();'
  + '</script></body></html>';

// 是不是 Supabase 的授权跳转（游戏点登录时整窗跳到这个地址）
function isSupabaseAuthorizeUrl(url) {
  if (!hostAllowed(url, ['supabase.co', 'supabase.in'])) return false;
  try {
    return /^\/auth\/v1\/authorize\b/i.test(new URL(url).pathname);
  } catch (_) {
    return false;
  }
}

// 借系统浏览器完成登录后，把回调参数交给游戏页
function closeAuthFlow() {
  if (!authFlow) return;
  const f = authFlow;
  authFlow = null;
  try { clearTimeout(f.timer); } catch (_) {}
  try { f.server.close(); } catch (_) {}
}

function finishBrowserAuth(raw) {
  if (!authFlow) return;
  const q = new URLSearchParams(raw || '');
  const token = q.get('access_token');
  const code = q.get('code');
  const err = q.get('error_description') || q.get('error');
  closeAuthFlow();

  if (token) { openGameWithAuth('#' + raw); return; }
  if (code) { openGameWithAuth('?' + raw); return; }

  let msg = err ? String(err).replace(/\+/g, ' ') : '没有收到登录凭据';
  if (/access_denied|denied/i.test(msg)) msg = '你在浏览器里取消了授权';
  authFailed(msg);
}

// 把带凭据的地址交给游戏页：supabase-js 会自己解析并写入会话
function openGameWithAuth(suffix) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = gameWC();
  if (!wc) return;
  const target = CONFIG.gameUrl + suffix;
  const go = () => {
    const cur = gameWC();
    if (!cur) return;
    try { cur.loadURL(target); } catch (_) {}
  };
  try {
    // 当前就停在游戏页时，只改 hash 属于「同文档跳转」，不会重新执行页面脚本，
    // supabase-js 也就不会去解析会话 —— 先过一帧空白页，再带凭据整页加载。
    if (wc.getURL().indexOf(CONFIG.gameUrl) === 0) {
      wc.loadURL('about:blank').then(go).catch(go);
    } else {
      go();
    }
  } catch (_) {
    go();
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch (_) {}
}

function authFailed(msg) {
  const opt = {
    type: 'warning',
    title: '登录未完成',
    message: '登录没有完成',
    detail: msg + '\n\n可以回到游戏再点一次登录按钮重试。',
    buttons: ['知道了'],
    noLink: true,
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, opt);
    else dialog.showMessageBox(opt);
  } catch (_) {}
}

// 起一个只监听 127.0.0.1 的一次性 HTTP 服务接登录回调
function startBrowserAuth(authorizeUrl) {
  if (!authorizeUrl) return;
  // 已经在等浏览器登录：把同一个链接再抛一次（浏览器会复用标签页），不重复起服务
  if (authFlow) {
    try { shell.openExternal(authFlow.url || authorizeUrl); } catch (_) {}
    return;
  }

  let target;
  try {
    target = new URL(authorizeUrl);
  } catch (_) {
    return;
  }

  const net = require('net');
  const probe = net.createServer();
  probe.once('error', () => { try { shell.openExternal(authorizeUrl); } catch (_) {} });
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => {
      const cbUrl = 'http://127.0.0.1:' + port + '/auth-cb';
      try { target.searchParams.set('redirect_to', cbUrl); } catch (_) {}

      const server = http.createServer((req, res) => {
        let pathname = '/';
        try { pathname = new URL(req.url, cbUrl).pathname; } catch (_) {}

        if (req.method === 'POST' && pathname === '/payload') {
          let body = '';
          req.on('data', (c) => {
            body += c;
            if (body.length > 65536) { try { req.destroy(); } catch (_) {} }
          });
          req.on('end', () => {
            try {
              res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
              res.end('ok');
            } catch (_) {}
            finishBrowserAuth(body);
          });
          return;
        }

        if (pathname === '/auth-cb') {
          try {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(AUTH_CALLBACK_HTML);
          } catch (_) {}
          return;
        }

        try {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
        } catch (_) {}
      });
      server.on('clientError', (err, sock) => { try { sock.destroy(); } catch (_) {} });

      server.once('error', () => {
        try { shell.openExternal(authorizeUrl); } catch (_) {}
      });

      server.listen(port, '127.0.0.1', () => {
        const finalUrl = target.toString();
        authFlow = {
          server,
          port,
          url: finalUrl,
          timer: setTimeout(() => {
            closeAuthFlow();
            authFailed('等待浏览器登录超时了');
          }, 5 * 60 * 1000),
        };
        try {
          // 自绘全屏是 screen-saver 级置顶，先撤掉，免得浏览器窗口被游戏压在下面看不见
          if (fsState && mainWindow && !mainWindow.isDestroyed()) setFullscreenTopmost(mainWindow, false);
          shell.openExternal(finalUrl);
          dbg('[auth] 已在系统浏览器打开登录页', finalUrl.slice(0, 80));
        } catch (_) {
          closeAuthFlow();
          authFailed('打不开系统浏览器');
        }
      });
    });
  });
}

// 主窗口的导航判定：登录链路一律留在窗口内，其余非游戏页丢系统浏览器
function shouldAllowNavigation(url) {
  const now = Date.now();
  const h = hostOf(url);

  // 回到游戏页 → 登录流程结束
  if (h && isGameHost(h)) { authFlowUntil = 0; return true; }

  const allowed = hostAllowed(url, NAV_ALLOW_HOSTS);
  if (allowed) {
    // 一旦真的跳到授权页（或 Supabase 的授权/回调），标记「登录进行中」，
    // 后续 provider 自己的登录页（Discord 的 /login、Google 的账号选择等）也放行
    if (isOAuthEndpoint(url) || h.endsWith('.supabase.co') || h.endsWith('.supabase.in')) {
      authFlowUntil = now + AUTH_FLOW_TTL;
    }
    return true;
  }

  // 登录进行中：各 provider 的域名都留在窗口内
  if (authFlowUntil > now && h && AUTH_PROVIDER_HOSTS.some((a) => h === a || h.endsWith('.' + a))) {
    return true;
  }

  return false;
}

// ============ 主窗口（无边框，第一次导航直接加载游戏） ============
function onMainWindowClose() {
  saveWindowStateNow();
}

function isGamePage() {
  const wc = gameWC();
  if (!wc) return false;
  try {
    const url = wc.getURL();
    return /pokecatch-online/.test(url);
  } catch (_) { return false; }
}

function createWindow() {
  // 主窗口与 splash 共用同一套几何参数，保证切换时严丝合缝、不闪边
  // 默认尺寸：游戏主界面是「正好一屏」的布局（冒险页 .adv-main 用 100vh 排版），
  // 窗口太小时它自己会撑出页面滚动。这里给一个更舒展的默认值，并留出 60px 边距。
  const { workArea } = screen.getPrimaryDisplay();
  const DEF_W = Math.max(MIN_W, Math.min(1440, workArea.width - 60));
  const DEF_H = Math.max(MIN_H + PC_TB, Math.min(900 + PC_TB, workArea.height - 60));
  const DEF_X = Math.round(workArea.x + (workArea.width - DEF_W) / 2);
  const DEF_Y = Math.round(workArea.y + (workArea.height - DEF_H) / 2);

  // 还原上次的几何与最大化状态；没有记录 / 记录点已不在任何屏幕上则回落到默认居中
  const savedState = readWindowState();
  const savedBounds = savedState && isBoundsVisible(savedState.bounds) ? savedState.bounds : null;
  restoreMaximized = !!(savedState && savedState.maximized);
  const targetArea = (savedBounds ? screen.getDisplayMatching(savedBounds) : screen.getPrimaryDisplay()).workArea;

  let W = DEF_W;
  let H = DEF_H;
  let X = DEF_X;
  let Y = DEF_Y;
  if (savedBounds) {
    // 忠实还原上次的几何：不按当前屏幕/工作区改写尺寸与位置（用户拖到哪、多大就是哪）。
    // 只有整窗都不在任何屏幕上时才会走到上面的默认居中分支（isBoundsVisible）。
    W = savedBounds.width;
    H = savedBounds.height;
    X = savedBounds.x;
    Y = savedBounds.y;
  }

  gameReady = false;

  mainWindow = new BrowserWindow({
    x: X,
    y: Y,
    width: W,
    height: H,
    minWidth: Math.min(MIN_W, W),
    minHeight: Math.min(MIN_H + PC_TB, H),
    backgroundColor: '#141826',
    frame: false,                    // 无边框，标题栏由窗口层的 shell.html 画
    // 白边的真正根源：Electron 43+ 给无边框可缩放窗口（frame:false + resizable）加了一圈
    // 原生 WS_THICKFRAME「厚调整边框」（左/下/右各 ~8px），渲染器画不到那圈原生区域。
    // 最大化 ⇄ 还原、全屏 ⇄ 最大化 的 DWM 动画期间，那圈边框被系统用窗口类背景刷（白色）
    // 填充，就是窗口边缘闪出的白边。thickFrame:false 去掉这圈原生边框，白边随之消失。
    // 副作用：失去 Windows 原生阴影和部分最大化动画（可接受）；官方文档警告「失去边缘拖拽」，
    // 但 Electron 的无边框 hit-test 仍能处理边缘/角落 resize（项目实测保留）。
    thickFrame: false,
    autoHideMenuBar: true,
    show: false,                     // 后台渲染，游戏就绪后再显示
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  // 白边问题的第二道保险：
  // 窗口层的 shell.html 已经自己画不透明 #141826（见该文件里的说明），但「页面还没提交
  // 第一帧」的时刻（启动、渲染进程重载/崩溃恢复）是没有页面内容的，这时露出来的是窗口
  // 原生底色。创建参数里的 backgroundColor 在 Windows 上改尺寸期间未必跟得上，
  // 这里再用 setBackgroundColor 显式落一次，保证任何空窗期都是深色而不是系统白。
  try { mainWindow.setBackgroundColor('#141826'); } catch (_) {}
  lastShapeSig = '';        // 新窗口：上一轮的区域签名作废
  applyMaximizedClip(mainWindow);   // 创建时几何确定，直接按当前状态裁剪（多屏+最大化裁到客户区，其余保持矩形）

  // 窗口本身加载「标题栏页面」（本地页，36px 高的一条）。
  // 它是这个窗口的第一次导航 —— 拖拽区（-webkit-app-region: drag）才会被登记。
  mainWindow.loadFile(path.join(__dirname, 'assets', 'shell.html'));

  // 游戏放进 WebContentsView，摆在标题栏下方：
  // 游戏的视口 = 窗口内容区 − 36px，和浏览器里完全一致，
  // 因此不需要再给游戏注入任何「100vh 补偿」的样式（游戏改版也不会失效）。
  gameView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });
  try { mainWindow.contentView.addChildView(gameView); } catch (_) {}
  // 视图底色与窗口一致：切换尺寸的瞬间若有一小条没被重绘覆盖，露出来也是深色而不是白/黑。
  try { gameView.setBackgroundColor('#141826'); } catch (_) {}
  // 同步落位：layoutGameView 是合并到下一 tick 的，如果这里只调它，
  // 首次 loadURL 时视图还是 0×0，游戏页会先按 0 尺寸排一次版再被 resize 纠正。
  flushGameViewLayout();
  const gwc = gameWC();
  if (gwc) gwc.loadURL(CONFIG.gameUrl);
  dbg('[shell] window+view created, view bounds', gameView ? (() => { try { return gameView.getBounds(); } catch (_) { return '?'; } })() : 'none');

  // 加载动画：独立窗口盖在主窗口上方，主窗口在后台并行渲染游戏
  // 上次是最大化时，splash 也铺满工作区，切换时几何完全吻合、不闪边
  createSplashWindow(restoreMaximized
    ? { x: targetArea.x, y: targetArea.y, width: targetArea.width, height: targetArea.height }
    : { x: X, y: Y, width: W, height: H });

  // 脚本注入 + 主题 + 就绪检测（都作用于游戏视图的 webContents）
  if (gwc) {
    gwc.on('did-finish-load', () => {
      dbg('[shell] game did-finish-load, url', (() => { try { return gameWC() && gameWC().getURL(); } catch (_) { return '?'; } })(), 'isGamePage', isGamePage());
      if (!isGamePage()) return;
      applyThemeToGame(gameWC());
      applyKeepActive(gameWC());
      installFpsMeter(gameWC());
      startGameReadyDetection();
      // 记注入开始时刻：并发更新若发生在此后，宁可保守提示刷新，也不能误判旧版已生效。
      pageScriptsInjectedAt = Date.now();
      injectScripts(gameWC()).then(() => {
        dbg('[scripts] ordered injection complete');
      }).catch((err) => {
        console.error('[scripts] 注入流程失败', err && err.stack ? err.stack : err);
      });
    });
    // 注入只在 did-finish-load 做一次（不要顺手在 did-navigate 里再做一遍）：
    // 那一刻主文档还在加载，Electron 的 executeJavaScript 会挂一个
    // once('did-stop-loading') 排队等页面停下来，一次加载能压十几个
    // （日志里的 MaxListenersExceeded 就是它），而且重复注入全靠页面里的
    // __pc*Installed 兜住，纯属白跑。

    // ===== 全屏快捷键 =====
    // 在渲染进程之前拦截，游戏自身的 keydown 处理吃不掉；
    // before-input-event 里 preventDefault 后，页面完全收不到这个按键。
    gwc.on('before-input-event', handleWindowKey);

    // 外链 / 登录跳转：Supabase 授权交给系统浏览器完成（Electron 会被谷歌判定为不安全浏览器），
    // 其余登录类页面留在应用内，普通外链丢给系统浏览器
    attachOpenPolicy(gwc);
    gwc.on('will-navigate', (e, url) => {
      if (isSupabaseAuthorizeUrl(url)) {
        e.preventDefault();
        startBrowserAuth(url);
        return;
      }
      if (shouldAllowNavigation(url)) return;
      e.preventDefault();
      if (isHttpUrl(url)) {
        try { shell.openExternal(url); } catch (_) {}
      }
    });

    // 主页面加载失败时不要一直卡在加载动画上
    gwc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) return;   // ERR_ABORTED：重定向/重复导航，忽略
      console.warn('[main] 页面加载失败', code, desc, url);
      finishSplash();
    });
  }

  // 标题栏（窗口层页面）自己也可能拿到焦点：把同一套快捷键也挂上
  try { mainWindow.webContents.on('before-input-event', handleWindowKey); } catch (_) {}

  // 最大化状态同步到标题栏。
  mainWindow.on('maximize', () => {
    notifyMaximizeState(mainWindow); saveWindowStateSoon(); layoutGameView(); applyMaximizedClip();
    setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(mainWindow); }, 280);   // 收尾对齐
  });
  mainWindow.on('unmaximize', () => {
    notifyMaximizeState(mainWindow); saveWindowStateSoon(); layoutGameView(); applyMaximizedClip();
    setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(mainWindow); }, 280);
  });
  mainWindow.on('enter-full-screen', () => {
    // 系统级全屏（HTML5 视频全屏等）：视图先铺满，再藏标题栏（同自绘全屏的顺序）
    flushGameViewLayout();
    setShellFullscreen(true);
    notifyMaximizeState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    // 自绘全屏退出时由 exitFullscreen 自己恢复，这里只处理系统级全屏
    if (!fsState) { setShellFullscreen(false); setTimeout(flushGameViewLayout, 32); }
    notifyMaximizeState(mainWindow);
  });
  // 全屏时置顶只是为了压住任务栏；失焦就撤销，免得挡住别的程序
  // 全屏时点到窗口外面（任务栏 / 别的窗口）不能把画面顶掉：
  // 保持 screen-saver 级置顶，并 moveTop() 抬回最前（不抢键盘焦点）。
  mainWindow.on('blur', () => { if (fsState) setFullscreenTopmost(mainWindow, true, { raise: true }); });
  mainWindow.on('focus', () => { if (fsState) setFullscreenTopmost(mainWindow, true); });

  // 位置/尺寸变化后防抖落盘；关闭时立即写一次，保证退出前状态一定被记住。
  // 窗口尺寸一变，游戏视图要跟着重排（这是唯一需要跟随窗口的东西）。
  mainWindow.on('move', saveWindowStateSoon);
  mainWindow.on('resize', () => {
    layoutGameView(); applyMaximizedClip(); saveWindowStateSoon();
  });
  mainWindow.on('close', onMainWindowClose);

  mainWindow.on('closed', () => {
    gameView = null;        // WebContentsView 随窗口一起销毁
    mainWindow = null;
    closeAuthFlow();        // 关掉登录回调服务，避免端口悬挂
    closeSplashWindow(0);   // 应用退出，无需淡出
  });
}

// ============ 游戏就绪检测 ============
function startGameReadyDetection() {
  if (gameReady) return;
  if (gameReadyTimer) clearTimeout(gameReadyTimer);
  const run = ++gameReadyRun;
  const start = Date.now();
  // 覆盖层最小显示时长，**从加载动画真正显示那一刻算**（splashShownAt，比 did-finish-load 早
  // 将近 1s；从 start 算会多露一整秒）。splash.html 一轮 2.0s（摇晃 1.32s + 停顿 0.68s），
  // 1.8s 刚好能看到完整的摇晃和停顿开头。
  const MIN_MS = 1800;
  const MAX_MS = 15000; // 兜底 15 秒
  let stableCount = 0;  // 连续稳定判定计数（确认画面真正渲染完成）
  const visibleFor = () => (splashShownAt ? Date.now() - splashShownAt : Date.now() - start);

  const schedule = () => {
    if (run !== gameReadyRun || gameReady) return;
    gameReadyTimer = setTimeout(tick, 100);
  };
  const tick = async () => {
    gameReadyTimer = null;
    if (run !== gameReadyRun || gameReady) return;
    const wc = gameWC();
    if (!wc) return;
    if (Date.now() - start > MAX_MS) {
      finishSplash();
      return;
    }
    // 主文档还在加载时不要发 executeJavaScript：Electron 内部会挂一个
    // once('did-stop-loading') 等页面停下来，100ms 一次全压在那儿，
    // 一次加载能堆出十几个监听（日志里那条 MaxListenersExceeded 就是它）。
    try {
      if (wc.isLoadingMainFrame()) { schedule(); return; }
    } catch (_) {}
    try {
      // 就绪判定：游戏骨架 + 字体加载完成 + 画面已有实际内容
      const state = await wc.executeJavaScript(`
        (function () {
          var app = document.querySelector('#app');
          var topbar = document.querySelector('#topbar');
          var screens = document.querySelectorAll('.screen, [id^="screen-"]').length;
          var fontsReady = document.fonts ? document.fonts.status === 'loaded' : true;
          // 画面是否有实际渲染内容（非空、有尺寸）
          var appBox = app ? app.getBoundingClientRect() : null;
          var hasContent = appBox && appBox.width > 0 && appBox.height > 0;
          return !!(app && topbar && screens > 0 && hasContent) && fontsReady;
        })()
      `);
      if (state) {
        stableCount++;
        // 连续 3 次（约 300ms）稳定判定，且满足最短展示时长，才淡出
        if (stableCount >= 3 && visibleFor() >= MIN_MS) {
          finishSplash();
          return;
        }
      } else {
        stableCount = 0;
      }
    } catch (_) {
      stableCount = 0;
    }

    schedule();
  };
  schedule();
}

function finishSplash() {
  if (gameReady) return;
  gameReady = true;
  gameReadyRun++;
  if (gameReadyTimer) { clearTimeout(gameReadyTimer); gameReadyTimer = null; }
  // 加载动画实际露出多久 —— 调整 splash.html 的动画节奏时要对得上这个数
  if (splashShownAt) dbg('[splash] visible', Date.now() - splashShownAt, 'ms');

  // 顺序很重要：先把主窗口显示出来（此时仍被 alwaysOnTop 的 splash 完全遮住），
  // 再销毁 splash。中间留 ~180ms 让主窗口完成第一帧绘制 —— 立刻销毁的话，
  // Chromium 还没提交这一帧，用户会看到一段纯背景色的「空屏」。
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    // 上一轮是最大化状态：在 splash 还盖着的时候最大化，用户看不到跳变
    if (restoreMaximized) {
      try { mainWindow.maximize(); } catch (_) {}
    }
    applyMaximizedClip();   // 显示前把区域对齐（最大化且多屏时裁到客户区，其余保持矩形）
    mainWindow.focus();
    setTimeout(closeSplashWindow, 180);
  } else {
    closeSplashWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();

}

// ============ 启动器设置：并入游戏设置面板的「通用」Tab ============
// 不再有独立的设置窗口（F12 以前打开它），也不单独占一个 Tab：
// 脚本、在线保持等设置由 scripts/launcher-tab.user.js 追加在游戏「通用」页底部。
// 这里只负责「让页面打开设置面板并切到通用」，F12 和「取消刷新」后的回跳都走它。
function openLauncherTab(retry) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isGamePage()) return;
  const wc = gameWC();
  if (!wc) return;
  const js = `(function () {
    try { return window.__pcOpenLauncherTab ? window.__pcOpenLauncherTab() : false; }
    catch (e) { return false; }
  })()`;
  wc.executeJavaScript(js).then((ok) => {
    if (ok) {
      try { mainWindow.focus(); } catch (_) {}
      return;
    }
    // 页面刚导航完、设置脚本还没装上：稍后再试一次
    if (!retry) setTimeout(() => openLauncherTab(true), 600);
  }).catch(() => {});
}

// F12：开/关设置面板。面板已经停在「通用」（能看到启动器那段）就收起，否则打开并切过去。
// 判定交给页面脚本（它才知道 DOM 状态），这里只按返回值收尾；
// 页面脚本还没装好时（刚导航完）退化成「只打开」。
function toggleLauncherSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isGamePage()) return;
  const wc = gameWC();
  if (!wc) return;
  const js = `(function () {
    try { return window.__pcToggleLauncherSettings ? window.__pcToggleLauncherSettings() : false; }
    catch (e) { return false; }
  })()`;
  wc.executeJavaScript(js).then((res) => {
    if (res === 'closed' || res === 'opened') {
      try { mainWindow.focus(); } catch (_) {}
      return;
    }
    openLauncherTab();
  }).catch(() => { openLauncherTab(); });
}

// ============ 启动自动检查用户脚本更新 ============
// 每次启动在后台跑一次（跟游戏加载并行、不阻塞进游戏、失败静默），只有「确实更新成功」才提示。
// 提示框做成独立无边框窗口，配色/字体/按钮全部沿用设置页的设计令牌。
let noticeWindow = null;
let scriptAutoCheckDone = false;
let pageScriptsInjectedAt = 0;   // 最近一次给游戏页注入用户脚本的时间

async function autoUpdateScriptsOnStartup() {
  if (scriptAutoCheckDone) return;
  scriptAutoCheckDone = true;

  let files = [];
  try {
    const dir = ensureScriptsDir();
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && isJavaScriptFilename(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  } catch (_) { return; }
  if (files.length === 0) return;

  const updated = [];
  let updatedAt = 0;   // 最后一次写入新版本的时间
  // 网络检查最多 3 路并发；写文件和元数据仍串行，避免多个更新互相覆盖 scripts-meta.json。
  const checks = await mapLimit(files, 3, async (name) => {
    try {
      const res = await checkScriptUpdate(name, { noCache: false });
      return { name, res };
    } catch (err) {
      return { name, res: { ok: false, error: err && err.message ? err.message : '检测失败' } };
    }
  });
  for (const { name, res } of checks) {
    try {
      if (!res || !res.ok || !res.hasUpdate) {
        if (res && !res.ok && !res.noUrl) dbg('[scripts] auto-check failed', name, res.error || 'unknown');
        continue;
      }
      const ap = await applyScriptUpdate(name, res.remoteContent);
      if (ap && ap.ok) {
        updated.push({ name, from: res.localVersion || '', to: res.remoteVersion || '' });
        updatedAt = Date.now();
      }
    } catch (_) { /* 单个脚本失败不影响其它脚本 */ }
  }
  if (updated.length === 0) {
    if (files.length) dbg('[scripts] auto-check done: checked', files.length, 'updated 0');
    return;
  }
  dbg('[scripts] startup auto-update', updated.length, updated.map((u) => u.name).join(','));

  // 「启动器」Tab 正开着的话，顺手刷新它的脚本列表
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { (gameWC() || mainWindow.webContents).send('scripts-updated', updated.length); } catch (_) {}
  }

  // 更新若在「页面注入脚本」之前就完成了，新版本其实已经生效，没必要再让人刷新；
  // 只有页面已经用旧脚本跑起来（注入时刻早于更新完成），才值得问一句。
  if (pageScriptsInjectedAt === 0 || pageScriptsInjectedAt > updatedAt) {
    dbg('[scripts] updated before inject, skip refresh prompt; injectedAt', pageScriptsInjectedAt, 'updatedAt', updatedAt);
    return;
  }

  // 检测是后台跑的，可能比游戏先出结果：等主窗口真正显示（splash 结束）再弹提示
  await waitForMainWindowVisible(20000);
  promptRefreshAfterScriptChange({ kind: 'update', items: updated });
}

// 等主窗口真正显示出来（splash 期间主窗口一直是隐藏的），最多等 timeoutMs
function waitForMainWindowVisible(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return resolve(false);
      if (mainWindow.isVisible()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

// 提示框的来路：从启动器 Tab 触发时，取消要能把游戏设置面板还回去
let noticeCtx = null;

// 脚本发生变更（导入 / 更新）后问一句要不要刷新。
// 设置界面现在是游戏内的面板：页面会先把面板收起来，再带着 reopen 调过来。
// 规则：取消 → 重新打开面板的「启动器」Tab；确认 → 不重开，直接刷新游戏页。
async function promptRefreshAfterScriptChange({ kind, items, reopen }) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return;

  // 已经有一个提示框开着（例如启动自检刚弹出来）：先收掉，用最新这批数据重开，
  // 否则会出现「面板被关掉、但提示框还是旧的」的错位。
  if (noticeWindow && !noticeWindow.isDestroyed()) {
    try { noticeWindow.destroy(); } catch (_) {}
    noticeWindow = null;
    noticeCtx = null;
    await new Promise((r) => setTimeout(r, 60));
  }

  // 面板的关闭动画约 200ms，等它收干净再弹提示，避免两个框叠在一起
  await new Promise((r) => setTimeout(r, 150));
  openScriptUpdateNotice({ kind, items: list, reopenSettings: !!reopen });
}

function openScriptUpdateNotice({ kind, items, reopenSettings }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (noticeWindow && !noticeWindow.isDestroyed()) { noticeWindow.focus(); return; }

  const list = items || [];
  const NW = 440;
  const NH = 242;
  let x, y;
  try {
    const b = mainWindow.getBounds();
    x = Math.round(b.x + (b.width - NW) / 2);
    y = Math.round(b.y + (b.height - NH) / 2);
  } catch (_) {}

  noticeCtx = { kind: kind || 'update', reopenSettings: !!reopenSettings };

  noticeWindow = new BrowserWindow({
    width: NW,
    height: NH,
    x,
    y,
    minWidth: NW, minHeight: NH, maxWidth: NW, maxHeight: NH,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    skipTaskbar: true,
    // 不透明窗口（直角）：透明窗口靠页面里的 border-radius 做圆角，代价是整窗
    // alpha 合成；现在统一方角，直接用窗口底色，省掉那层合成。
    transparent: false,
    backgroundColor: '#1c2030',
    hasShadow: false,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload-notice.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });

  // 提示框尺寸固定，数据走 query 传给页面（避免与 did-finish-load 抢时序）
  const payload = {
    kind: kind || 'update',
    count: list.length,
    items: list.map((u) => ({ name: u.name, from: u.from, to: u.to })),
  };
  noticeWindow.loadFile(path.join(__dirname, 'assets', 'notice.html'), { query: { d: JSON.stringify(payload) } });
  noticeWindow.once('ready-to-show', () => {
    if (!noticeWindow || noticeWindow.isDestroyed()) return;
    noticeWindow.show();
    noticeWindow.focus();
  });
  noticeWindow.on('closed', () => { noticeWindow = null; });
}

function ipcSenderUrl(event) {
  try { return event.senderFrame && event.senderFrame.url ? event.senderFrame.url : event.sender.getURL(); }
  catch (_) { return ''; }
}

function isGameIpcSender(event) {
  try {
    const url = new URL(ipcSenderUrl(event));
    return url.protocol === 'https:' && isGameHost(url.hostname.toLowerCase());
  } catch (_) { return false; }
}

function isLocalIpcSender(event, filename) {
  try {
    const url = new URL(ipcSenderUrl(event));
    if (url.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(url)) === path.resolve(__dirname, 'assets', filename);
  } catch (_) { return false; }
}

function requireIpcSender(event, kind) {
  const allowed = kind === 'game'
    ? isGameIpcSender(event)
    : isLocalIpcSender(event, kind === 'shell' ? 'shell.html' : 'notice.html');
  if (!allowed) throw new Error('拒绝未授权的启动器 IPC 调用');
}

const pendingScriptUpdates = new Map();
const PENDING_UPDATE_TTL = 5 * 60 * 1000;
const MAX_PENDING_SCRIPT_UPDATES = 5;

function forgetPendingScriptUpdate(token) {
  const item = pendingScriptUpdates.get(token);
  if (item && item.timer) clearTimeout(item.timer);
  pendingScriptUpdates.delete(token);
}

function rememberPendingScriptUpdate(name, content) {
  const now = Date.now();
  for (const [token, item] of pendingScriptUpdates) {
    if (!item || item.expiresAt <= now) forgetPendingScriptUpdate(token);
  }
  while (pendingScriptUpdates.size >= MAX_PENDING_SCRIPT_UPDATES) {
    forgetPendingScriptUpdate(pendingScriptUpdates.keys().next().value);
  }
  const token = crypto.randomUUID();
  const timer = setTimeout(() => forgetPendingScriptUpdate(token), PENDING_UPDATE_TTL);
  if (typeof timer.unref === 'function') timer.unref();
  pendingScriptUpdates.set(token, { name, content, expiresAt: now + PENDING_UPDATE_TTL, timer });
  return token;
}

async function readScriptSummary(dir, name, savedMeta) {
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
  };
}

// ============ IPC ============
function setupIpc() {
  ipcMain.handle('get-settings', (event) => {
    requireIpcSender(event, 'game');
    return loadSettings();
  });
  ipcMain.handle('app-info', (event) => {
    requireIpcSender(event, 'game');
    return { version: app.getVersion() };
  });
  ipcMain.handle('save-settings', (e, settings) => {
    requireIpcSender(e, 'game');
    const next = {
      keepActive: !settings || settings.keepActive !== false,
      shinyEgg: !settings || settings.shinyEgg !== false,
    };
    const ok = saveSettings(next);
    applyKeepActive(gameWC(), next);
    return ok;
  });

  ipcMain.handle('read-scripts', async (event) => {
    requireIpcSender(event, 'game');
    const dir = ensureScriptsDir();
    const meta = loadScriptsMeta();
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && isJavaScriptFilename(entry.name));
      return await Promise.all(files.map((entry) => readScriptSummary(dir, entry.name, meta[entry.name])));
    } catch (_) { return []; }
  });

  // 从 URL 导入脚本（下载）
  ipcMain.handle('import-script-from-url', async (e, { url, filename }) => {
    requireIpcSender(e, 'game');
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:') {
        return { ok: false, error: '脚本链接必须使用 HTTPS' };
      }
      const { content } = await fetchUrl(url);
      if (!content || !content.trim()) return { ok: false, error: '下载内容为空' };

      // 检测内容是否为有效脚本（而非 HTML 页面）
      const looksHtml = /^\s*</.test(content) || /<html|<head|<!doctype/i.test(content);
      if (looksHtml && !/==UserScript==/.test(content)) {
        return { ok: false, error: '该链接返回的是网页而非脚本，请使用 .user.js 直链' };
      }

      // 确定文件名：优先用 filename，其次用 URL 路径，再其次用 @name，兜底 imported.user.js
      let name = filename;
      if (!name) {
        const pathname = parsedUrl.pathname;
        const base = path.basename(pathname);
        if (base && /\.(user\.js|js)$/i.test(base)) {
          name = base;
        } else {
          const parsed = parseUserscriptMeta(content);
          name = (parsed.name || 'imported') + '.user.js';
        }
      }
      name = safeScriptName(name, { fallback: 'imported.user.js', ensureExtension: true });

      await writeScriptFile(name, content, { backup: true });

      const meta = loadScriptsMeta();
      const parsed = parseUserscriptMeta(content);
      meta[name] = {
        sourceUrl: url,
        version: parsed.version || '',
        updatedAt: Date.now(),
      };
      saveScriptsMeta(meta);

      return { ok: true, name, version: parsed.version || '' };
    } catch (err) {
      return { ok: false, error: err.message || '下载失败' };
    }
  });

  // 检测脚本更新（重新拉取 sourceUrl 对比版本/内容）
  ipcMain.handle('check-script-update', async (e, { name }) => {
    requireIpcSender(e, 'game');
    const safeName = safeScriptName(name);
    const result = await checkScriptUpdate(safeName);
    if (!result || !result.ok || !result.hasUpdate || !result.remoteContent) return result;
    const updateToken = rememberPendingScriptUpdate(safeName, result.remoteContent);
    const { remoteContent, ...publicResult } = result;
    return { ...publicResult, updateToken };
  });

  // 执行更新（用检测到的远程内容覆盖本地）
  ipcMain.handle('apply-script-update', async (e, { name, updateToken }) => {
    requireIpcSender(e, 'game');
    const safeName = safeScriptName(name);
    const token = String(updateToken || '');
    const pending = pendingScriptUpdates.get(token);
    forgetPendingScriptUpdate(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.name !== safeName) {
      return { ok: false, error: '更新内容已失效，请重新检查' };
    }
    return await applyScriptUpdate(safeName, pending.content);
  });

  ipcMain.handle('delete-script', async (e, name) => {
    requireIpcSender(e, 'game');
    const safeName = safeScriptName(name);
    if (!safeName) return { ok: false, error: '脚本文件名无效' };
    const target = path.join(scriptsDir(), safeName);
    try {
      try {
        await fs.promises.access(target);
        const backupDir = scriptsBackupDir();
        await fs.promises.mkdir(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.promises.copyFile(target, path.join(backupDir, `${safeName}.${stamp}.deleted.bak`));
        await fs.promises.unlink(target);
        await pruneScriptBackups(backupDir, safeName);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      // 同时清理元数据
      const meta = loadScriptsMeta();
      if (meta[safeName]) { delete meta[safeName]; saveScriptsMeta(meta); }
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('pick-script-file', async (event) => {
    requireIpcSender(event, 'game');
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择油猴脚本',
      filters: [
        { name: '油猴脚本', extensions: ['js', 'user.js'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const items = [];
    const failed = [];
    const meta = loadScriptsMeta();
    for (const fp of result.filePaths) {
      try {
        const stat = await fs.promises.stat(fp);
        if (stat.size > MAX_SCRIPT_BYTES) throw new Error(`超过 ${MAX_SCRIPT_BYTES / 1024 / 1024} MB 限制`);
        const content = await fs.promises.readFile(fp, 'utf8');
        const name = safeScriptName(path.basename(fp), { fallback: 'script.user.js', ensureExtension: true });
        await writeScriptFile(name, content, { backup: true });
        const parsed = parseUserscriptMeta(content);
        meta[name] = {
          sourceUrl: parsed.downloadURL || parsed.updateURL || '',
          version: parsed.version || '',
          updatedAt: Date.now(),
        };
        items.push({ name, to: parsed.version || '' });
      } catch (err) {
        failed.push({ name: path.basename(fp), error: err.message });
      }
    }
    if (items.length) saveScriptsMeta(meta);
    return { ok: items.length > 0, items, failed };
  });

  ipcMain.handle('open-scripts-dir', async (event) => {
    requireIpcSender(event, 'game');
    shell.openPath(ensureScriptsDir());
    return { ok: true };
  });

  // 标题栏按钮
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender) || mainWindow;
  ipcMain.on('win-minimize', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    windowAction(winOf(e), 'minimize');
  });
  ipcMain.on('win-maximize', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    windowAction(winOf(e), 'maximize');
  });
  ipcMain.on('win-close', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    windowAction(winOf(e), 'close');
  });
  ipcMain.on('win-toggle-fullscreen', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    toggleFullscreen(winOf(e));
  });

  // 查询窗口状态（最大化/全屏）
  ipcMain.handle('win-is-maximized', (e) => {
    requireIpcSender(e, 'shell');
    const win = winOf(e);
    return win ? (win.isMaximized() || isFullscreenNow(win)) : false;
  });

  // 启动器 Tab 里导入 / 更新完脚本：页面已先收起游戏面板，
  // 这里只负责弹「N 个脚本已导入/已更新，是否刷新」，并记住取消后要不要把面板还回去。
  ipcMain.on('script-change-prompt', (e, payload) => {
    if (!isGameIpcSender(e)) return;
    const p = payload || {};
    const kind = p.kind === 'import' ? 'import' : 'update';
    const items = Array.isArray(p.items) ? p.items : [];
    promptRefreshAfterScriptChange({ kind, items, reopen: p.reopen !== false });
  });

  // 脚本更新提示框：确认刷新 / 取消
  ipcMain.on('notice-action', (e, action) => {
    if (!isLocalIpcSender(e, 'notice.html')) return;
    const wn = BrowserWindow.fromWebContents(e.sender);
    const ctx = noticeCtx || {};
    noticeCtx = null;
    const refresh = action === 'refresh';
    if (wn && !wn.isDestroyed()) wn.close();
    if (refresh && mainWindow && !mainWindow.isDestroyed()) {
      const wc = gameWC();
    if (!wc) return;
      // 游戏若注册了 beforeunload，Electron 默认会静默取消 reload —— 用户点了「确认」
      // 就强制放行一次，避免点了没反应。
      const allowUnload = (ev) => { try { ev.preventDefault(); } catch (_) {} };
      wc.once('will-prevent-unload', allowUnload);
      // reload 后 did-finish-load 会重新注入内置脚本 + 更新后的用户脚本
      wc.reload();
      setTimeout(() => { try { wc.removeListener('will-prevent-unload', allowUnload); } catch (_) {} }, 4000);
      try { mainWindow.focus(); } catch (_) {}
    } else if (!refresh && ctx.reopenSettings) {
      // 取消：把游戏设置面板的「启动器」Tab 还回去，用户还能接着改
      setTimeout(() => { try { openLauncherTab(); } catch (_) {} }, 120);
    }
  });
}

app.whenReady().then(() => {
  // 远程游戏不需要相机、麦克风、定位、MIDI 等系统权限：默认拒绝，避免页面或
  // 第三方 iframe 静默获得敏感能力。请求与检查两条路径都收紧。
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // UA 也显式压到会话上：登录弹窗、第三方页面都用这份（不带 Electron 标识）
  try { session.defaultSession.setUserAgent(CLEAN_UA); } catch (_) {}


  setupIpc();

  // 硬件加速状态记一行（只有 PC_DEBUG=1 才落盘）：这游戏是 Canvas 2D + DOM 密集型
  // （打包后的 app.js 里有 61 处 getContext('2d')），一旦 gpu_compositing / rasterization
  // 掉到 disabled_software，帧率会直接腰斩 —— 而且跟启动器代码无关（驱动被 Chromium
  // 拉黑、远程桌面会话、虚拟显示器抢了 DWM 的输出都会这样）。出问题时先看这一行。
  try {
    const st = app.getGPUFeatureStatus();
    dbg('[gpu] compositing=' + st.gpu_compositing, 'raster=' + st.rasterization,
      'canvas2d=' + st['2d_canvas'], 'skip-gpu=' + CONFIG.disableHardwareAcceleration);
  } catch (_) {}

  createWindow();

  // 打包版通过 GitHub Releases 检查更新；开发模式自动跳过。
  setupAppUpdater({
    app,
    dialog,
    getMainWindow: () => mainWindow,
    log: {
      debug: (...args) => dbg(...args),
      error: (...args) => console.error(...args),
    },
  });

  // 用户脚本更新检测：和游戏加载/加载动画并行在后台跑，检测结果出来才可能弹提示，
  // 绝不挡在「进游戏」这条路上（提示框也会等主窗口显示后再弹）。
  setTimeout(() => { autoUpdateScriptsOnStartup(); }, 800);

  // 分辨率 / 缩放比变化后：只有正在自绘全屏时才需要重新贴合目标屏，
  // 窗口本身不做任何自动改尺寸（用户拖多大就是多大）
  try {
    screen.on('display-metrics-changed', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (fsState) {
        const t = fullscreenTargetBounds(mainWindow);
        try { mainWindow.setBounds(t); } catch (_) {}
      }
    });
  } catch (_) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => app.quit());

