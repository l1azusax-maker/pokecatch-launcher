// ============================================================
// 启动器设置（并进游戏设置面板的「通用」Tab）
//
// 「启动器设置 / 油猴脚本 / 关于」三块追加在「通用」页原生内容下面。
// 复用游戏现有结构（.opt-modal / .op-group / .op-card / .op-row / .op-sw / .btn）。
// ============================================================
(() => {
  'use strict';

  const L = window.launcher;
  if (!L) return;
  if (window.__pcLauncherSettingsInstalled) return;
  window.__pcLauncherSettingsInstalled = true;

  const GENERAL = 'general';
  const HOST_ID = 'pc-lx-sections';

  const CSS = `
    #${HOST_ID} { display: block; margin-top: var(--s3, 12px); }
    .pc-lx-actions {
      display: flex;
      flex-wrap: nowrap;
      gap: 8px;
      margin-top: 10px;
      justify-content: stretch;
    }
    .pc-lx-actions .btn {
      flex: 1 1 0;
      min-width: 0;
      padding: 0 10px;
      justify-content: center;
      text-align: center;
      white-space: nowrap;
    }
    .pc-lx-empty { padding: 18px 16px; text-align: center; color: var(--muted); font-size: var(--fs-caption, 14px); }
    .pc-lx-row .t b { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .pc-lx-row.disabled .t b, .pc-lx-row.disabled .t small { opacity: .6; }
    .pc-lx-badge {
      display: inline-block;
      font-size: var(--fs-micro, 12px);
      line-height: 18px;
      padding: 0 6px;
      border-radius: var(--r-pill, 999px);
      background: color-mix(in srgb, var(--blue-vivid, #2b8cff) 20%, var(--panel));
      border: 1px solid color-mix(in srgb, var(--blue-vivid, #2b8cff) 45%, transparent);
      color: var(--text-2);
      font-weight: 600;
    }
    .pc-lx-badge.off {
      background: color-mix(in srgb, var(--muted, #9aa3bb) 16%, var(--panel));
      border-color: var(--line);
      color: var(--muted);
    }
    .pc-lx-badge.err {
      background: color-mix(in srgb, var(--red, #e3353b) 16%, var(--panel));
      border-color: color-mix(in srgb, var(--red, #e3353b) 55%, transparent);
      color: var(--danger-text, #ff9c9f);
    }
    .pc-lx-err { color: var(--danger-text, #ff8e92); }
    .pc-lx-row-acts {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
    }
    .pc-lx-mini {
      padding: 0 10px;
      height: 30px;
      min-height: 30px;
      font-size: var(--fs-caption, 14px);
    }
    .pc-lx-mini.danger-armed {
      border-color: color-mix(in srgb, var(--red, #e3353b) 80%, transparent);
      background: color-mix(in srgb, var(--red, #e3353b) 22%, var(--panel));
      color: #fff;
    }
    .pc-lx-swbtn {
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      padding: 4px 2px;
      border: 0;
      background: transparent;
    }
    .pc-lx-form { margin-top: 10px; }
    .pc-lx-form .op-row { padding: 8px 10px; gap: 8px; cursor: default; }
    .pc-lx-input {
      flex: 1;
      min-width: 0;
      height: 36px;
      padding: 0 10px;
      border: 2px solid var(--line);
      border-radius: var(--r-sm, 10px);
      background: var(--panel);
      color: var(--text);
      font: inherit;
      font-size: var(--fs-caption, 14px);
      outline: none;
    }
    .pc-lx-input:focus { border-color: var(--blue-vivid, #2b8cff); }
    .pc-lx kbd {
      font: inherit;
      font-size: var(--fs-micro, 12px);
      padding: 1px 6px;
      border: 1px solid var(--line);
      border-radius: var(--r-xs, 6px);
      background: var(--panel);
      color: var(--text-2);
    }
  `;

  // ---------- 状态 ----------
  const state = {
    settings: {
      keepActive: true,
      shinyEgg: true,
      minimizeToTray: false,
    },
    scripts: [],
    scriptsError: '',
    showUrl: false,
    appVer: '',
    appUpdate: {
      state: 'idle',
      currentVersion: '',
      availableVersion: '',
      percent: 0,
      message: '',
    },
    armedDelete: '',
  };

  let armedTimer = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function ensureStyle() {
    if (document.getElementById('pc-launcher-settings-style')) return;
    const st = document.createElement('style');
    st.id = 'pc-launcher-settings-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function toast(msg) {
    try {
      const host = document.getElementById('toasts');
      if (!host) return;
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = String(msg || '');
      host.appendChild(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 320);
      }, 2200);
    } catch (_) {}
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function shortUrl(u) {
    const s = String(u || '');
    return s.length > 52 ? s.slice(0, 30) + '…' + s.slice(-19) : s;
  }

  async function mapLimit(items, limit, worker) {
    const list = Array.from(items || []);
    const out = new Array(list.length);
    let cursor = 0;
    const width = Math.max(1, Math.min(limit, list.length));
    await Promise.all(Array.from({ length: width }, async () => {
      while (cursor < list.length) {
        const idx = cursor++;
        out[idx] = await worker(list[idx], idx);
      }
    }));
    return out;
  }

  // ---------- 页面片段 ----------
  function switchRow(key, title, desc, on) {
    return `<div class="op-row${on ? ' on' : ''}" data-pc-sw="${key}" role="switch" aria-checked="${on ? 'true' : 'false'}" tabindex="0">
      <span class="t"><b>${esc(title)}</b><small>${esc(desc)}</small></span><span class="op-sw"></span>
    </div>`;
  }

  function bindSwitchRow(row) {
    if (!row || row.__pcSwBound) return;
    row.__pcSwBound = true;
    const toggle = () => {
      const key = row.getAttribute('data-pc-sw');
      const on = !row.classList.contains('on');
      row.classList.toggle('on', on);
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      state.settings[key] = on;
      if (key === 'shinyEgg' && window.__pcShinyEggPreview) {
        try { window.__pcShinyEggPreview.set(on); } catch (_) {}
      }
      // 仅提交当前开关字段，避免覆盖标题栏/托盘刚改动的静音或置顶状态。
      Promise.resolve(L.saveSettings({ [key]: on })).then((ok) => {
        if (ok === false) toast('保存失败');
        else if (key === 'keepActive') toast(on ? '最小化时保持在线' : '最小化时将按离线处理');
        else if (key === 'shinyEgg') toast(on ? '已开启异色蛋预览' : '已关闭异色蛋预览');
        else if (key === 'minimizeToTray') toast(on ? '关闭窗口时将收进系统托盘' : '关闭窗口时直接退出启动器');
      }).catch(() => toast('保存失败'));
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });
  }

  function scriptRow(s) {
    const enabled = s.enabled !== false;
    const badges = [];
    if (s.version) badges.push(`<span class="pc-lx-badge">v${esc(s.version)}</span>`);
    if (!enabled) badges.push('<span class="pc-lx-badge off">已停用</span>');
    if (s.lastError) badges.push(`<span class="pc-lx-badge err" title="${esc(s.lastError)}">注入异常</span>`);

    const meta = [];
    if (s.mtime) meta.push('更新于 ' + fmtTime(s.mtime));
    if (s.sourceUrl) meta.push(shortUrl(s.sourceUrl));
    const errText = s.lastError ? `<div class="pc-lx-err">错误：${esc(s.lastError.slice(0, 90))}</div>` : '';

    const isDelArmed = state.armedDelete === s.name;

    // 注意：游戏原生开关样式依赖父级 .op-row.on 来激活 .op-sw 的开启态。
    return `<div class="op-row op-static pc-lx-row${enabled ? ' on' : ' disabled'}">
      <span class="t">
        <b>${esc(s.name)}${badges.join('')}</b>
        <small>${esc(meta.join(' · '))}${errText}</small>
      </span>
      <div class="pc-lx-row-acts">
        <button class="pc-lx-swbtn" data-pc="toggleScript" data-name="${esc(s.name)}" data-enabled="${enabled ? '1' : '0'}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" title="${enabled ? '点击停用脚本' : '点击启用脚本'}">
          <span class="op-sw"></span>
        </button>
        <button class="btn small ghost pc-lx-mini${isDelArmed ? ' danger-armed' : ''}" data-pc="del" data-name="${esc(s.name)}">${isDelArmed ? '确认删?' : '删除'}</button>
      </div>
    </div>`;
  }

  function appUpdateRowHTML() {
    const u = state.appUpdate || {};
    const verPrefix = state.appVer ? 'v' + esc(state.appVer) + ' · ' : '';
    let desc = `${verPrefix}作者：梓贱 · 设置已并入游戏设置面板`;
    if (u.message) desc = `${verPrefix}${esc(u.message)}`;

    let btnHTML = '<button class="btn small ghost pc-lx-mini" data-pc="checkAppUpdate">检查更新</button>';
    if (u.state === 'checking') {
      btnHTML = '<button class="btn small ghost pc-lx-mini" disabled>检查中…</button>';
    } else if (u.state === 'available' || u.state === 'downloading') {
      const pct = Number.isFinite(u.percent) ? u.percent : 0;
      btnHTML = `<button class="btn small ghost pc-lx-mini" disabled>下载中 ${pct}%</button>`;
    } else if (u.state === 'downloaded') {
      btnHTML = '<button class="btn small gold pc-lx-mini" data-pc="installAppUpdate">重启安装</button>';
    } else if (u.state === 'unsupported') {
      btnHTML = '<button class="btn small ghost pc-lx-mini" disabled>开发模式</button>';
    }

    return `<div class="op-row op-static">
      <span class="t"><b>Poke'Catch 启动器</b><small>${desc}</small></span>
      <div class="pc-lx-row-acts">${btnHTML}</div>
    </div>`;
  }

  function sectionsHTML() {
    const s = state.settings;
    const scripts = state.scripts || [];

    let scriptsBody;
    if (state.scriptsError) {
      scriptsBody = `<div class="pc-lx-empty">读取脚本失败：${esc(state.scriptsError)}</div>`;
    } else {
      scriptsBody = scripts.length
        ? scripts.map(scriptRow).join('')
        : '<div class="pc-lx-empty">还没有导入脚本</div>';
    }

    return `<div class="op-group">
        <h5>启动器设置</h5>
        <div class="op-card">
          ${switchRow('shinyEgg', '提前显示异色蛋', '培育屋的蛋按存档直接判定并标出异色（只读存档，不改任何数据）', s.shinyEgg !== false)}
          ${switchRow('keepActive', '最小化时保持在线', '最小化或被遮挡时，游戏不会判定你离开，也不结算离线进度', s.keepActive !== false)}
          ${switchRow('minimizeToTray', '关闭窗口时收进托盘', '点击右上角关闭按钮后隐藏到系统托盘继续挂机，可在托盘右键退出', !!s.minimizeToTray)}
        </div>
      </div>

      <div class="op-group">
        <h5>油猴脚本</h5>
        <div class="op-card">${scriptsBody}</div>
        <div class="pc-lx-actions">
          <button class="btn small ghost" data-pc="openDir">脚本目录</button>
          <button class="btn small ghost" data-pc="import">导入脚本</button>
          <button class="btn small ghost" data-pc="checkAll">检查更新</button>
          <button class="btn small ghost" data-pc="importUrl">链接导入</button>
        </div>
        <div class="pc-lx-form" ${state.showUrl ? '' : 'hidden'}>
          <div class="op-card">
            <div class="op-row op-static">
              <span class="t"><input class="pc-lx-input" data-pc="url" placeholder="https://example.com/script.user.js" spellcheck="false"></span>
              <button class="btn small gold" data-pc="urlGo">下载</button>
            </div>
          </div>
        </div>
      </div>

      <div class="op-group">
        <h5>关于</h5>
        <div class="op-card">
          ${appUpdateRowHTML()}
          <div class="op-row op-static">
            <span class="t"><b>快捷键</b><small><kbd>F5</kbd> 刷新 · <kbd>F11</kbd> 全屏 · <kbd>F12</kbd> 设置 · <kbd>Ctrl+M</kbd> 静音</small></span>
          </div>
        </div>
      </div>`;
  }

  // ---------- 数据 ----------
  function applySettingsToState(s) {
    if (!s || typeof s !== 'object') return;
    state.settings = {
      keepActive: s.keepActive !== false,
      shinyEgg: s.shinyEgg !== false,
      minimizeToTray: s.minimizeToTray === true,
    };
    if (window.__pcShinyEggPreview) {
      try { window.__pcShinyEggPreview.set(state.settings.shinyEgg); } catch (_) {}
    }
  }

  async function refreshSettings() {
    try {
      const s = await L.getSettings();
      applySettingsToState(s);
    } catch (_) {}
  }

  async function refreshScripts() {
    try {
      state.scripts = await L.readScripts();
      state.scriptsError = '';
    } catch (err) {
      state.scriptsError = err.message;
    }
  }

  async function refreshAppUpdateState() {
    try {
      if (typeof L.getAppUpdateState === 'function') {
        const st = await L.getAppUpdateState();
        if (st && typeof st === 'object') state.appUpdate = { ...state.appUpdate, ...st };
      }
    } catch (_) {}
  }

  function hostEl() {
    return document.querySelector(`.opt-modal .gd-page #${HOST_ID}`);
  }

  function onGeneralTab() {
    const nav = document.querySelector('.opt-modal .gd-nav');
    return !!(nav && nav.querySelector(`[data-p="${GENERAL}"].on`));
  }

  function armDelete(name) {
    if (armedTimer) clearTimeout(armedTimer);
    state.armedDelete = name;
    render();
    armedTimer = setTimeout(() => {
      armedTimer = 0;
      if (state.armedDelete) {
        state.armedDelete = '';
        render();
      }
    }, 3500);
  }

  function render() {
    const host = hostEl();
    if (!host) return;
    host.innerHTML = sectionsHTML();
    bindSections(host);
    if (state.showUrl) {
      const input = host.querySelector('[data-pc="url"]');
      if (input) setTimeout(() => { try { input.focus(); } catch (_) {} }, 60);
    }
  }

  async function closePanel() {
    const clickX = () => {
      const m = document.querySelector('.opt-modal');
      const x = m && m.querySelector('.dc-x');
      if (x) { try { x.click(); } catch (_) {} }
    };
    clickX();
    for (let i = 0; i < 4 && document.querySelector('.opt-modal'); i++) {
      await sleep(70);
      clickX();
    }
  }

  async function promptRefresh(kind, items) {
    if (!items || !items.length) return;
    await closePanel();
    await sleep(150);
    try { L.promptScriptRefresh({ kind, items, reopen: true }); } catch (_) {}
  }

  // ---------- 交互 ----------
  function bindSections(host) {
    host.querySelectorAll('[data-pc-sw]').forEach(bindSwitchRow);

    const act = (name) => host.querySelector(`[data-pc="${name}"]`);

    // 导入脚本（文件）
    act('import') && (act('import').onclick = async () => {
      let picked;
      try {
        picked = await L.pickScriptFile();
      } catch (err) {
        toast('导入失败：' + err.message);
        return;
      }
      if (!picked || !picked.ok || !picked.items || !picked.items.length) {
        if (picked && picked.failed && picked.failed.length) toast('导入失败：' + picked.failed[0].error);
        return;
      }
      await refreshScripts();
      await promptRefresh('import', picked.items);
    });

    // 从链接导入
    act('importUrl') && (act('importUrl').onclick = () => {
      state.showUrl = !state.showUrl;
      render();
    });
    act('url') && act('url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const go = act('urlGo'); if (go) go.click(); }
    });
    act('urlGo') && (act('urlGo').onclick = async () => {
      const input = host.querySelector('[data-pc="url"]');
      const url = (input && input.value || '').trim();
      if (!url) return toast('请输入脚本链接');
      if (!/^https:\/\//i.test(url)) return toast('脚本链接必须以 https:// 开头');
      const btn = act('urlGo');
      const old = btn.textContent;
      btn.textContent = '下载中…';
      btn.disabled = true;
      const res = await L.importScriptFromUrl(url, '');
      btn.textContent = old;
      btn.disabled = false;
      if (!res || !res.ok) return toast('导入失败：' + ((res && res.error) || '未知错误'));
      state.showUrl = false;
      await refreshScripts();
      await promptRefresh('import', [{ name: res.name, to: res.version || '' }]);
    });

    // 并发检查全部脚本更新（实时进度）
    act('checkAll') && (act('checkAll').onclick = async () => {
      const withUrl = (state.scripts || []).filter((s) => s.sourceUrl);
      const noUrl = (state.scripts || []).length - withUrl.length;
      if (!withUrl.length) {
        return toast(noUrl
          ? '这些脚本没有来源链接，无法检测更新（用「链接导入」添加的才有）'
          : '还没有导入过脚本');
      }
      const btn = act('checkAll');
      const old = btn.textContent;
      btn.disabled = true;
      let done = 0;
      const updateProgress = () => { btn.textContent = `检查中 (${done}/${withUrl.length})…`; };
      updateProgress();

      const results = await mapLimit(withUrl, 3, async (s) => {
        try {
          const res = await L.checkScriptUpdate(s.name);
          return { script: s, res };
        } catch (err) {
          return { script: s, res: { ok: false, error: err && err.message ? err.message : '检测失败' } };
        } finally {
          done++;
          updateProgress();
        }
      });

      const updated = [];
      const failed = [];
      let current = 0;
      let latestVer = '';
      for (const { script: s, res } of results) {
        if (!res || !res.ok) {
          failed.push(`${s.nameFromMeta || s.name}：${(res && res.error) || '检测失败'}`);
          continue;
        }
        if (!res.hasUpdate) { current++; latestVer = res.localVersion || latestVer; continue; }
        const ap = await L.applyScriptUpdate(s.name, res.updateToken);
        if (ap && ap.ok) updated.push({ name: s.name, from: res.localVersion || '', to: res.remoteVersion || '' });
        else failed.push(`${s.nameFromMeta || s.name}：写入失败${(ap && ap.error) ? '（' + ap.error + '）' : ''}`);
      }
      btn.textContent = old;
      btn.disabled = false;
      await refreshScripts();
      if (updated.length) return promptRefresh('update', updated);
      render();
      if (failed.length) {
        return toast(failed.length === 1 ? failed[0] : `${failed[0]} 等 ${failed.length} 个检测失败`);
      }
      toast(current
        ? `${current} 个脚本已是最新${latestVer ? '（v' + latestVer + '）' : ''}`
        : '检查完成');
    });

    // 打开脚本目录
    act('openDir') && (act('openDir').onclick = async () => {
      try {
        const result = await L.openScriptsDir();
        if (!result.ok) toast('打开脚本目录失败：' + result.error);
      } catch (err) {
        toast('打开脚本目录失败：' + err.message);
      }
    });

    // 单脚本启用/禁用
    host.querySelectorAll('[data-pc="toggleScript"]').forEach((btn) => {
      btn.onclick = async () => {
        const name = btn.getAttribute('data-name');
        const nextEnabled = btn.getAttribute('data-enabled') !== '1';
        if (!name) return;
        const res = await L.toggleScriptEnabled(name, nextEnabled);
        if (res && res.ok) {
          await refreshScripts();
          render();
          toast(`${nextEnabled ? '已启用' : '已停用'} ${name}，按 F5 刷新后生效`);
        } else {
          toast('切换失败：' + ((res && res.error) || '未知错误'));
        }
      };
    });

    // 删除脚本（二次确认防误删）
    host.querySelectorAll('[data-pc="del"]').forEach((btn) => {
      btn.onclick = async () => {
        const name = btn.getAttribute('data-name');
        if (!name) return;
        if (state.armedDelete !== name) {
          armDelete(name);
          toast('再次点击「确认删?」删除该脚本');
          return;
        }
        state.armedDelete = '';
        const res = await L.deleteScript(name);
        if (res && res.ok) {
          toast(`已删除 ${name}，按 F5 刷新后生效`);
          await refreshScripts();
          render();
        } else {
          toast('删除失败：' + ((res && res.error) || '未知错误'));
          render();
        }
      };
    });

    // 启动器自身更新检查 / 安装
    act('checkAppUpdate') && (act('checkAppUpdate').onclick = async () => {
      if (typeof L.checkAppUpdate !== 'function') return;
      state.appUpdate = { ...state.appUpdate, state: 'checking', message: '正在检查更新…' };
      render();
      try {
        const res = await L.checkAppUpdate();
        if (res && typeof res === 'object') {
          state.appUpdate = { ...state.appUpdate, ...res };
          render();
          if (res.message) toast(res.message);
        }
      } catch (err) {
        toast('检查更新失败：' + err.message);
      }
    });
    act('installAppUpdate') && (act('installAppUpdate').onclick = async () => {
      if (typeof L.installAppUpdate !== 'function') return;
      const res = await L.installAppUpdate();
      if (res && !res.ok) toast(res.error || '重启安装失败');
    });
  }

  // ---------- 注入到「通用」页 ----------
  function syncSections() {
    ensureStyle();
    const modal = document.querySelector('.opt-modal');
    if (!modal) return;
    const page = modal.querySelector('.gd-page');
    if (!page || !onGeneralTab()) return;
    const host0 = page.querySelector('.op-page');
    if (!host0) return;
    if (page.querySelector(`#${HOST_ID}`)) return;
    const wrap = document.createElement('div');
    wrap.id = HOST_ID;
    wrap.className = 'pc-lx';
    wrap.innerHTML = sectionsHTML();
    host0.appendChild(wrap);
    bindSections(wrap);
  }

  function selectGeneral() {
    const modal = document.querySelector('.opt-modal');
    if (!modal) return false;
    const nav = modal.querySelector('.gd-nav');
    const item = nav && nav.querySelector(`[data-p="${GENERAL}"]`);
    if (item && !item.classList.contains('on')) {
      try { item.click(); } catch (_) {}
    }
    syncSections();
    return !!hostEl();
  }

  async function openSettings() {
    ensureStyle();
    ensureRootObserver();
    const hasModal = () => !!document.querySelector('.opt-modal');
    const rootOpen = () => {
      const r = document.getElementById('modal-root');
      return !!(r && r.classList.contains('open'));
    };
    for (let attempt = 0; attempt < 3 && !hasModal(); attempt++) {
      for (let i = 0; i < 25 && !hasModal() && rootOpen(); i++) await sleep(80);
      if (hasModal()) break;
      const gear = document.querySelector('#options-btn');
      if (gear && typeof gear.onclick === 'function') { try { gear.click(); } catch (_) {} }
      for (let i = 0; i < 25 && !hasModal(); i++) await sleep(80);
    }
    if (!hasModal()) return false;
    for (let i = 0; i < 20; i++) {
      if (!document.querySelector('.opt-modal')) return false;
      if (selectGeneral() && i >= 4) break;
      await sleep(70);
    }
    const page = document.querySelector('.opt-modal .gd-page');
    if (page) page.scrollTop = 0;
    return !!hostEl();
  }

  window.__pcOpenLauncherTab = function () { return openSettings(); };
  window.__pcOpenLauncherSettings = window.__pcOpenLauncherTab;

  window.__pcToggleLauncherSettings = async function () {
    ensureStyle();
    if (document.querySelector('.opt-modal') && onGeneralTab() && hostEl()) {
      await closePanel();
      return 'closed';
    }
    return (await openSettings()) ? 'opened' : 'failed';
  };

  // ---------- 启动 ----------
  ensureStyle();
  refreshSettings().then(() => { if (hostEl()) render(); });
  refreshAppUpdateState().then(() => { if (hostEl()) render(); });
  try {
    Promise.resolve(L.appInfo && L.appInfo())
      .then((info) => { state.appVer = (info && info.version) || ''; if (hostEl()) render(); })
      .catch(() => {});
  } catch (_) {}
  refreshScripts().then(() => { if (hostEl()) render(); });

  let observedRoot = null;
  let rootObserver = null;
  let syncQueued = false;
  function queueSyncSections() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      syncSections();
    });
  }
  function ensureRootObserver() {
    const next = document.getElementById('modal-root');
    if (next === observedRoot) return;
    if (rootObserver) rootObserver.disconnect();
    observedRoot = next;
    rootObserver = null;
    if (!next) return;
    rootObserver = new MutationObserver(queueSyncSections);
    rootObserver.observe(next, { childList: true, subtree: true });
    queueSyncSections();
  }
  ensureRootObserver();
  setInterval(ensureRootObserver, 5000);

  if (typeof L.onScriptsUpdated === 'function') {
    const unsubscribe = L.onScriptsUpdated(async () => {
      await refreshScripts();
      if (hostEl()) { render(); toast('脚本已在后台更新'); }
    });
    window.addEventListener('pagehide', unsubscribe, { once: true });
  }

  if (typeof L.onSettingsChanged === 'function') {
    const unsubscribe = L.onSettingsChanged((next) => {
      applySettingsToState(next);
      if (hostEl()) render();
    });
    window.addEventListener('pagehide', unsubscribe, { once: true });
  }

  if (typeof L.onAppUpdateState === 'function') {
    const unsubscribe = L.onAppUpdateState((next) => {
      if (next && typeof next === 'object') {
        state.appUpdate = { ...state.appUpdate, ...next };
        if (hostEl()) render();
      }
    });
    window.addEventListener('pagehide', unsubscribe, { once: true });
  }

  // ---------- 培育屋快要孵化 / 地下通道探索已完成 / 金钱总数：极低功耗托盘同步 ----------
  if (typeof L.reportTrayAlert === 'function') {
    const SAVE_KEY = 'gachamon-save-v1';
    const CLOCK_KEY = 'pokecatch.clock';
    let schedules = { eggItems: [], underItems: [], moneyNum: null };
    let lastReportedSig = '';
    let parseTimer = 0;
    let checkTimer = 0;
    let lastStorageSyncAt = 0;

    // 只从顶层大 JSON 字符串中切出 pension.eggs / under.slots 极小数组，跳过占 95%+ 体积的 mons 等字段。
    function findMatchingBracket(text, startIdx, openCh, closeCh) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === openCh) depth++;
        else if (ch === closeCh) {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    function extractChildArray(raw, parentKey, childKey) {
      const pNeedle = `"${parentKey}":`;
      let pIdx = raw.indexOf(pNeedle);
      while (pIdx !== -1) {
        let braceStart = pIdx + pNeedle.length;
        while (braceStart < raw.length && raw[braceStart] <= ' ') braceStart++;
        if (raw[braceStart] === '{') {
          const braceEnd = findMatchingBracket(raw, braceStart, '{', '}');
          if (braceEnd === -1) return null;
          const sub = raw.slice(braceStart, braceEnd + 1);
          const cNeedle = `"${childKey}":`;
          let cIdx = sub.indexOf(cNeedle);
          while (cIdx !== -1) {
            let arrStart = cIdx + cNeedle.length;
            while (arrStart < sub.length && sub[arrStart] <= ' ') arrStart++;
            if (sub[arrStart] === '[') {
              const arrEnd = findMatchingBracket(sub, arrStart, '[', ']');
              if (arrEnd !== -1) {
                return JSON.parse(sub.slice(arrStart, arrEnd + 1));
              }
            }
            cIdx = sub.indexOf(cNeedle, cIdx + cNeedle.length);
          }
          return [];
        }
        pIdx = raw.indexOf(pNeedle, pIdx + pNeedle.length);
      }
      return [];
    }

    function collectItems(eggs, slots, eggItems, underItems) {
      if (Array.isArray(eggs)) {
        for (let i = 0; i < eggs.length; i++) {
          const egg = eggs[i];
          const hatchAt = Number(egg && egg.hatchAt);
          if (Number.isFinite(hatchAt) && hatchAt > 0) {
            const id = String(egg.uid != null ? egg.uid : (egg.k != null ? egg.k : `${hatchAt}:${i}`));
            eggItems.push({ id: 'egg:' + id, at: hatchAt });
          }
        }
      }
      if (Array.isArray(slots)) {
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          if (!slot || typeof slot !== 'object') continue;
          const rawId = slot.id != null ? slot.id : (slot.bay != null ? `${slot.bay}:${slot.start || 0}` : `${slot.start || 0}:${i}`);
          if (slot.recalled != null) {
            underItems.push({ id: 'ug:' + String(rawId), at: 0 });
          } else {
            const end = Number(slot.end);
            if (Number.isFinite(end) && end > 0) {
              underItems.push({ id: 'ug:' + String(rawId), at: end });
            }
          }
        }
      }
    }

    function readSchedulesFromRaw(raw) {
      const eggItems = [];
      const underItems = [];
      let moneyNum = null;
      const moneyMatch = raw.slice(0, 400).match(/"money"\s*:\s*(\d+)/) || raw.match(/"money"\s*:\s*(\d+)/);
      if (moneyMatch) moneyNum = Number(moneyMatch[1]);
      try {
        const eggs = extractChildArray(raw, 'pension', 'eggs');
        const slots = extractChildArray(raw, 'under', 'slots');
        collectItems(eggs, slots, eggItems, underItems);
      } catch (_) {
        try {
          const save = JSON.parse(raw);
          if (Number.isFinite(Number(save && save.money))) moneyNum = Number(save.money);
          collectItems(save && save.pension && save.pension.eggs, save && save.under && save.under.slots, eggItems, underItems);
        } catch (_) {}
      }
      return { eggItems, underItems, moneyNum };
    }

    function readLiveMoneyText() {
      try {
        const el = document.getElementById('money');
        const txt = el && el.textContent ? el.textContent.trim() : '';
        if (txt) return txt;
      } catch (_) {}
      if (Number.isFinite(schedules.moneyNum)) {
        return Math.max(0, Math.floor(schedules.moneyNum)).toLocaleString('en-US');
      }
      return '';
    }

    function getGameNow() {
      const localNow = Date.now();
      try {
        const clockFloor = Number(localStorage.getItem(CLOCK_KEY) || 0);
        if (Number.isFinite(clockFloor) && clockFloor > localNow && clockFloor - localNow < 120000) {
          return clockFloor;
        }
      } catch (_) {}
      return localNow;
    }

    function evaluateAndSchedule() {
      if (checkTimer) { clearTimeout(checkTimer); checkTimer = 0; }
      const now = getGameNow();
      let readyEggs = 0;
      let readyUnderground = 0;
      const readyIds = [];
      let nextAt = Infinity;

      const eggs = schedules.eggItems;
      for (let i = 0; i < eggs.length; i++) {
        if (now >= eggs[i].at) {
          readyEggs++;
          readyIds.push(eggs[i].id);
        } else if (eggs[i].at < nextAt) {
          nextAt = eggs[i].at;
        }
      }
      const under = schedules.underItems;
      for (let i = 0; i < under.length; i++) {
        if (now >= under[i].at) {
          readyUnderground++;
          readyIds.push(under[i].id);
        } else if (under[i].at < nextAt) {
          nextAt = under[i].at;
        }
      }

      const money = readLiveMoneyText();
      const sig = `${money}|${readyIds.join(',')}`;
      if (sig !== lastReportedSig) {
        lastReportedSig = sig;
        try { L.reportTrayAlert({ money, readyEggs, readyUnderground, readyIds }); } catch (_) {}
      }

      // 每 3 秒轻量检查一次 #money 文本和内存时间戳（零 localStorage 读取、零 JSON.parse）；
      // 超过 15 秒再做一次局部切片兜底复核。
      const delay = Number.isFinite(nextAt)
        ? Math.max(300, Math.min(3000, nextAt - now + 300))
        : 3000;
      checkTimer = setTimeout(() => {
        if (Date.now() - lastStorageSyncAt >= 15000) refreshFromStorage();
        else evaluateAndSchedule();
      }, delay);
    }

    function refreshFromStorage() {
      lastStorageSyncAt = Date.now();
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        schedules = raw ? readSchedulesFromRaw(raw) : { eggItems: [], underItems: [], moneyNum: null };
      } catch (_) {}
      evaluateAndSchedule();
    }

    function scheduleParse() {
      if (parseTimer) clearTimeout(parseTimer);
      parseTimer = setTimeout(() => {
        parseTimer = 0;
        refreshFromStorage();
      }, 350);
    }

    // 被动监听游戏写存档（产蛋/收蛋/派出地下探索/领奖都会写入），零轮询读盘开销。
    try {
      const proto = Storage.prototype;
      if (!proto.__pcSaveHooked) {
        const origSetItem = proto.setItem;
        proto.setItem = function (key, value) {
          const res = origSetItem.apply(this, arguments);
          if (this === window.localStorage && key === SAVE_KEY) {
            try {
              if (typeof window.__pcOnSaveWritten === 'function') window.__pcOnSaveWritten();
            } catch (_) {}
          }
          return res;
        };
        proto.__pcSaveHooked = true;
      }
      window.__pcOnSaveWritten = () => scheduleParse();
    } catch (_) {}

    const onStorageEvent = (e) => {
      if (e.key === SAVE_KEY || e.key === null) scheduleParse();
    };
    window.addEventListener('storage', onStorageEvent);
    refreshFromStorage();

    window.addEventListener('pagehide', () => {
      if (parseTimer) clearTimeout(parseTimer);
      if (checkTimer) clearTimeout(checkTimer);
      window.removeEventListener('storage', onStorageEvent);
      window.__pcOnSaveWritten = null;
    }, { once: true });
  }

  // ---------- 游戏深色 / 浅色主题实时同步到启动器外壳与弹窗 ----------
  if (typeof L.reportTheme === 'function') {
    let lastTheme = '';
    const syncGameTheme = () => {
      try {
        const h = document.documentElement;
        const resolved = (window.Theme && typeof window.Theme.resolved === 'function')
          ? window.Theme.resolved()
          : (h && h.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
        const next = (resolved === 'light' || (h && h.getAttribute('data-theme') === 'light')) ? 'light' : 'dark';
        if (h) {
          if (next === 'light') h.style.removeProperty('color-scheme');
          else h.style.setProperty('color-scheme', 'dark');
        }
        if (next === lastTheme) return;
        lastTheme = next;
        L.reportTheme(next);
      } catch (_) {}
    };
    syncGameTheme();
    const themeObserver = new MutationObserver(syncGameTheme);
    if (document.documentElement) {
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    window.addEventListener('pagehide', () => themeObserver.disconnect(), { once: true });
  }
})();
