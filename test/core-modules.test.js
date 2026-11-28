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
const { extractAlertSchedules, evaluateAlertState, buildTooltip, createTrayFlasher, TRANSPARENT_PNG_16 } = require('../lib/tray-alert');

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
    undergroundPreview: true,
    minimizeToTray: true,
    alwaysOnTop: true,
    muted: true,
    theme: 'dark',
  });

  const saved = saveSettings(file, { ...loaded, muted: false, theme: 'light' });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.muted, false);
  assert.equal(saved.settings.theme, 'light');
  assert.equal(saveSettings(file, { theme: 'invalid' }).settings.theme, 'dark');
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

test('tray-alert generates valid PNG, extracts schedules, formats 4-line tooltip, and mutes acknowledged alerts', async () => {
  const zlib = require('node:zlib');
  // 校验生成的空白闪烁 PNG 具备合法签名、16x16 IHDR 和可解压的 1040 字节 RGBA IDAT
  assert.equal(TRANSPARENT_PNG_16.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(TRANSPARENT_PNG_16.readUInt32BE(16), 16);
  assert.equal(TRANSPARENT_PNG_16.readUInt32BE(20), 16);
  const idatOff = 8 + 12 + 13;
  assert.equal(TRANSPARENT_PNG_16.subarray(idatOff + 4, idatOff + 8).toString('ascii'), 'IDAT');
  const idatLen = TRANSPARENT_PNG_16.readUInt32BE(idatOff);
  const inflated = zlib.inflateSync(TRANSPARENT_PNG_16.subarray(idatOff + 8, idatOff + 8 + idatLen));
  assert.equal(inflated.length, 16 * (1 + 16 * 4));

  const save = {
    pension: {
      eggs: [
        { uid: 'e1', hatchAt: 1000 },
        { uid: 'e2', hatchAt: 5000 },
      ],
    },
    under: {
      slots: [
        { id: 'u1', start: 500, end: 2000 },
        { id: 'u2', start: 500, end: 9000, recalled: 800 },
      ],
    },
  };
  const schedules = extractAlertSchedules(save);
  assert.deepEqual(schedules.eggItems, [
    { id: 'egg:e1', at: 1000 },
    { id: 'egg:e2', at: 5000 },
  ]);
  assert.deepEqual(schedules.underItems, [
    { id: 'ug:u1', at: 2000 },
    { id: 'ug:u2', at: 0 },
  ]);

  const at900 = evaluateAlertState(schedules, 900);
  assert.equal(at900.readyEggs, 0);
  assert.equal(at900.readyUnderground, 1); // recalled slot is immediately done
  assert.deepEqual(at900.readyIds, ['ug:u2']);
  assert.equal(at900.shouldFlash, true);

  const at2500 = evaluateAlertState(schedules, 2500);
  assert.equal(at2500.readyEggs, 1);
  assert.equal(at2500.readyUnderground, 2);
  assert.deepEqual(at2500.readyIds, ['egg:e1', 'ug:u1', 'ug:u2']);
  assert.equal(at2500.shouldFlash, true);

  assert.equal(
    buildTooltip(),
    "Poke'Catch 启动器\n金钱总数：--\n孵化完成：0颗蛋\n挖矿完成：0个队伍"
  );
  assert.equal(
    buildTooltip({ money: 91720, readyEggs: 1, readyUnderground: 2 }),
    "Poke'Catch 启动器\n金钱总数：91,720\n孵化完成：1颗蛋\n挖矿完成：2个队伍"
  );
  assert.equal(
    buildTooltip({ money: '123,456', readyEggs: 3, readyUnderground: 0 }),
    "Poke'Catch 启动器\n金钱总数：123,456\n孵化完成：3颗蛋\n挖矿完成：0个队伍"
  );

  const images = [];
  const tooltips = [];
  const normalIcon = { id: 'normal', isEmpty: () => false };
  const blankIcon = { id: 'blank', isEmpty: () => false };
  const fakeTray = {
    isDestroyed: () => false,
    setImage: (img) => images.push(img.id),
    setToolTip: (tip) => tooltips.push(tip),
  };
  let foreground = false;
  const flasher = createTrayFlasher({
    tray: fakeTray,
    normalIcon,
    nativeImage: { createFromBuffer: () => blankIcon },
    isWindowForeground: () => foreground,
    intervalMs: 25,
  });

  // 1. 后台出现新的可孵化蛋 → 开始闪烁并更新四行提示框
  flasher.update({ money: '91,720', readyEggs: 1, readyUnderground: 0, readyIds: ['egg:e1'] });
  assert.equal(flasher.isFlashing(), true);
  assert.equal(
    tooltips[tooltips.length - 1],
    "Poke'Catch 启动器\n金钱总数：91,720\n孵化完成：1颗蛋\n挖矿完成：0个队伍"
  );
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(images.includes('blank'));

  // 2. 玩家点击托盘/切回窗口标为已读 → 立刻停闪；之后金钱变化但仍是同一颗蛋 → 更新提示框但不重闪
  flasher.acknowledgeCurrent();
  assert.equal(flasher.isFlashing(), false);
  assert.equal(images[images.length - 1], 'normal');

  flasher.update({ money: '92,300', readyEggs: 1, readyUnderground: 0, readyIds: ['egg:e1'] });
  assert.equal(flasher.isFlashing(), false);
  assert.equal(
    tooltips[tooltips.length - 1],
    "Poke'Catch 启动器\n金钱总数：92,300\n孵化完成：1颗蛋\n挖矿完成：0个队伍"
  );

  // 3. 后台新增地下通道挖矿完成 → 有未读 ID，重新闪烁
  flasher.update({ money: '92,300', readyEggs: 1, readyUnderground: 1, readyIds: ['egg:e1', 'ug:u1'] });
  assert.equal(flasher.isFlashing(), true);

  // 4. 窗口处于前台时新增另一颗蛋 → 自动标为已读不闪烁，切回后台后也保持静默
  foreground = true;
  flasher.update({ money: '92,500', readyEggs: 2, readyUnderground: 1, readyIds: ['egg:e1', 'ug:u1', 'egg:e2'] });
  assert.equal(flasher.isFlashing(), false);
  foreground = false;
  flasher.update({ money: '92,600', readyEggs: 2, readyUnderground: 1, readyIds: ['egg:e1', 'ug:u1', 'egg:e2'] });
  assert.equal(flasher.isFlashing(), false);

  // 5. 全部领取完毕 → 停止闪烁并清理旧已读 ID
  flasher.update({ money: '95,000', readyEggs: 0, readyUnderground: 0, readyIds: [] });
  assert.equal(flasher.isFlashing(), false);
  assert.equal(images[images.length - 1], 'normal');
  assert.equal(
    tooltips[tooltips.length - 1],
    "Poke'Catch 启动器\n金钱总数：95,000\n孵化完成：0颗蛋\n挖矿完成：0个队伍"
  );
  flasher.dispose();
});

test('underground-loot userscript previews unobtained rewards with gray mask and skips full-save JSON.parse', async () => {
  const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'underground-loot.user.js'), 'utf8');
  const now = 1_700_000_000_000;
  const start = now - 5 * 2800; // step = 5 => floor 1 cleared (at[0]=3), floors 2..3 still pending
  const saveObj = {
    bigPadding: 'x'.repeat(50000),
    under: {
      slots: [
        {
          id: 'ug1',
          bay: 0,
          start,
          end: now + 60_000,
          res: {
            floors: 3,
            at: [3, 10, 20],
            loot: [
              [{ k: 'money', n: 150 }, { k: 'item', id: 'rare-candy' }],
              [{ k: 'money', n: 300 }, { k: 'geode', t: 3 }, { k: 'item', id: 'rare-candy' }],
              [{ k: 'money', n: 450 }, { k: 'fossil', id: 138, lv: 20, reg: 'kanto' }, { k: 'plate', type: 'fire', t: 2 }, { k: 'shards', n: 8 }],
            ],
          },
        },
      ],
    },
  };
  const rawSave = JSON.stringify(saveObj);
  const parseSizes = [];
  const origParse = JSON.parse;

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      nodeType: 1,
      className: '',
      attributes: Object.create(null),
      dataset: Object.create(null),
      children: [],
      textContent: '',
      title: '',
      src: '',
      alt: '',
      parentNode: null,
      classList: {
        contains: (c) => String(el.className || '').split(/\s+/).includes(c),
      },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
      appendChild(child) {
        if (child && child.isFragment) {
          for (const c of child.children) this.appendChild(c);
          return child;
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        if (sel === '.pc-ug-prev') return this.children.filter((c) => c.classList.contains('pc-ug-prev'));
        if (sel.startsWith('[data-ftip=')) return [];
        return [];
      },
    };
    return el;
  }

  const lootBox = makeEl('div');
  lootBox.className = 'ug-loot';
  lootBox.setAttribute('data-p', 'loot');
  const bayEl = {
    getAttribute: (k) => (k === 'data-bay' ? '0' : null),
    querySelector: (sel) => (sel === '.ug-loot[data-p="loot"]' ? lootBox : null),
  };
  const screenEl = {
    querySelectorAll: (sel) => (sel === '.ug-bay[data-bay]' ? [bayEl] : []),
  };
  const headEl = makeEl('head');
  const styles = new Map();

  const sandbox = {
    console,
    Date: { now: () => now },
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    JSON: {
      parse: (s) => { parseSizes.push(s.length); return origParse(s); },
      stringify: JSON.stringify,
    },
    localStorage: {
      getItem: (k) => (k === 'gachamon-save-v1' ? rawSave : null),
    },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    document: {
      head: headEl,
      documentElement: headEl,
      getElementById: (id) => styles.get(id) || null,
      querySelector: (sel) => (sel === '#screen-underground.active' ? screenEl : null),
      querySelectorAll: (sel) => (sel === '#screen-underground .ug-loot[data-p="loot"]' ? [lootBox] : []),
      createElement: (tag) => {
        const el = makeEl(tag);
        if (tag === 'style') {
          Object.defineProperty(el, 'id', {
            set(v) { this._id = v; styles.set(v, this); },
            get() { return this._id; },
          });
        }
        return el;
      },
      createDocumentFragment: () => ({ isFragment: true, children: [], appendChild(c) { this.children.push(c); return c; } }),
    },
    addEventListener: () => {},
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.launcher = {
    getSettings: () => Promise.resolve({ undergroundPreview: true }),
    onSettingsChanged: () => {},
  };

  vm.runInNewContext(scriptSrc, sandbox);
  await new Promise((r) => setTimeout(r, 10));

  // 确认只解析了 under.slots 局部切片，没有解析 50KB 整份存档
  assert.equal(parseSizes.length, 1);
  assert.ok(parseSizes[0] < 1000);

  // 确认按原生排序（金钱 + 化石9 > 石板8 > 传说晶洞7 > 糖果2 > 碎片1）渲染了带 pc-ug-prev 遮罩类的预览节点
  const prevNodes = lootBox.children.filter((c) => c.classList.contains('pc-ug-prev'));
  assert.equal(prevNodes.length, 6);
  assert.equal(prevNodes[0].textContent, '+750 ₽'); // floor 2 (300) + floor 3 (450)
  assert.deepEqual(
    prevNodes.slice(1).map((n) => n.getAttribute('data-ftip')),
    ['fossil:138', 'plate:fire', 'geode:3', 'item:rare-candy', 'item:event-shard']
  );

  // 关闭开关后立刻清理所有预览节点
  sandbox.window.__pcUndergroundLootPreview.set(false);
  assert.equal(lootBox.children.filter((c) => c.classList.contains('pc-ug-prev')).length, 0);
});
