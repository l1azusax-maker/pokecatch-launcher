'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { writeFileAtomicSync, writeFileAtomic, writeJsonAtomicSync, readJsonSafeSync } = require('../lib/fs-atomic');
const { loadSettings, saveSettings, DEFAULT_SETTINGS } = require('../lib/settings-store');
const {
  isGameUrl,
  isSupabaseAuthorizeUrl,
  createNavigationPolicy,
} = require('../lib/url-policy');
const { createScriptManager } = require('../lib/script-manager');
const { createAuthBridge } = require('../lib/auth-bridge');
const { setupAppUpdater } = require('../lib/app-updater');
const { createMemoryManager, sumProcessMemoryKB } = require('../lib/memory-manager');
const { drawBadgeOnBgraBitmap, countReadyEggsFromSave } = require('../lib/tray-badge');

test('fs-atomic writes and reads JSON safely with fallback on corruption', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pcl-atomic-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'sub', 'data.json');
  writeJsonAtomicSync(target, { a: 1, b: 'ok' });
  assert.deepEqual(readJsonSafeSync(target, {}), { a: 1, b: 'ok' });

  await writeFileAtomic(target, '{"a":2}');
  assert.deepEqual(readJsonSafeSync(target, {}), { a: 2 });

  writeFileAtomicSync(target, '{broken json');
  assert.deepEqual(readJsonSafeSync(target, { fallback: true }), { fallback: true });
});

test('settings-store sanitizes legacy and removed keys', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pcl-settings-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');

  assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);

  writeJsonAtomicSync(file, {
    keepActive: false,
    shinyEgg: true,
    minimizeToTray: true,
    alwaysOnTop: true,
    muted: true,
    zoomFactor: 1.2,
    gameOrigin: 'https://pokecatch-online.netlify.app',
    noGlass: true,
    roundCorners: false,
  });

  const loaded = loadSettings(file);
  assert.deepEqual(loaded, {
    keepActive: false,
    shinyEgg: true,
    minimizeToTray: true,
    alwaysOnTop: true,
    muted: true,
  });

  const saved = saveSettings(file, { ...loaded, muted: false });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.muted, false);
});

test('url-policy validates game URLs, OAuth endpoints and navigation policy', () => {
  assert.equal(isGameUrl('https://pokecatch-online.app/'), true);
  assert.equal(isGameUrl('https://pokecatch-online.pages.dev/play'), true);
  assert.equal(isGameUrl('http://pokecatch-online.app/'), false);
  assert.equal(isGameUrl('https://pokecatch-online.app:8443/'), false);

  assert.equal(isSupabaseAuthorizeUrl('https://abc.supabase.co/auth/v1/authorize?provider=google'), true);
  assert.equal(isSupabaseAuthorizeUrl('https://example.com/auth/v1/authorize'), false);

  const policy = createNavigationPolicy();
  assert.equal(policy.shouldAllowNavigation('https://pokecatch-online.app/'), true);
  assert.equal(policy.shouldAllowNavigation('https://accounts.google.com/signin'), true);
  assert.equal(policy.shouldAllowNavigation('https://example.com/news'), false);
});

test('script-manager supports import, enable/disable, update and delete without creating backups', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pcl-scripts-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  let remoteVersion = '1.0.0';
  let remoteBody = 'console.log("v1");';
  const fetchUrl = async () => ({
    status: 200,
    content: `// ==UserScript==\n// @name Demo\n// @version ${remoteVersion}\n// ==/UserScript==\n${remoteBody}\n`,
  });

  const mgr = createScriptManager({ getUserDataDir: () => dir, fetchUrl });

  const imp = await mgr.importFromUrl('https://example.com/demo.user.js', '');
  assert.equal(imp.ok, true);
  assert.equal(imp.name, 'demo.user.js');
  assert.equal(imp.version, '1.0.0');

  assert.deepEqual(await mgr.listInjectableScripts(), ['demo.user.js']);

  const dis = await mgr.setScriptEnabled('demo.user.js', false);
  assert.equal(dis.ok, true);
  assert.deepEqual(await mgr.listInjectableScripts(), []);

  await mgr.setScriptEnabled('demo.user.js', true);
  assert.deepEqual(await mgr.listInjectableScripts(), ['demo.user.js']);

  remoteVersion = '1.1.0';
  remoteBody = 'console.log("v2");';
  const chk = await mgr.checkScriptUpdate('demo.user.js');
  assert.equal(chk.ok, true);
  assert.equal(chk.hasUpdate, true);
  assert.equal(chk.remoteVersion, '1.1.0');

  const ap = await mgr.applyScriptUpdate('demo.user.js', chk.remoteContent);
  assert.equal(ap.ok, true);

  const runStatus = new Map([['demo.user.js', { ok: false, error: 'boom' }]]);
  const summaries = await mgr.readScriptSummaries(runStatus);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].version, '1.1.0');
  assert.equal(summaries[0].lastError, 'boom');
  assert.equal('hasBackup' in summaries[0], false);

  const del = await mgr.deleteScript('demo.user.js');
  assert.equal(del.ok, true);
  assert.deepEqual(await mgr.listScriptFiles(), []);
  assert.equal(fs.existsSync(path.join(dir, 'scripts-backups')), false);
});

test('auth-bridge enforces nonce and origin on local callback server', async (t) => {
  let openedUrl = '';
  let receivedSuffix = '';
  const bridge = createAuthBridge({
    openExternal: (url) => { openedUrl = url; },
    onSuccess: (suffix) => { receivedSuffix = suffix; },
    onFailure: (msg) => { throw new Error('unexpected failure: ' + msg); },
    timeoutMs: 10000,
  });
  t.after(() => bridge.close());

  bridge.start('https://demo.supabase.co/auth/v1/authorize?provider=google');
  await new Promise((resolve) => setTimeout(resolve, 60));

  const flow = bridge.getFlowInfo();
  assert.ok(flow && flow.port > 0);
  assert.ok(openedUrl.includes(`redirect_to=http%3A%2F%2F127.0.0.1%3A${flow.port}%2Fauth-cb`));

  const post = (headers, body) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: flow.port,
      path: '/payload',
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body);
  });

  const badNonce = await post({ 'content-type': 'text/plain', 'x-pc-auth-nonce': 'wrong' }, 'access_token=abc');
  assert.equal(badNonce.status, 403);
  assert.equal(bridge.isActive(), true);

  const badOrigin = await post({
    'content-type': 'text/plain',
    'x-pc-auth-nonce': flow.nonce,
    origin: 'https://evil.example.com',
  }, 'access_token=abc');
  assert.equal(badOrigin.status, 403);
  assert.equal(bridge.isActive(), true);

  const good = await post({
    'content-type': 'text/plain',
    'x-pc-auth-nonce': flow.nonce,
    origin: `http://127.0.0.1:${flow.port}`,
  }, 'access_token=secret123&token_type=bearer');
  assert.equal(good.status, 200);
  assert.equal(receivedSuffix, '#access_token=secret123&token_type=bearer');
  assert.equal(bridge.isActive(), false);
});

test('app-updater tracks lifecycle states and exposes manual check and install', async () => {
  const devCtrl = setupAppUpdater({
    app: { isPackaged: false, getVersion: () => '1.1.3' },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getMainWindow: () => null,
  });
  assert.equal(devCtrl.getStatus().state, 'unsupported');
  const devCheck = await devCtrl.check();
  assert.equal(devCheck.ok, false);
  devCtrl.dispose();

  class FakeUpdater extends EventEmitter {
    constructor() {
      super();
      this.installed = false;
    }
    async checkForUpdates() {
      this.emit('checking-for-update');
      this.emit('update-available', { version: '1.2.0' });
      this.emit('download-progress', { percent: 56.4 });
      this.emit('update-downloaded', { version: '1.2.0' });
    }
    quitAndInstall() {
      this.installed = true;
    }
  }

  const fake = new FakeUpdater();
  const seenStates = [];
  const seenPercents = [];
  const ctrl = setupAppUpdater({
    app: { isPackaged: true, getVersion: () => '1.1.3' },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    getMainWindow: () => null,
    onStatus: (s) => { seenStates.push(s.state); seenPercents.push(s.percent); },
    log: { debug: () => {}, error: () => {} },
    autoUpdaterImpl: fake,
  });

  await ctrl.check();
  assert.deepEqual(seenStates, ['checking', 'available', 'downloading', 'downloaded']);
  assert.equal(seenPercents.includes(56), true);
  assert.equal(ctrl.getStatus().availableVersion, '1.2.0');
  assert.equal(ctrl.getStatus().percent, 100);

  const inst = ctrl.install();
  assert.equal(inst.ok, true);
  assert.equal(fake.installed, true);
  ctrl.dispose();
});

test('shiny-egg userscript computes deterministic shiny rolls and caches JSON parsing', async () => {
  const source = await fs.promises.readFile(path.join(__dirname, '..', 'scripts', 'shiny-egg.user.js'), 'utf8');
  let parseCount = 0;
  let observerOpts = null;
  const origParse = JSON.parse;
  const savePayload = JSON.stringify({
    trainer: { since: 1700000000, id: 'trainer-1' },
    pension: {
      eggs: [
        { uid: 'egg-1', shiny: true },
        { uid: 'egg-2', shiny: false },
      ],
    },
  });

  const makeCard = (uid) => {
    const markers = [];
    const nameEl = {
      querySelectorAll: () => [...markers],
      querySelector: () => null,
      append: (m) => markers.push(m),
    };
    const imgClasses = new Set();
    let imgSrc = 'assets/pokemon/25.png';
    const imgEl = {
      getAttribute: () => imgSrc,
      setAttribute: (_k, v) => { imgSrc = v; },
      classList: {
        toggle: (c, f) => (f ? imgClasses.add(c) : imgClasses.delete(c)),
        contains: (c) => imgClasses.has(c),
        remove: (c) => imgClasses.delete(c),
      },
    };
    return {
      dataset: { egg: uid },
      querySelector: (sel) => (sel === '.egg-mon img' ? imgEl : sel === '.meta > b' ? nameEl : null),
      getImgSrc: () => imgSrc,
      getMarkerCount: () => markers.length,
    };
  };

  const card1 = makeCard('egg-1');
  const card2 = makeCard('egg-2');
  const fakeGrid = {
    isConnected: true,
    querySelectorAll: (sel) => (sel === '.pen-egg[data-egg]' ? [card1, card2] : []),
  };

  const timers = [];
  const windowObj = {
    launcher: { getSettings: async () => ({ shinyEgg: true }) },
    addEventListener: () => {},
  };
  const fakeDocument = {
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    getElementById: () => ({}),
    createElement: () => ({ setAttribute: () => {}, className: '', remove: () => {} }),
    querySelector: (sel) => (sel === '#pen-eggs' ? fakeGrid : null),
    querySelectorAll: () => [],
  };

  const sandbox = {
    window: windowObj,
    document: fakeDocument,
    localStorage: { getItem: () => savePayload },
    MutationObserver: class {
      observe(_el, opts) { observerOpts = opts; }
      disconnect() {}
    },
    JSON: {
      parse: (...args) => { parseCount++; return origParse(...args); },
      stringify: JSON.stringify,
    },
    setTimeout: (fn, delay) => {
      const id = timers.length + 1;
      timers.push({ id, fn, delay });
      return id;
    },
    clearTimeout: () => {},
    Math,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
  };

  vm.runInNewContext(source, sandbox);
  const api = windowObj.__pcShinyEggPreview;
  assert.ok(api && typeof api.isShinyEgg === 'function' && typeof api.hash === 'function');

  assert.equal(api.isShinyEgg({ shiny: true }, {}), true);
  assert.equal(api.isShinyEgg({ shiny: false }, {}), false);
  const h1 = api.hash('1700000000:trainer-1|egg|42|0');
  const h2 = api.hash('1700000000:trainer-1|egg|42|0');
  assert.equal(h1, h2);
  assert.ok(h1 >= 0 && h1 < 1);

  api.scan();
  const scanTimer1 = timers.filter((t) => t.delay === 0).pop();
  scanTimer1.fn();
  assert.equal(parseCount, 1);
  assert.equal(card1.getImgSrc(), 'assets/pokemon/shiny/25.png');
  assert.equal(card1.getMarkerCount(), 1);
  assert.equal(card2.getImgSrc(), 'assets/pokemon/25.png');
  assert.equal(card2.getMarkerCount(), 0);
  assert.equal(Boolean(observerOpts && observerOpts.characterData), false);

  api.scan();
  const scanTimer2 = timers.filter((t) => t.delay === 0).pop();
  scanTimer2.fn();
  assert.equal(parseCount, 1);
});

test('memory-manager runs timeout-guarded safe GC, skips when hidden, and never sends pressure signals', async () => {
  const sent = [];
  let attached = false;
  let clearedCodeCaches = 0;
  let visible = false;
  let metricsCall = 0;
  const fakeApp = {
    getAppMetrics: () => {
      metricsCall++;
      return metricsCall % 2 === 1
        ? [{ memory: { workingSetSize: 300 * 1024 } }, { memory: { workingSetSize: 200 * 1024 } }]
        : [{ memory: { workingSetSize: 220 * 1024 } }, { memory: { workingSetSize: 150 * 1024 } }];
    },
  };
  const fakeSession = {
    clearCodeCaches: async () => { clearedCodeCaches++; },
  };
  let hangNext = false;
  const fakeWc = {
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    getURL: () => 'https://pokecatch-online.app/',
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async (method, params) => {
        sent.push({ method, params });
        if (hangNext) return new Promise(() => {});
      },
    },
  };

  assert.equal(sumProcessMemoryKB([{ memory: { workingSetSize: 100 } }, { memory: { privateBytes: 50 } }]), 150);

  const mgr = createMemoryManager({
    app: fakeApp,
    session: fakeSession,
    isGameUrl: (u) => u.startsWith('https://pokecatch-online.app'),
    isWindowVisible: () => visible,
    commandTimeoutMs: 40,
  });

  // 隐藏到托盘时不自动触发 GC
  const skipped = await mgr.runSafeGc(fakeWc, { reason: 'interval' });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'window-hidden');
  assert.equal(sent.length, 0);

  // 可见时仅执行安全的 HeapProfiler.collectGarbage
  visible = true;
  const normal = await mgr.runSafeGc(fakeWc, { reason: 'interval' });
  assert.equal(normal.ok, true);
  assert.equal(attached, false);
  assert.equal(clearedCodeCaches, 0);
  assert.deepEqual(sent.map((x) => x.method), ['HeapProfiler.collectGarbage']);

  // 刷新清理时先清 code caches 再安全 GC
  sent.length = 0;
  const refresh = await mgr.runSafeGc(fakeWc, { reason: 'refresh-clean', force: true, clearCodeCache: true });
  assert.equal(refresh.ok, true);
  assert.equal(clearedCodeCaches, 1);
  assert.equal(refresh.freedMB, 130);
  assert.deepEqual(sent.map((x) => x.method), ['HeapProfiler.collectGarbage']);

  // CDP 挂起时超时保护必须正常退出并 detach debugger
  hangNext = true;
  const timedOut = await mgr.runSafeGc(fakeWc, { reason: 'timeout-check', force: true });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, 'cdp-timeout');
  assert.equal(attached, false);
});

test('tray-badge draws bottom-right red/white badge pixels and counts ready eggs accurately', () => {
  const w = 32;
  const h = 32;
  const blank = Buffer.alloc(w * h * 4, 0);

  const zero = drawBadgeOnBgraBitmap(blank, w, h, 0);
  assert.equal(zero.equals(blank), true);

  const one = drawBadgeOnBgraBitmap(blank, w, h, 3);
  assert.equal(one.equals(blank), false);
  // 左上角区域未被角标遮挡，右下角区域有不透明红/白像素
  assert.equal(one[3], 0);
  let whitePixels = 0;
  let redPixels = 0;
  for (let y = 14; y < h; y++) {
    for (let x = 14; x < w; x++) {
      const i = (y * w + x) * 4;
      const b = one[i], g = one[i + 1], r = one[i + 2], a = one[i + 3];
      if (a === 255 && r === 255 && g === 255 && b === 255) whitePixels++;
      if (a === 255 && r > 200 && g < 80 && b < 80) redPixels++;
    }
  }
  assert.ok(whitePixels > 10);
  assert.ok(redPixels > 50);

  const twoDigits = drawBadgeOnBgraBitmap(blank, w, h, 12);
  assert.equal(twoDigits.equals(one), false);

  const save = {
    pension: {
      eggs: [
        { uid: 'a', hatchAt: 1000 },
        { uid: 'b', hatchAt: 2000 },
        { uid: 'c', hatchAt: 3000 },
      ],
    },
  };
  assert.equal(countReadyEggsFromSave(save, 999), 0);
  assert.equal(countReadyEggsFromSave(save, 1000), 1);
  assert.equal(countReadyEggsFromSave(save, 2500), 2);
  assert.equal(countReadyEggsFromSave(save, 5000), 3);
});
