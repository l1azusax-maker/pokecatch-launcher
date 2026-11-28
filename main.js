const { app, BrowserWindow, WebContentsView, session, shell, ipcMain, Menu, Tray, nativeImage, nativeTheme, dialog, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { isSecureScriptUrl, safeScriptName } = require('./lib/script-utils');
const { mapLimit } = require('./lib/concurrency');
const { setupAppUpdater } = require('./lib/app-updater');
const { writeJsonAtomicSync, readJsonSafeSync } = require('./lib/fs-atomic');
const {
  GAME_URL,
  POPUP_ALLOW_HOSTS,
  isHttpUrl,
  hostAllowed,
  isGameUrl,
  isSupabaseAuthorizeUrl,
  createNavigationPolicy,
} = require('./lib/url-policy');
const {
  loadSettings: loadSettingsFromDisk,
  saveSettings: saveSettingsToDisk,
  sanitizeTheme,
} = require('./lib/settings-store');
const { createAuthBridge } = require('./lib/auth-bridge');
const { createScriptManager, MAX_SCRIPT_BYTES } = require('./lib/script-manager');
const { createMemoryManager, sumProcessMemoryKB } = require('./lib/memory-manager');
const { createTrayFlasher, buildTooltip } = require('./lib/tray-alert');

// ============ 调试日志（置于顶部，避免启动阶段调用触发 TDZ） ============
let debugLogBuffer = [];
let debugLogTimer = null;

function flushDebugLog() {
  debugLogTimer = null;
  if (debugLogBuffer.length === 0) return;
  const chunk = debugLogBuffer.join('');
  debugLogBuffer = [];
  fs.promises.appendFile(path.join(os.tmpdir(), 'pc-debug.log'), chunk, 'utf8')
    .catch((err) => console.error('[debug-log] 写入失败', err && err.message ? err.message : err));
}

function flushDebugLogSync() {
  if (debugLogTimer) { clearTimeout(debugLogTimer); debugLogTimer = null; }
  if (debugLogBuffer.length === 0) return;
  const chunk = debugLogBuffer.join('');
  debugLogBuffer = [];
  try { fs.appendFileSync(path.join(os.tmpdir(), 'pc-debug.log'), chunk, 'utf8'); } catch (_) {}
}

function dbg(...args) {
  if (process.env.PC_DEBUG !== '1') return;
  try {
    debugLogBuffer.push(new Date().toISOString() + ' '
      + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
    if (!debugLogTimer) debugLogTimer = setTimeout(flushDebugLog, 100);
  } catch (_) {}
}

// ============ 轻量优化开关 ============
const CONFIG = {
  gameUrl: GAME_URL,
  disableHardwareAcceleration: false,
};

CONFIG.disableHardwareAcceleration = process.argv.includes('--disable-gpu')
  && !process.argv.includes('--enable-gpu');
if (CONFIG.disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// 防止 Windows 后台挂机被 Chromium 遮挡冻结（CalculateNativeWinOcclusion）
// 以及刷新后整页旧 DOM 滞留内存（BackForwardCache）；
// 不强行压低 V8 --max-old-space-size，避免挂机久了触顶引发连续 Full GC 假死。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,BackForwardCache');
app.commandLine.appendSwitch('disk-cache-size', String(100 * 1024 * 1024));

// ============ UA 伪装成普通 Chrome ============
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

if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.pokecatch.launcher'); } catch (_) {}
  dbg('[app] AppUserModelID =', (() => { try { return app.getName(); } catch (_) { return '?'; } })());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

process.on('uncaughtExceptionMonitor', (err) => {
  try { console.error('[main] uncaughtException', err && err.stack ? err.stack : err); } catch (_) {}
});

// ============ 全局状态 ============
let mainWindow = null;
let gameView = null;
let tray = null;
let isQuitting = false;
let gameReady = false;
let gameReadyTimer = null;
let gameReadyRun = 0;
let appUpdaterController = null;

const navigationPolicy = createNavigationPolicy();
const scriptRunStatus = new Map();

function gameWC() {
  try {
    if (!gameView) return null;
    const wc = gameView.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  } catch (_) { return null; }
}

// ============ 设置持久化 ============
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settingsCache = null;

function loadSettings() {
  if (!settingsCache) {
    settingsCache = loadSettingsFromDisk(settingsPath());
  }
  return { ...settingsCache };
}

function persistSettings(nextPartial) {
  const merged = { ...loadSettings(), ...(nextPartial || {}) };
  const result = saveSettingsToDisk(settingsPath(), merged);
  if (result.ok) {
    settingsCache = result.settings;
  }
  return result;
}

// ============ 下载 URL 内容（供脚本导入与更新检测） ============
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

const scriptManager = createScriptManager({
  getUserDataDir: () => app.getPath('userData'),
  fetchUrl,
});

// ============ 深度内存管理与视图唤醒 ============
let memoryManager = null;
let gameMemoryHandle = null;
let pendingCleanNotice = false;

function isMainWindowBackgrounded() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMinimized() || !mainWindow.isVisible();
}

function isMainWindowForeground() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
}

function showGameToast(msg) {
  const wc = gameWC();
  if (!wc || !isGameUrl(wc.getURL())) return;
  const text = JSON.stringify(String(msg || ''));
  wc.executeJavaScript(`(function () {
    try {
      var host = document.getElementById('toasts');
      if (!host) return;
      var el = document.createElement('div');
      el.className = 'toast';
      el.textContent = ${text};
      host.appendChild(el);
      setTimeout(function () {
        el.classList.add('out');
        setTimeout(function () { try { el.remove(); } catch (_) {} }, 320);
      }, 2400);
    } catch (_) {}
  })()`).catch(() => {});
}

let wakeTimer = null;
function wakeGameView({ focusGame = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
  const doWake = () => {
    if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
    try {
      if (typeof gameView.setVisible === 'function') gameView.setVisible(true);
    } catch (_) {}
    flushGameViewLayout();
    const wc = gameWC();
    if (!wc) return;
    try { wc.setBackgroundThrottling(!(loadSettings().keepActive !== false)); } catch (_) {}
    if (focusGame) {
      try { wc.focus(); } catch (_) {}
    }
    if (isGameUrl(wc.getURL())) {
      wc.executeJavaScript('(function(){try{window.dispatchEvent(new Event("resize"));}catch(_){}})()').catch(() => {});
    }
  };
  doWake();
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    doWake();
  }, 120);
}

async function refreshAndCleanMemory() {
  const wc = gameWC();
  if (!wc) return;
  pendingCleanNotice = true;
  if (memoryManager) {
    try {
      await memoryManager.runSafeGc(wc, { reason: 'refresh-clean', force: true, clearCodeCache: true });
    } catch (_) {}
  }
  reloadGamePage();
}

// ============ 游戏视图布局与多屏最大化裁剪 ============
const MIN_W = 615;
const MIN_H = 480;
const PC_TB = 36;

let viewLayoutTimer = null;

function syncGameViewSize(w, h) {
  if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
  try {
    const top = isFullscreenNow(mainWindow) ? 0 : PC_TB;
    const bw = Math.max(1, Math.round(w));
    const bh = Math.max(1, Math.round(h) - top);
    const cur = (() => { try { return gameView.getBounds(); } catch (_) { return null; } })();
    if (cur && cur.x === 0 && cur.y === top && cur.width === bw && cur.height === bh) return;
    gameView.setBounds({ x: 0, y: top, width: bw, height: bh });
    dbg('[view] sync', `${bw}x${bh}`, 'top', top);
  } catch (_) {}
}

function layoutGameView() {
  if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
  if (viewLayoutTimer) return;
  viewLayoutTimer = setTimeout(() => {
    viewLayoutTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
    try {
      const [w, h] = mainWindow.getContentSize();
      syncGameViewSize(w, h);
    } catch (_) {}
  }, 0);
}

function flushGameViewLayout() {
  if (viewLayoutTimer) { clearTimeout(viewLayoutTimer); viewLayoutTimer = null; }
  if (!mainWindow || mainWindow.isDestroyed() || !gameView) return;
  try {
    const [w, h] = mainWindow.getContentSize();
    syncGameViewSize(w, h);
  } catch (_) {}
}

let lastShapeSig = '';

function setWindowShapeRects(win, rects) {
  const sig = rects.length + '|' + rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join(';');
  if (sig === lastShapeSig) return;
  lastShapeSig = sig;
  try { win.setShape(rects); } catch (_) {}
}

function clearWindowShape(win) {
  if (lastShapeSig === '' || lastShapeSig === 'none') {
    lastShapeSig = 'none';
    return;
  }
  lastShapeSig = 'none';
  try { win.setShape([]); } catch (_) {}
}

function hasMultipleDisplays() {
  try { return screen.getAllDisplays().length > 1; } catch (_) { return true; }
}

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

    const cb = (() => { try { return win.getContentBounds(); } catch (_) { return null; } })();
    if (cb && cb.width >= 1 && cb.height >= 1) {
      const offX = cb.x - b.x;
      const offY = cb.y - b.y;
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

// ============ 脚本注入引擎（内置篡改猴） ============
const builtinScriptCache = new Map();

async function readBuiltinScript(filePath) {
  if (builtinScriptCache.has(filePath)) return builtinScriptCache.get(filePath);
  const code = await fs.promises.readFile(filePath, 'utf-8');
  builtinScriptCache.set(filePath, code);
  return code;
}

function executeInjectedScript(wc, code) {
  return wc.executeJavaScript(String(code) + '\n;void 0;');
}

async function injectScripts(wc) {
  if (!wc || wc.isDestroyed()) return;
  const builtinDir = path.join(__dirname, 'scripts');
  const builtinFiles = ['launcher-tab.user.js', 'shiny-egg.user.js', 'underground-loot.user.js', 'builtin-optimize.user.js'];
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

  scriptRunStatus.clear();
  try {
    const files = await scriptManager.listInjectableScripts();
    for (const f of files) {
      const code = await fs.promises.readFile(path.join(scriptManager.scriptsDir(), f), 'utf-8');
      if (wc.isDestroyed()) return;
      try {
        await executeInjectedScript(wc, code);
        scriptRunStatus.set(f, { ok: true, error: '' });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err || '执行失败');
        scriptRunStatus.set(f, { ok: false, error: msg });
        console.error('[scripts] 用户脚本注入失败', f, msg);
      }
    }
  } catch (err) {
    console.error('[scripts] 枚举用户脚本失败', err && err.message ? err.message : err);
  }
}

// ============ 滚动条外观与深色主题 ============
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

const scrollbarSkinKeys = new WeakMap();
async function applyScrollbarSkin(wc) {
  if (!wc) return;
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

function currentTheme() {
  return sanitizeTheme(loadSettings().theme);
}

function themeColors(theme = currentTheme()) {
  return theme === 'light'
    ? { windowBg: '#e8ecf4', panelBg: '#ffffff' }
    : { windowBg: '#141826', panelBg: '#1c2030' };
}

function applyLauncherTheme(theme) {
  const next = sanitizeTheme(theme);
  const { windowBg, panelBg } = themeColors(next);
  try { nativeTheme.themeSource = next; } catch (_) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setBackgroundColor(windowBg); } catch (_) {}
    try { mainWindow.setAccentColor(windowBg); } catch (_) {}
    try { mainWindow.contentView.setBackgroundColor(windowBg); } catch (_) {}
  }
  if (gameView) {
    try { gameView.setBackgroundColor(windowBg); } catch (_) {}
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    try { trayMenuWindow.setBackgroundColor(panelBg); } catch (_) {}
  }
  broadcastShellState();
  syncTrayMenuState();
}

function setGameTheme(nextTheme) {
  const normalized = sanitizeTheme(nextTheme);
  if (currentTheme() === normalized) {
    applyLauncherTheme(normalized);
    return;
  }
  persistSettings({ theme: normalized });
  applyLauncherTheme(normalized);
  dbg('[theme] synced launcher theme =', normalized);
}

// 尊重游戏自身设置的深色 / 浅色主题，仅补充深色模式下的原生控件 color-scheme，
// 并把当前解析的主题回报给主进程，让标题栏、托盘菜单与弹窗实时跟随切换。
function applyThemeToGame(wc) {
  if (!wc) return;
  const code = `
    (function () {
      try {
        var h = document.documentElement;
        var resolved = (window.Theme && typeof window.Theme.resolved === 'function')
          ? window.Theme.resolved()
          : (h && h.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
        var isLight = resolved === 'light' || (h && h.getAttribute('data-theme') === 'light');
        if (h) {
          if (isLight) h.style.removeProperty('color-scheme');
          else h.style.setProperty('color-scheme', 'dark');
        }
        return isLight ? 'light' : 'dark';
      } catch (e) { return 'dark'; }
    })();
  `;
  wc.executeJavaScript(code)
    .then((theme) => setGameTheme(theme))
    .catch(() => {});
  applyScrollbarSkin(wc);
}

// ============ 帧率计（PC_FPS=1 时注入） ============
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

// ============ 最小化 / 遮挡时保持「在线」、静音、置顶 ============
function applyKeepActive(wc, settings) {
  if (!wc) return;
  const on = (settings || loadSettings()).keepActive !== false;
  try {
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

function applyAudioMute(wc, settings) {
  if (!wc || wc.isDestroyed()) return;
  const muted = !!(settings || loadSettings()).muted;
  try { wc.setAudioMuted(muted); } catch (_) {}
}

const USER_PIN_LEVEL = 'screen-saver';
const WM_WINDOWPOSCHANGED = 0x0047;

let pinWatchTimer = null;
let pinBlurTimer = null;
let pinRestoring = false;

function stopPinWatch() {
  if (pinWatchTimer) { clearInterval(pinWatchTimer); pinWatchTimer = null; }
  if (pinBlurTimer) { clearTimeout(pinBlurTimer); pinBlurTimer = null; }
}

function shouldGuardUserPin(win) {
  if (!win || win.isDestroyed() || fsState) return false;
  if (!loadSettings().alwaysOnTop) return false;
  if (!win.isVisible() || win.isMinimized()) return false;
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) return false;
  if (noticeWindow && !noticeWindow.isDestroyed() && noticeWindow.isVisible()) return false;
  if (authBridge.isActive()) return false;
  return true;
}

// 微信/QQ 等第三方截图工具可能会对 WS_EX_TOPMOST 窗口调用 SetWindowPos(HWND_BOTTOM/HWND_NOTOPMOST)，
// 直接把窗口压到最底层并剥离置顶标志。
// 在 Electron(Win32) 中，外部把窗口压到 HWND_BOTTOM 后仅调用 setAlwaysOnTop(true, level) 会被内部状态缓存跳过，
// 必须执行 false -> moveTop() -> true(screen-saver) 才能不抢焦点地把窗口立刻拉回置顶层。
function forceRestoreAlwaysOnTop(win, level = USER_PIN_LEVEL) {
  if (!win || win.isDestroyed() || pinRestoring) return;
  pinRestoring = true;
  try {
    win.setAlwaysOnTop(false);
    win.moveTop();
    win.setAlwaysOnTop(true, level);
  } catch (_) {} finally {
    pinRestoring = false;
  }
}

function installTopmostWindowHook(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  if (typeof win.hookWindowMessage !== 'function') return;
  try {
    win.hookWindowMessage(WM_WINDOWPOSCHANGED, () => {
      if (pinRestoring || !win || win.isDestroyed()) return;
      const needFs = !!(fsState && !fsTopmostSuspended && win.isVisible() && !win.isMinimized());
      const needPin = !needFs && shouldGuardUserPin(win);
      if (!needFs && !needPin) return;
      let isTop = true;
      try { isTop = win.isAlwaysOnTop(); } catch (_) { return; }
      if (isTop) return;
      pinRestoring = true;
      setTimeout(() => {
        try {
          if (!win || win.isDestroyed()) return;
          const stillNeedFs = !!(fsState && !fsTopmostSuspended && win.isVisible() && !win.isMinimized());
          const stillNeedPin = !stillNeedFs && shouldGuardUserPin(win);
          if (!stillNeedFs && !stillNeedPin) return;
          if (!win.isAlwaysOnTop()) {
            win.setAlwaysOnTop(false);
            win.moveTop();
            win.setAlwaysOnTop(true, USER_PIN_LEVEL);
          }
        } catch (_) {} finally {
          pinRestoring = false;
        }
      }, 0);
    });
  } catch (err) {
    dbg('[pin] hookWindowMessage failed', err && err.message ? err.message : String(err));
  }
}

function reassertUserAlwaysOnTop(win) {
  if (!shouldGuardUserPin(win)) return;
  try {
    if (!win.isAlwaysOnTop()) {
      forceRestoreAlwaysOnTop(win, USER_PIN_LEVEL);
    }
  } catch (_) {}
}

function startPinWatch(win) {
  stopPinWatch();
  if (!win || win.isDestroyed()) return;
  pinWatchTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !loadSettings().alwaysOnTop) {
      stopPinWatch();
      return;
    }
    if (!shouldGuardUserPin(mainWindow)) return;
    try {
      if (!mainWindow.isAlwaysOnTop()) {
        forceRestoreAlwaysOnTop(mainWindow, USER_PIN_LEVEL);
      }
    } catch (_) {}
  }, 1000);
  if (typeof pinWatchTimer.unref === 'function') pinWatchTimer.unref();
}

function schedulePinReassertOnBlur(win) {
  if (pinBlurTimer) { clearTimeout(pinBlurTimer); pinBlurTimer = null; }
  if (!shouldGuardUserPin(win)) return;
  pinBlurTimer = setTimeout(() => {
    pinBlurTimer = null;
    reassertUserAlwaysOnTop(win);
  }, 150);
  if (typeof pinBlurTimer.unref === 'function') pinBlurTimer.unref();
}

function applyAlwaysOnTop(win, settings) {
  if (!win || win.isDestroyed()) return;
  if (fsState) return;
  const on = !!(settings || loadSettings()).alwaysOnTop;
  try {
    if (on) {
      win.setAlwaysOnTop(true, USER_PIN_LEVEL);
      if (!win.isAlwaysOnTop()) forceRestoreAlwaysOnTop(win, USER_PIN_LEVEL);
    } else {
      win.setAlwaysOnTop(false);
    }
  } catch (_) {}
  if (on) {
    startPinWatch(win);
  } else {
    stopPinWatch();
  }
}

function getShellStateSnapshot() {
  const s = loadSettings();
  return {
    alwaysOnTop: !!s.alwaysOnTop,
    muted: !!s.muted,
    theme: sanitizeTheme(s.theme),
  };
}

function broadcastShellState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('shell-state-changed', getShellStateSnapshot()); } catch (_) {}
}

function broadcastSettingsChanged() {
  const wc = gameWC();
  if (wc && isGameUrl(wc.getURL())) {
    try { wc.send('settings-changed', loadSettings()); } catch (_) {}
  }
}

function broadcastAppUpdateState(status) {
  const wc = gameWC();
  if (wc && isGameUrl(wc.getURL())) {
    try { wc.send('app-update-state', status); } catch (_) {}
  }
}

function updateSettingsAndApply(patch, { keepMenuOpen = false } = {}) {
  const prev = loadSettings();
  const saved = persistSettings(patch);
  if (!saved.ok) return saved;
  const next = saved.settings;
  const wc = gameWC();
  if (wc && isGameUrl(wc.getURL())) {
    applyKeepActive(wc, next);
  }
  if (wc) {
    applyAudioMute(wc, next);
  }
  applyAlwaysOnTop(mainWindow, next);

  // 关闭「关闭到托盘」开关时，如果窗口当前正隐藏在托盘，立即恢复显示窗口。
  if (prev.minimizeToTray && !next.minimizeToTray && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    restoreMainWindowFromTray({ keepMenuOpen });
  }

  broadcastShellState();
  broadcastSettingsChanged();
  syncTrayMenuState();
  return saved;
}

// ============ 托盘与启动器风格自绘右键菜单 ============
const TRAY_MENU_W = 206;
const TRAY_MENU_H = 246;
let trayMenuWindow = null;
let trayMenuReady = false;
let trayMenuSuppressBlurUntil = 0;
let trayFlasher = null;

function getTrayMenuState() {
  const s = loadSettings();
  return {
    keepActive: s.keepActive !== false,
    minimizeToTray: !!s.minimizeToTray,
    muted: !!s.muted,
    alwaysOnTop: !!s.alwaysOnTop,
    theme: sanitizeTheme(s.theme),
  };
}

function syncTrayMenuState() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  try { trayMenuWindow.webContents.send('tray-menu-state', getTrayMenuState()); } catch (_) {}
}

function closeTrayMenu() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  try {
    if (trayMenuWindow.isVisible()) trayMenuWindow.hide();
  } catch (_) {}
}

function keepTrayMenuOnTop() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed() || !trayMenuWindow.isVisible()) return;
  try {
    trayMenuWindow.setAlwaysOnTop(true, USER_PIN_LEVEL);
    trayMenuWindow.moveTop();
    trayMenuWindow.focus();
  } catch (_) {}
}

function ensureTrayMenuWindow() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) return trayMenuWindow;
  trayMenuReady = false;
  trayMenuWindow = new BrowserWindow({
    width: TRAY_MENU_W,
    height: TRAY_MENU_H,
    minWidth: TRAY_MENU_W,
    minHeight: TRAY_MENU_H,
    maxWidth: TRAY_MENU_W,
    maxHeight: TRAY_MENU_H,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: themeColors().panelBg,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-tray-menu.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  trayMenuWindow.loadFile(path.join(__dirname, 'assets', 'tray-menu.html'));
  trayMenuWindow.webContents.once('did-finish-load', () => {
    trayMenuReady = true;
    syncTrayMenuState();
  });
  trayMenuWindow.on('blur', () => {
    if (Date.now() < trayMenuSuppressBlurUntil) return;
    closeTrayMenu();
  });
  trayMenuWindow.on('closed', () => {
    trayMenuWindow = null;
    trayMenuReady = false;
  });
  return trayMenuWindow;
}

function openTrayMenuAtCursor() {
  const win = ensureTrayMenuWindow();
  if (!win || win.isDestroyed()) return;

  const cursor = (() => {
    try { return screen.getCursorScreenPoint(); } catch (_) { return { x: 0, y: 0 }; }
  })();
  const disp = (() => {
    try { return screen.getDisplayNearestPoint(cursor); } catch (_) { return screen.getPrimaryDisplay(); }
  })();
  const wa = (disp && disp.workArea) || { x: 0, y: 0, width: 1280, height: 720 };

  let x = cursor.x;
  let y = cursor.y + 4;
  if (y + TRAY_MENU_H > wa.y + wa.height) {
    y = cursor.y - TRAY_MENU_H - 4;
  }
  if (x + TRAY_MENU_W > wa.x + wa.width) {
    x = cursor.x - TRAY_MENU_W;
  }
  x = Math.max(wa.x + 4, Math.min(wa.x + wa.width - TRAY_MENU_W - 4, Math.round(x)));
  y = Math.max(wa.y + 4, Math.min(wa.y + wa.height - TRAY_MENU_H - 4, Math.round(y)));

  const showNow = () => {
    if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
    syncTrayMenuState();
    try {
      trayMenuWindow.setBounds({ x, y, width: TRAY_MENU_W, height: TRAY_MENU_H });
      trayMenuWindow.setAlwaysOnTop(true, USER_PIN_LEVEL);
      trayMenuWindow.show();
      trayMenuWindow.moveTop();
      trayMenuWindow.focus();
    } catch (_) {}
  };

  if (trayMenuReady) showNow();
  else win.webContents.once('did-finish-load', showNow);
}

function createTrayIcon() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  const target = process.platform === 'win32' && fs.existsSync(icoPath) ? icoPath : pngPath;
  const img = nativeImage.createFromPath(target);
  return img.isEmpty() ? nativeImage.createFromPath(pngPath) : img;
}

function updateTrayAlertState(payload) {
  if (trayFlasher) trayFlasher.update(payload);
}

function restoreMainWindowFromTray({ keepMenuOpen = false } = {}) {
  if (!keepMenuOpen) closeTrayMenu();
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (keepMenuOpen) {
    trayMenuSuppressBlurUntil = Date.now() + 450;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (typeof mainWindow.showInactive === 'function') mainWindow.showInactive();
    else mainWindow.show();
    wakeGameView({ focusGame: false });
    keepTrayMenuOnTop();
    setTimeout(keepTrayMenuOnTop, 60);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  wakeGameView();
}

function showMainWindowFromTray() {
  restoreMainWindowFromTray({ keepMenuOpen: false });
}

function hideMainWindowToTray() {
  closeTrayMenu();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isFullscreenNow(mainWindow)) exitFullscreen(mainWindow);
  mainWindow.hide();
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  try {
    const baseIcon = createTrayIcon();
    tray = new Tray(baseIcon);
    tray.setToolTip(buildTooltip());
    trayFlasher = createTrayFlasher({
      tray,
      normalIcon: baseIcon,
      nativeImage,
      isWindowForeground: () => isMainWindowForeground(),
      dbg,
    });
    ensureTrayMenuWindow();
    tray.on('click', () => {
      if (trayFlasher) trayFlasher.acknowledgeCurrent();
      closeTrayMenu();
      if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.focus();
        wakeGameView();
      } else {
        showMainWindowFromTray();
      }
    });
    tray.on('double-click', () => {
      if (trayFlasher) trayFlasher.acknowledgeCurrent();
      showMainWindowFromTray();
    });
    tray.on('right-click', () => {
      if (trayFlasher) trayFlasher.acknowledgeCurrent();
      openTrayMenuAtCursor();
    });
  } catch (err) {
    dbg('[tray] init failed', err && err.message ? err.message : String(err));
  }
  return tray;
}

// ============ 窗口标题栏控制 ============
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
let fsState = null;
let fsTopmostSuspended = false;
let fsTopmostTimer = null;

function isFullscreenNow(win) {
  if (!win || win.isDestroyed()) return false;
  return !!fsState || win.isFullScreen();
}

function fullscreenTargetBounds(win) {
  let d = null;
  try { d = screen.getDisplayMatching(win.getBounds()); } catch (_) {}
  if (!d) { try { d = screen.getPrimaryDisplay(); } catch (_) {} }
  const b = (d && d.bounds) || { x: 0, y: 0, width: 1280, height: 720 };
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

function stopFsTopmostWatch() {
  if (fsTopmostTimer) { clearInterval(fsTopmostTimer); fsTopmostTimer = null; }
}

function startFsTopmostWatch(win) {
  stopFsTopmostWatch();
  fsTopmostTimer = setInterval(() => {
    if (!fsState || fsTopmostSuspended || !win || win.isDestroyed()) { stopFsTopmostWatch(); return; }
    try {
      if (!win.isAlwaysOnTop()) forceRestoreAlwaysOnTop(win, USER_PIN_LEVEL);
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

function enterFullscreen(win) {
  if (!win || win.isDestroyed() || isFullscreenNow(win)) return;
  const target = fullscreenTargetBounds(win);

  fsState = {
    bounds: (() => { try { return win.getNormalBounds(); } catch (_) { return null; } })(),
    maximized: win.isMaximized(),
    keptMaximized: false,
  };

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
    applyMaximizedClip();
    setTimeout(() => { if (fsState) flushGameViewLayout(); }, 120);
    notifyMaximizeState(win);
    return;
  }

  if (win.isMaximized()) {
    try { win.setMinimumSize(1, 1); } catch (_) {}
    try { win.unmaximize(); } catch (_) {}
  }
  try { win.setMinimumSize(1, 1); } catch (_) {}
  try { win.setBounds(target); } catch (_) {}
  flushGameViewLayout();
  setShellFullscreen(true);
  setFullscreenTopmost(win, true);
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
  fsTopmostSuspended = false;
  if (win.isFullScreen()) { try { win.setFullScreen(false); } catch (_) {} }
  applyAlwaysOnTop(win);

  if (st) {
    try { win.setMinimumSize(MIN_W, MIN_H + PC_TB); } catch (_) {}

    const normalTarget = st.bounds ? {
      x: Math.round(st.bounds.x),
      y: Math.round(st.bounds.y),
      width: Math.max(MIN_W, Math.round(st.bounds.width)),
      height: Math.max(MIN_H + PC_TB, Math.round(st.bounds.height)),
    } : null;

    setShellFullscreen(false);

    if (st.keptMaximized) {
      dbg('[fs] exit fullscreen keeping maximized geometry');
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(); }, 260);
      notifyMaximizeState(win);
    } else if (st.maximized) {
      try {
        if (normalTarget) win.setBounds(normalTarget);
        win.maximize();
        dbg('[fs] restore maximized', win.getBounds(), 'isMax', win.isMaximized());
      } catch (_) {}
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(); }, 260);
      notifyMaximizeState(win);
    } else if (normalTarget) {
      try { win.setBounds(normalTarget); } catch (_) {}
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(); }, 260);
      notifyMaximizeState(win);
      saveWindowStateSoon();
    } else {
      setShellFullscreen(false);
      setTimeout(flushGameViewLayout, 32);
      setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(); }, 260);
      notifyMaximizeState(win);
    }
  }
}

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  if (isFullscreenNow(win)) exitFullscreen(win);
  else enterFullscreen(win);
}

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

function notifyMaximizeState(win) {
  if (!win || win.isDestroyed()) return;
  const isMax = win.isMaximized() || isFullscreenNow(win);
  try { win.webContents.send('window-maximized', isMax); } catch (_) {}
}

// ============ 页面刷新与离线兜底 ============
const pendingGameReloads = new WeakSet();

function loadGameUrl(targetUrl) {
  const wc = gameWC();
  if (!wc) return;
  try { wc.loadURL(targetUrl || CONFIG.gameUrl); } catch (err) { dbg('[game] loadURL failed', err.message); }
}

function reloadGamePage() {
  const wc = gameWC();
  if (!wc || pendingGameReloads.has(wc)) return;
  if (!isGameUrl(wc.getURL())) {
    loadGameUrl(CONFIG.gameUrl);
    return;
  }
  pendingGameReloads.add(wc);

  const allowUnload = (event) => event.preventDefault();
  const cleanup = () => {
    clearTimeout(timeout);
    wc.removeListener('will-prevent-unload', allowUnload);
    wc.removeListener('did-stop-loading', cleanup);
    wc.removeListener('destroyed', cleanup);
    pendingGameReloads.delete(wc);
  };
  const timeout = setTimeout(cleanup, 4000);
  timeout.unref();
  wc.once('will-prevent-unload', allowUnload);
  wc.once('did-stop-loading', cleanup);
  wc.once('destroyed', cleanup);
  try {
    wc.reload();
  } catch (err) {
    cleanup();
    dbg('[game] reload failed', err.message);
  }
}

function showOfflineFallback({ code, desc, url }) {
  const wc = gameWC();
  if (!wc) return;
  const payload = {
    code: code || '',
    desc: desc || '',
    url: url || CONFIG.gameUrl,
    theme: currentTheme(),
  };
  try {
    wc.loadFile(path.join(__dirname, 'assets', 'offline.html'), {
      query: { d: JSON.stringify(payload) },
    });
  } catch (err) {
    dbg('[offline] loadFile failed', err && err.message ? err.message : String(err));
  }
}

// 窗口键盘：F5 刷新 / F11 全屏 / F12 设置 / Esc 退出全屏 / Ctrl+M 静音。
function handleWindowKey(event, input) {
  if (input.type !== 'keyDown') return;
  const key = String(input.key || '');
  const lower = key.toLowerCase();

  if (input.control && !input.alt && !input.meta && lower === 'm') {
    event.preventDefault();
    if (!input.isAutoRepeat) updateSettingsAndApply({ muted: !loadSettings().muted });
    return;
  }

  if (key === 'F5') {
    event.preventDefault();
    if (!input.isAutoRepeat) reloadGamePage();
  } else if (key === 'F11') {
    event.preventDefault();
    if (!input.isAutoRepeat) toggleFullscreen(mainWindow);
  } else if (key === 'F12') {
    event.preventDefault();
    if (!input.isAutoRepeat) toggleLauncherSettings();
  } else if (key === 'Escape' && isFullscreenNow(mainWindow)) {
    event.preventDefault();
    exitFullscreen(mainWindow);
  }
}

// ============ 启动 splash（独立窗口） ============
let splashWindow = null;
let splashShownAt = 0;
let restoreMaximized = false;

function createSplashWindow(bounds) {
  splashWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    show: false,
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

  splashWindow.setIgnoreMouseEvents(true);
  splashWindow.loadFile(path.join(__dirname, 'assets', 'splash.html'));
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

// ============ 窗口位置/状态记忆（原子写） ============
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  const s = readJsonSafeSync(windowStatePath(), null);
  if (!s) return null;
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
}

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
    const st = fsState;
    const b = (st && st.bounds) ? st.bounds
      : (() => { try { return mainWindow.getNormalBounds(); } catch (_) { return null; } })();
    if (!b || b.width < 400 || b.height < 300) return;
    writeJsonAtomicSync(windowStatePath(), {
      bounds: { x: b.x, y: b.y, width: b.width, height: Math.max(MIN_H, b.height - PC_TB) },
      maximized: st ? !!st.maximized : mainWindow.isMaximized(),
    });
  } catch (_) {}
}

function saveWindowStateSoon() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(saveWindowStateNow, 400);
}

// ============ 登录桥（OAuth 交系统浏览器） ============
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
    if (isGameUrl(wc.getURL())) {
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

const authBridge = createAuthBridge({
  openExternal: (url) => shell.openExternal(url),
  onBeforeOpen: () => {
    if (fsState && mainWindow && !mainWindow.isDestroyed()) setFullscreenTopmost(mainWindow, false);
  },
  onSuccess: (suffix) => openGameWithAuth(suffix),
  onFailure: (msg) => authFailed(msg),
  dbg,
});

function attachOpenPolicy(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.setWindowOpenHandler(({ url }) => {
    if (isSupabaseAuthorizeUrl(url)) {
      authBridge.start(url);
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
          },
        },
      };
    }
    if (isHttpUrl(url)) {
      try { shell.openExternal(url); } catch (_) {}
    }
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => {
    try { child.webContents.setUserAgent(CLEAN_UA); } catch (_) {}
    attachOpenPolicy(child.webContents);
    if (fsState && mainWindow && !mainWindow.isDestroyed()) setFullscreenTopmost(mainWindow, false);
    try { child.focus(); } catch (_) {}
  });
}

// ============ 主窗口 ============
function onMainWindowClose(event) {
  saveWindowStateNow();
  if (!isQuitting && loadSettings().minimizeToTray) {
    event.preventDefault();
    hideMainWindowToTray();
  }
}

function isGamePage() {
  const wc = gameWC();
  return !!wc && isGameUrl(wc.getURL());
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const DEF_W = Math.max(MIN_W, Math.min(1440, workArea.width - 60));
  const DEF_H = Math.max(MIN_H + PC_TB, Math.min(900 + PC_TB, workArea.height - 60));
  const DEF_X = Math.round(workArea.x + (workArea.width - DEF_W) / 2);
  const DEF_Y = Math.round(workArea.y + (workArea.height - DEF_H) / 2);

  const savedState = readWindowState();
  const savedBounds = savedState && isBoundsVisible(savedState.bounds) ? savedState.bounds : null;
  restoreMaximized = !!(savedState && savedState.maximized);
  const targetArea = (savedBounds ? screen.getDisplayMatching(savedBounds) : screen.getPrimaryDisplay()).workArea;

  let W = DEF_W;
  let H = DEF_H;
  let X = DEF_X;
  let Y = DEF_Y;
  if (savedBounds) {
    W = savedBounds.width;
    H = savedBounds.height;
    X = savedBounds.x;
    Y = savedBounds.y;
  }

  gameReady = false;
  const initialSettings = loadSettings();
  const initialTheme = sanitizeTheme(initialSettings.theme);
  const { windowBg: initialWindowBg } = themeColors(initialTheme);

  mainWindow = new BrowserWindow({
    x: X,
    y: Y,
    width: W,
    height: H,
    minWidth: Math.min(MIN_W, W),
    minHeight: Math.min(MIN_H + PC_TB, H),
    backgroundColor: initialWindowBg,
    accentColor: initialWindowBg,
    roundedCorners: false,
    hasShadow: false,
    frame: false,
    thickFrame: false,
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 标题栏宿主层仅负责 36px 静态顶栏与窗口背板，关闭后台节流防止拉伸时重绘慢一拍露白。
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  try { mainWindow.setBackgroundColor(initialWindowBg); } catch (_) {}
  try { mainWindow.setAccentColor(initialWindowBg); } catch (_) {}
  try { mainWindow.contentView.setBackgroundColor(initialWindowBg); } catch (_) {}
  lastShapeSig = '';
  applyMaximizedClip();
  applyAlwaysOnTop(mainWindow, initialSettings);
  installTopmostWindowHook(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'assets', 'shell.html'), { query: { theme: initialTheme } });

  gameView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !(initialSettings.keepActive !== false),
      spellcheck: false,
    },
  });
  try { mainWindow.contentView.addChildView(gameView); } catch (_) {}
  try { gameView.setBackgroundColor(initialWindowBg); } catch (_) {}
  flushGameViewLayout();

  const gwc = gameWC();
  if (gwc) {
    applyAudioMute(gwc, initialSettings);
    gwc.loadURL(CONFIG.gameUrl);
  }
  dbg('[shell] window+view created, view bounds', gameView ? (() => { try { return gameView.getBounds(); } catch (_) { return '?'; } })() : 'none');

  createSplashWindow(restoreMaximized
    ? { x: targetArea.x, y: targetArea.y, width: targetArea.width, height: targetArea.height }
    : { x: X, y: Y, width: W, height: H });

  if (gwc) {
    if (memoryManager) gameMemoryHandle = memoryManager.scheduleFor(gwc);
    gwc.on('did-finish-load', () => {
      const currentSettings = loadSettings();
      applyAudioMute(gwc, currentSettings);
      dbg('[shell] game did-finish-load, url', (() => { try { return gameWC() && gameWC().getURL(); } catch (_) { return '?'; } })(), 'isGamePage', isGamePage());
      if (!isGamePage()) return;
      applyThemeToGame(gameWC());
      applyKeepActive(gameWC(), currentSettings);
      installFpsMeter(gameWC());
      startGameReadyDetection();
      pageScriptsInjectedAt = Date.now();
      injectScripts(gameWC()).then(() => {
        dbg('[scripts] ordered injection complete');
        if (pendingCleanNotice) {
          pendingCleanNotice = false;
          setTimeout(() => {
            const totalMB = Math.round(sumProcessMemoryKB(app.getAppMetrics()) / 1024);
            showGameToast(totalMB > 0 ? `已刷新并清理内存（当前约 ${totalMB} MB）` : '已刷新并清理内存');
          }, 1200);
        }
      }).catch((err) => {
        console.error('[scripts] 注入流程失败', err && err.stack ? err.stack : err);
      });
    });

    gwc.on('before-input-event', handleWindowKey);
    attachOpenPolicy(gwc);
    gwc.on('will-navigate', (e, url) => {
      if (isSupabaseAuthorizeUrl(url)) {
        e.preventDefault();
        authBridge.start(url);
        return;
      }
      if (navigationPolicy.shouldAllowNavigation(url)) return;
      e.preventDefault();
      if (isHttpUrl(url)) {
        try { shell.openExternal(url); } catch (_) {}
      }
    });

    gwc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) return;
      console.warn('[main] 页面加载失败', code, desc, url);
      if (!String(url || '').startsWith('file:')) {
        showOfflineFallback({ code, desc, url });
      }
      finishSplash();
    });

    gwc.on('render-process-gone', (_e, details) => {
      const reason = details && details.reason ? details.reason : 'unknown';
      console.error('[main] 游戏渲染进程异常退出', reason);
      if (reason === 'clean-exit' || isQuitting) return;
      setTimeout(() => {
        if (!isQuitting && gameWC()) loadGameUrl(CONFIG.gameUrl);
      }, 600);
    });
    gwc.on('unresponsive', () => {
      console.warn('[main] 游戏渲染进程暂时无响应');
      dbg('[game] renderer unresponsive');
    });
    gwc.on('responsive', () => {
      dbg('[game] renderer responsive');
    });
  }

  try { mainWindow.webContents.on('before-input-event', handleWindowKey); } catch (_) {}

  mainWindow.on('maximize', () => {
    notifyMaximizeState(mainWindow); saveWindowStateSoon(); layoutGameView(); applyMaximizedClip();
    setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(); }, 280);
  });
  mainWindow.on('unmaximize', () => {
    notifyMaximizeState(mainWindow); saveWindowStateSoon(); layoutGameView(); applyMaximizedClip();
    setTimeout(() => { flushGameViewLayout(); applyMaximizedClip(); }, 280);
  });
  mainWindow.on('enter-full-screen', () => {
    flushGameViewLayout();
    setShellFullscreen(true);
    notifyMaximizeState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    if (!fsState) { setShellFullscreen(false); setTimeout(flushGameViewLayout, 32); }
    notifyMaximizeState(mainWindow);
  });
  mainWindow.on('blur', () => {
    if (fsState && !fsTopmostSuspended) setFullscreenTopmost(mainWindow, true, { raise: true });
    else if (!fsState) schedulePinReassertOnBlur(mainWindow);
  });
  mainWindow.on('focus', () => {
    if (trayFlasher) trayFlasher.acknowledgeCurrent();
    if (fsState) setFullscreenTopmost(mainWindow, true);
    else if (loadSettings().alwaysOnTop) reassertUserAlwaysOnTop(mainWindow);
  });

  mainWindow.on('restore', () => wakeGameView());
  mainWindow.on('show', () => wakeGameView());
  mainWindow.on('move', saveWindowStateSoon);
  // 拖动边缘缩放时：在 will-resize（WM_SIZING）阶段提前同步对齐子视图边界，
  // 并在 resize 时立即同步落位，避免异步 setTimeout 慢一拍露出白色底板。
  mainWindow.on('will-resize', (_event, newBounds) => {
    if (!newBounds || isFullscreenNow(mainWindow)) return;
    syncGameViewSize(newBounds.width, newBounds.height);
  });
  mainWindow.on('resize', () => {
    flushGameViewLayout(); applyMaximizedClip(); saveWindowStateSoon();
  });
  mainWindow.on('close', onMainWindowClose);

  mainWindow.on('closed', () => {
    stopFsTopmostWatch();
    stopPinWatch();
    fsState = null;
    fsTopmostSuspended = false;
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
    if (gameMemoryHandle) { gameMemoryHandle.dispose(); gameMemoryHandle = null; }
    if (gwc && !gwc.isDestroyed()) gwc.close();
    gameView = null;
    mainWindow = null;
    authBridge.close();
    closeSplashWindow(0);
    if (noticeWindow && !noticeWindow.isDestroyed()) {
      try { noticeWindow.destroy(); } catch (_) {}
      noticeWindow = null;
    }
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      try { trayMenuWindow.destroy(); } catch (_) {}
      trayMenuWindow = null;
    }
    // 主窗口真正关闭（非隐藏到托盘）时，连同托盘与进程一起彻底退出。
    if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });
}

// ============ 游戏就绪检测 ============
function startGameReadyDetection() {
  if (gameReady) return;
  if (gameReadyTimer) clearTimeout(gameReadyTimer);
  const run = ++gameReadyRun;
  const start = Date.now();
  const MIN_MS = 1800;
  const MAX_MS = 15000;
  let stableCount = 0;
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
    try {
      if (wc.isLoadingMainFrame()) { schedule(); return; }
    } catch (_) {}
    try {
      const state = await wc.executeJavaScript(`
        (function () {
          var app = document.querySelector('#app');
          var topbar = document.querySelector('#topbar');
          var screens = document.querySelectorAll('.screen, [id^="screen-"]').length;
          var fontsReady = document.fonts ? document.fonts.status === 'loaded' : true;
          var appBox = app ? app.getBoundingClientRect() : null;
          var hasContent = appBox && appBox.width > 0 && appBox.height > 0;
          return !!(app && topbar && screens > 0 && hasContent) && fontsReady;
        })()
      `);
      if (state) {
        stableCount++;
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
  if (splashShownAt) dbg('[splash] visible', Date.now() - splashShownAt, 'ms');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (restoreMaximized) {
      try { mainWindow.maximize(); } catch (_) {}
    }
    applyMaximizedClip();
    mainWindow.focus();
    setTimeout(closeSplashWindow, 180);
  } else {
    closeSplashWindow();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
}

// ============ 启动器设置（并入游戏「通用」Tab） ============
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
    if (!retry) setTimeout(() => openLauncherTab(true), 600);
  }).catch(() => {});
}

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
let noticeWindow = null;
let scriptAutoCheckDone = false;
let pageScriptsInjectedAt = 0;

async function autoUpdateScriptsOnStartup() {
  if (scriptAutoCheckDone) return;
  scriptAutoCheckDone = true;

  let files = [];
  try {
    files = await scriptManager.listInjectableScripts();
  } catch (_) { return; }
  if (files.length === 0) return;

  const updated = [];
  let updatedAt = 0;
  const checks = await mapLimit(files, 3, async (name) => {
    try {
      const res = await scriptManager.checkScriptUpdate(name, { noCache: false });
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
      const ap = await scriptManager.applyScriptUpdate(name, res.remoteContent);
      if (ap && ap.ok) {
        updated.push({ name, from: res.localVersion || '', to: res.remoteVersion || '' });
        updatedAt = Date.now();
      }
    } catch (_) {}
  }
  if (updated.length === 0) {
    if (files.length) dbg('[scripts] auto-check done: checked', files.length, 'updated 0');
    return;
  }
  dbg('[scripts] startup auto-update', updated.length, updated.map((u) => u.name).join(','));

  if (mainWindow && !mainWindow.isDestroyed()) {
    try { (gameWC() || mainWindow.webContents).send('scripts-updated', updated.length); } catch (_) {}
  }

  if (pageScriptsInjectedAt === 0 || pageScriptsInjectedAt > updatedAt) {
    dbg('[scripts] updated before inject, skip refresh prompt; injectedAt', pageScriptsInjectedAt, 'updatedAt', updatedAt);
    return;
  }

  await waitForMainWindowVisible(20000);
  promptRefreshAfterScriptChange({ kind: 'update', items: updated });
}

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

let noticeCtx = null;

async function promptRefreshAfterScriptChange({ kind, items, reopen }) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return;

  if (noticeWindow && !noticeWindow.isDestroyed()) {
    try { noticeWindow.destroy(); } catch (_) {}
    noticeWindow = null;
    noticeCtx = null;
    await new Promise((r) => setTimeout(r, 60));
  }

  await new Promise((r) => setTimeout(r, 150));
  openScriptUpdateNotice({ kind, items: list, reopenSettings: !!reopen });
}

function openScriptUpdateNotice({ kind, items, reopenSettings }) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (noticeWindow && !noticeWindow.isDestroyed()) { noticeWindow.focus(); return; }

  const list = items || [];
  const NW = 440;
  const NH = 242;
  let x;
  let y;
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
    transparent: false,
    backgroundColor: themeColors().panelBg,
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

  const payload = {
    kind: kind || 'update',
    count: list.length,
    theme: currentTheme(),
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

// ============ IPC 发送方严格鉴权 ============
function ipcSenderUrl(event) {
  try { return event.senderFrame && event.senderFrame.url ? event.senderFrame.url : event.sender.getURL(); }
  catch (_) { return ''; }
}

function isGameIpcSender(event) {
  try {
    const wc = gameWC();
    const frame = event.senderFrame;
    return !!wc && event.sender === wc && !!frame && frame === wc.mainFrame && isGameUrl(frame.url);
  } catch (_) { return false; }
}

function isLocalIpcSender(event, filename) {
  try {
    const url = new URL(ipcSenderUrl(event));
    if (url.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(url)) === path.resolve(__dirname, 'assets', filename);
  } catch (_) { return false; }
}

function isOfflineIpcSender(event) {
  try {
    const wc = gameWC();
    const frame = event.senderFrame;
    return !!wc && event.sender === wc && !!frame && frame === wc.mainFrame && isLocalIpcSender(event, 'offline.html');
  } catch (_) { return false; }
}

function requireIpcSender(event, kind) {
  const allowed = kind === 'game'
    ? isGameIpcSender(event)
    : kind === 'offline'
      ? isOfflineIpcSender(event)
      : isLocalIpcSender(event, kind === 'shell' ? 'shell.html' : 'notice.html');
  if (!allowed) throw new Error('拒绝未授权的启动器 IPC 调用');
}

// ============ 待确认脚本更新令牌池 ============
const pendingScriptUpdates = new Map();
const PENDING_UPDATE_TTL = 5 * 60 * 1000;
const MAX_PENDING_SCRIPT_UPDATES = 12;

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

// ============ IPC 注册 ============
function setupIpc() {
  ipcMain.handle('get-settings', (event) => {
    requireIpcSender(event, 'game');
    return loadSettings();
  });

  ipcMain.handle('app-info', (event) => {
    requireIpcSender(event, 'game');
    return { version: app.getVersion(), packaged: app.isPackaged };
  });

  ipcMain.handle('app-update-state', (event) => {
    requireIpcSender(event, 'game');
    return appUpdaterController ? appUpdaterController.getStatus() : { state: 'unsupported', currentVersion: app.getVersion() };
  });

  ipcMain.handle('check-app-update', async (event) => {
    requireIpcSender(event, 'game');
    if (!appUpdaterController) return { ok: false, state: 'unsupported', message: '自动更新未初始化' };
    return appUpdaterController.check();
  });

  ipcMain.handle('install-app-update', (event) => {
    requireIpcSender(event, 'game');
    if (!appUpdaterController) return { ok: false, error: '自动更新未初始化' };
    return appUpdaterController.install();
  });

  ipcMain.handle('save-settings', (e, settings) => {
    requireIpcSender(e, 'game');
    const res = updateSettingsAndApply(settings);
    return res.ok;
  });

  ipcMain.on('reload-game', (e) => {
    if (!isGameIpcSender(e)) return;
    reloadGamePage();
  });

  ipcMain.handle('read-scripts', async (event) => {
    requireIpcSender(event, 'game');
    return scriptManager.readScriptSummaries(scriptRunStatus);
  });

  ipcMain.handle('import-script-from-url', async (e, { url, filename }) => {
    requireIpcSender(e, 'game');
    return scriptManager.importFromUrl(url, filename);
  });

  ipcMain.handle('check-script-update', async (e, { name }) => {
    requireIpcSender(e, 'game');
    const safeName = safeScriptName(name);
    const result = await scriptManager.checkScriptUpdate(safeName);
    if (!result || !result.ok || !result.hasUpdate || !result.remoteContent) return result;
    const updateToken = rememberPendingScriptUpdate(safeName, result.remoteContent);
    const { remoteContent, ...publicResult } = result;
    return { ...publicResult, updateToken };
  });

  ipcMain.handle('apply-script-update', async (e, { name, updateToken }) => {
    requireIpcSender(e, 'game');
    const safeName = safeScriptName(name);
    const token = String(updateToken || '');
    const pending = pendingScriptUpdates.get(token);
    forgetPendingScriptUpdate(token);
    if (!pending || pending.expiresAt <= Date.now() || pending.name !== safeName) {
      return { ok: false, error: '更新内容已失效，请重新检查' };
    }
    return scriptManager.applyScriptUpdate(safeName, pending.content);
  });

  ipcMain.handle('toggle-script-enabled', async (e, { name, enabled }) => {
    requireIpcSender(e, 'game');
    return scriptManager.setScriptEnabled(name, enabled);
  });

  ipcMain.handle('delete-script', async (e, name) => {
    requireIpcSender(e, 'game');
    return scriptManager.deleteScript(name);
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
    return scriptManager.importFromFilePaths(result.filePaths);
  });

  ipcMain.handle('open-scripts-dir', async (event) => {
    requireIpcSender(event, 'game');
    const error = await shell.openPath(scriptManager.ensureScriptsDir());
    return error ? { ok: false, error } : { ok: true };
  });

  // 离线兜底页 IPC
  ipcMain.on('offline-retry', (e) => {
    if (!isOfflineIpcSender(e)) return;
    loadGameUrl(CONFIG.gameUrl);
  });

  // 标题栏按钮与状态
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
  ipcMain.on('win-toggle-mute', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    updateSettingsAndApply({ muted: !loadSettings().muted });
  });
  ipcMain.on('win-toggle-pin', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    updateSettingsAndApply({ alwaysOnTop: !loadSettings().alwaysOnTop });
  });
  ipcMain.on('win-title-menu', (e) => {
    if (!isLocalIpcSender(e, 'shell.html')) return;
    openTrayMenuAtCursor();
  });
  ipcMain.handle('tray-menu-state', (e) => {
    if (!isLocalIpcSender(e, 'tray-menu.html')) throw new Error('拒绝未授权的启动器 IPC 调用');
    return getTrayMenuState();
  });
  ipcMain.on('tray-menu-close', (e) => {
    if (!isLocalIpcSender(e, 'tray-menu.html')) return;
    closeTrayMenu();
  });
  ipcMain.on('tray-alert-state', (e, payload) => {
    if (!isGameIpcSender(e)) return;
    updateTrayAlertState(payload);
  });

  ipcMain.on('game-theme-changed', (e, theme) => {
    if (!isGameIpcSender(e)) return;
    setGameTheme(theme);
  });

  ipcMain.on('tray-menu-action', (e, action) => {
    if (!isLocalIpcSender(e, 'tray-menu.html')) return;
    if (action === 'refresh-clean') {
      closeTrayMenu();
      refreshAndCleanMemory();
      return;
    }
    if (action === 'quit') {
      closeTrayMenu();
      isQuitting = true;
      app.quit();
      return;
    }
    // 点击开关项时不关闭菜单，方便用户连续切换多个开关；短暂保护 blur 防止置顶或恢复窗口抢焦点。
    trayMenuSuppressBlurUntil = Date.now() + 400;
    switch (action) {
      case 'keep-active':
        updateSettingsAndApply({ keepActive: !(loadSettings().keepActive !== false) }, { keepMenuOpen: true });
        break;
      case 'minimize-to-tray':
        updateSettingsAndApply({ minimizeToTray: !loadSettings().minimizeToTray }, { keepMenuOpen: true });
        break;
      case 'mute':
        updateSettingsAndApply({ muted: !loadSettings().muted }, { keepMenuOpen: true });
        break;
      case 'pin':
        updateSettingsAndApply({ alwaysOnTop: !loadSettings().alwaysOnTop }, { keepMenuOpen: true });
        break;
    }
    keepTrayMenuOnTop();
  });
  ipcMain.handle('win-is-maximized', (e) => {
    requireIpcSender(e, 'shell');
    const win = winOf(e);
    return win ? (win.isMaximized() || isFullscreenNow(win)) : false;
  });
  ipcMain.handle('shell-state', (e) => {
    requireIpcSender(e, 'shell');
    return getShellStateSnapshot();
  });

  // 脚本变更刷新提示
  ipcMain.on('script-change-prompt', (e, payload) => {
    if (!isGameIpcSender(e)) return;
    const p = payload || {};
    const kind = p.kind === 'import' ? 'import' : 'update';
    const items = Array.isArray(p.items) ? p.items : [];
    promptRefreshAfterScriptChange({ kind, items, reopen: p.reopen !== false });
  });

  ipcMain.on('notice-action', (e, action) => {
    if (!isLocalIpcSender(e, 'notice.html')) return;
    const wn = BrowserWindow.fromWebContents(e.sender);
    const ctx = noticeCtx || {};
    noticeCtx = null;
    const refresh = action === 'refresh';
    if (wn && !wn.isDestroyed()) wn.close();
    if (refresh && mainWindow && !mainWindow.isDestroyed()) {
      reloadGamePage();
      try { mainWindow.focus(); } catch (_) {}
    } else if (!refresh && ctx.reopenSettings) {
      setTimeout(() => { try { openLauncherTab(); } catch (_) {} }, 120);
    }
  });
}

// ============ 应用生命周期 ============
app.whenReady().then(() => {
  // 按上次记忆的游戏主题同步 Electron 原生窗口主题，避免深色模式下缩放过渡帧露白。
  try { nativeTheme.themeSource = currentTheme(); } catch (_) {}
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  try { session.defaultSession.setUserAgent(CLEAN_UA); } catch (_) {}

  setupIpc();

  try {
    const st = app.getGPUFeatureStatus();
    dbg('[gpu] compositing=' + st.gpu_compositing, 'raster=' + st.rasterization,
      'canvas2d=' + st['2d_canvas'], 'skip-gpu=' + CONFIG.disableHardwareAcceleration);
  } catch (_) {}

  memoryManager = createMemoryManager({
    app,
    session: session.defaultSession,
    isGameUrl,
    isWindowVisible: () => !isMainWindowBackgrounded(),
    dbg,
  });

  ensureTray();
  createWindow();

  appUpdaterController = setupAppUpdater({
    app,
    dialog,
    getMainWindow: () => mainWindow,
    onStatus: (status) => broadcastAppUpdateState(status),
    log: {
      debug: (...args) => dbg(...args),
      error: (...args) => console.error(...args),
    },
  });

  setTimeout(() => { autoUpdateScriptsOnStartup(); }, 800);

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
    else showMainWindowFromTray();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowStateNow();
  if (appUpdaterController) {
    try { appUpdaterController.dispose(); } catch (_) {}
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    try { trayMenuWindow.destroy(); } catch (_) {}
    trayMenuWindow = null;
  }
  if (trayFlasher) {
    try { trayFlasher.dispose(); } catch (_) {}
    trayFlasher = null;
  }
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
  flushDebugLogSync();
});

app.on('second-instance', () => {
  showMainWindowFromTray();
});

app.on('window-all-closed', () => {
  if (isQuitting || !loadSettings().minimizeToTray) {
    app.quit();
  }
});
