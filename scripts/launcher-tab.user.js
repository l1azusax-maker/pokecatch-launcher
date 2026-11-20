// ============================================================
// 启动器设置（并进游戏设置面板的「通用」Tab）
//
// 以前这里会注册一个独立的「扩展 · 启动器」Tab；现在不占 Tab 了：
// 「游戏 / 油猴脚本 / 关于」三块直接追加在「通用」页原生内容下面。
//
// 复用游戏现有结构（不要自己造轮子，游戏改版时也能跟着变）：
//   .opt-modal > .gd-in > .gd-wrap > nav.gd-nav + .gd-page
//   Tab 项：button.gd-item[data-p="general"]（通用）
//   内容：.gd-page > .op-page > h3 + .op-card / .op-group > h5 + .op-card
//   行：.op-row(.op-sw) · 按钮：.btn / .btn.small / .btn.ghost / .btn.gold
//
// 游戏每次切 Tab 都会重建 .gd-page（T()），所以这里持续盯着 DOM：
// 只要「通用」页上没有我们那段就补回去。
// ============================================================
(() => {
  'use strict';

  const L = window.launcher;          // preload 暴露的启动器 API；不在启动器里就退出
  if (!L) return;
  if (window.__pcLauncherSettingsInstalled) return;
  window.__pcLauncherSettingsInstalled = true;

  const GENERAL = 'general';          // 游戏「通用」Tab 的 data-p
  const HOST_ID = 'pc-lx-sections';   // 我们那段容器的 id

  // 只补游戏没有的原子样式，其余全部沿用游戏的设计令牌
  const CSS = `
    /* 追加在「通用」页原生设置下面，给一点上间距 */
    #${HOST_ID} { display: block; margin-top: var(--s3, 12px); }
    /* 四个按钮平分一行：等宽、撑满、文字居中。
       注意 flex-basis 必须是 0，否则长标签会把这一行撑歪。 */
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
    .pc-lx-row .t b { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
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
    .pc-lx-badge.on {
      background: color-mix(in srgb, var(--green, #4cc96a) 18%, var(--panel));
      border-color: color-mix(in srgb, var(--green, #4cc96a) 45%, transparent);
      color: var(--text);
    }
    .pc-lx-del { padding: 0 10px; height: 30px; min-height: 30px; font-size: var(--fs-caption, 14px); }
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
    settings: { keepActive: true, shinyEgg: true },
    scripts: [],
    showUrl: false,
    appVer: '',
  };

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

  // 用游戏自己的 toast（#toasts + .toast），保持观感一致
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
    return s.length > 56 ? s.slice(0, 34) + '…' + s.slice(-19) : s;
  }
  // ---------- 页面片段 ----------
  function switchRow(key, title, desc, on) {
    return `<div class="op-row${on ? ' on' : ''}" data-pc-sw="${key}" role="switch" aria-checked="${on ? 'true' : 'false'}" tabindex="0">
      <span class="t"><b>${esc(title)}</b><small>${esc(desc)}</small></span><span class="op-sw"></span>
    </div>`;
  }

  function scriptRow(s) {
    const badges = [];
    if (s.version) badges.push(`<span class="pc-lx-badge">v${esc(s.version)}</span>`);
    const meta = [];
    if (s.mtime) meta.push('更新于 ' + fmtTime(s.mtime));
    if (s.sourceUrl) meta.push(shortUrl(s.sourceUrl));
    return `<div class="op-row op-static pc-lx-row">
      <span class="t">
        <b>${esc(s.name)}${badges.join('')}</b>
        <small>${esc(meta.join(' · '))}</small>
      </span>
      <button class="btn small ghost pc-lx-del" data-pc="del" data-name="${esc(s.name)}">删除</button>
    </div>`;
  }

  // 「游戏 / 油猴脚本 / 关于」三块（追加在「通用」页原生内容下面）
  function sectionsHTML() {
    const s = state.settings;
    const scripts = state.scripts || [];

    const scriptsBody = scripts.length
      ? scripts.map(scriptRow).join('')
      : '<div class="pc-lx-empty">还没有导入脚本</div>';

    return `<div class="op-group">
        <h5>游戏</h5>
        <div class="op-card">
          ${switchRow('keepActive', '最小化时保持在线', '最小化或被遮挡时，游戏不会判定你离开，也不结算离线进度', s.keepActive !== false)}
          ${switchRow('shinyEgg', '提前显示异色蛋', '培育屋的蛋按存档直接判定并标出异色（只读存档，不改任何数据）', s.shinyEgg !== false)}
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
          <div class="op-row op-static">
            <span class="t"><b>Poke'Catch 启动器</b><small>${state.appVer ? 'v' + esc(state.appVer) + ' · ' : ''}作者：梓贱 · 设置已并入游戏设置面板</small></span>
          </div>
          <div class="op-row op-static">
            <span class="t"><b>快捷键</b><small><kbd>F11</kbd> 全屏 · <kbd>F12</kbd> 打开 / 关闭这个面板</small></span>
          </div>
        </div>
      </div>`;
  }

  // ---------- 数据 ----------
  async function refreshSettings() {
    try {
      const s = await L.getSettings();
      state.settings = {
        keepActive: !s || s.keepActive !== false,
        shinyEgg: !s || s.shinyEgg !== false,
      };
    } catch (_) {}
  }
  async function refreshScripts() {
    try { state.scripts = (await L.readScripts()) || []; } catch (_) { state.scripts = []; }
  }

  function hostEl() {
    return document.querySelector(`.opt-modal .gd-page #${HOST_ID}`);
  }

  // 当前是否停在「通用」Tab（游戏的 data-p 是 general）
  function onGeneralTab() {
    const nav = document.querySelector('.opt-modal .gd-nav');
    return !!(nav && nav.querySelector(`[data-p="${GENERAL}"].on`));
  }

  // 重新渲染我们那段（只在它已经挂着的时候动 DOM）
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

  // 关掉设置面板（导入/更新后要先收起，再弹启动器的刷新提示）
  async function closePanel() {
    const clickX = () => {
      const m = document.querySelector('.opt-modal');
      const x = m && m.querySelector('.dc-x');
      if (x) { try { x.click(); } catch (_) {} }
    };
    clickX();
    // 万一还有排队中的 open()，关掉后会立刻再弹出来，这里多关几次
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
    // 开关
    host.querySelectorAll('[data-pc-sw]').forEach((row) => {
      const toggle = () => {
        const key = row.getAttribute('data-pc-sw');
        const on = !row.classList.contains('on');
        row.classList.toggle('on', on);
        row.setAttribute('aria-checked', on ? 'true' : 'false');
        state.settings[key] = on;
        // 异色蛋预览：设置页只管开关，判定/标记的活在 shiny-egg.user.js 里
        if (key === 'shinyEgg' && window.__pcShinyEggPreview) {
          try { window.__pcShinyEggPreview.set(on); } catch (_) {}
        }
        Promise.resolve(L.saveSettings({ ...state.settings })).then((ok) => {
          if (ok === false) toast('保存失败');
          else if (key === 'keepActive') toast(on ? '最小化时保持在线' : '最小化时将按离线处理');
          else if (key === 'shinyEgg') toast(on ? '已开启异色蛋预览' : '已关闭异色蛋预览');
        }).catch(() => toast('保存失败'));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
      });
    });

    const act = (name) => host.querySelector(`[data-pc="${name}"]`);

    // 导入脚本（文件）
    act('import') && (act('import').onclick = async () => {
      const picked = await L.pickScriptFile();
      if (!picked || !picked.ok || !picked.items || !picked.items.length) {
        if (picked && picked.failed && picked.failed.length) toast('导入失败：' + picked.failed[0].error);
        return;
      }
      const items = picked.items;
      await refreshScripts();
      await promptRefresh('import', items);
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
      if (!/^https?:\/\//i.test(url)) return toast('链接需以 http(s):// 开头');
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

    // 检查全部更新
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
      btn.textContent = '检查中…';
      btn.disabled = true;
      const updated = [];
      const failed = [];
      let current = 0;
      let latestVer = '';
      for (const s of withUrl) {
        const res = await L.checkScriptUpdate(s.name);
        if (!res || !res.ok) {
          // 以前这里直接 continue，下载超时 / 404 全都无声吞掉，
          // 表现就是「点了没反应、也检测不到」。
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
    act('openDir') && (act('openDir').onclick = () => { try { L.openScriptsDir(); } catch (_) {} });

    // 删除脚本
    host.querySelectorAll('[data-pc="del"]').forEach((btn) => {
      btn.onclick = async () => {
        const name = btn.getAttribute('data-name');
        if (!name) return;
        const res = await L.deleteScript(name);
        if (res && res.ok) { toast('已删除 ' + name); await refreshScripts(); render(); }
        else toast('删除失败：' + ((res && res.error) || '未知错误'));
      };
    });
  }

  // ---------- 注入到「通用」页 ----------
  // 不占 Tab：把三块追加到「通用」页 .op-page 的最后。
  // 游戏切 Tab / 改设置都会重建 .gd-page，所以这里每 600ms 兜一次。
  function syncSections() {
    ensureStyle();
    const modal = document.querySelector('.opt-modal');
    if (!modal) return;
    const page = modal.querySelector('.gd-page');
    if (!page || !onGeneralTab()) return;
    const host0 = page.querySelector('.op-page');
    if (!host0) return;
    if (page.querySelector(`#${HOST_ID}`)) return;   // 已经在
    const wrap = document.createElement('div');
    wrap.id = HOST_ID;
    wrap.className = 'pc-lx';
    wrap.innerHTML = sectionsHTML();
    host0.appendChild(wrap);
    bindSections(wrap);
  }

  // 切到「通用」Tab（已经在就不动，避免无谓重建）
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

  // 主进程用这两个函数响应 F12（打开 / 关闭）
  async function openSettings() {
    ensureStyle();
    ensureRootObserver();
    const hasModal = () => !!document.querySelector('.opt-modal');
    const rootOpen = () => {
      const r = document.getElementById('modal-root');
      return !!(r && r.classList.contains('open'));
    };
    // 别的弹窗（教程/提示/开场）还开着时，游戏的 open() 会被排进队列，
    // 先等它自己消失再点，免得点出一个「排在后面」的重复面板
    for (let attempt = 0; attempt < 3 && !hasModal(); attempt++) {
      for (let i = 0; i < 25 && !hasModal() && rootOpen(); i++) await sleep(80);
      if (hasModal()) break;
      const gear = document.querySelector('#options-btn');
      if (gear && typeof gear.onclick === 'function') { try { gear.click(); } catch (_) {} }
      // 游戏冷启动时 open() 可能要 1s 以上才渲染；2s 还没出来就再点一次
      for (let i = 0; i < 25 && !hasModal(); i++) await sleep(80);
    }
    if (!hasModal()) return false;
    // 游戏 open() 之后还会异步重渲染默认页，把我们注入的那段盖掉，
    // 所以这里多断言几轮，直到「通用」页上稳定挂着我们的三块
    for (let i = 0; i < 20; i++) {
      if (!document.querySelector('.opt-modal')) return false;
      if (selectGeneral() && i >= 4) break;
      await sleep(70);
    }
    // 不给面板做任何滚动：设置一打开就停在最上面（用户明确要求别自动往下滚）
    const page = document.querySelector('.opt-modal .gd-page');
    if (page) page.scrollTop = 0;
    return !!hostEl();
  }

  window.__pcOpenLauncherTab = function () { return openSettings(); };
  window.__pcOpenLauncherSettings = window.__pcOpenLauncherTab;

  // F12：面板开着且正停在「通用」（能看到我们这段）就收起，否则打开并切过去
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
  try {
    Promise.resolve(L.appInfo && L.appInfo())
      .then((info) => { state.appVer = (info && info.version) || ''; if (hostEl()) render(); })
      .catch(() => {});
  } catch (_) {}
  refreshScripts();

  // 面板内部变化由观察器驱动；低频定时器只负责发现游戏替换了 #modal-root 本身。
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

  // 启动自检在后台更新了脚本：列表跟着刷新
  if (typeof L.onScriptsUpdated === 'function') {
    const unsubscribe = L.onScriptsUpdated(async () => {
      await refreshScripts();
      if (hostEl()) { render(); toast('脚本已在后台更新'); }
    });
    window.addEventListener('pagehide', unsubscribe, { once: true });
  }
})();
