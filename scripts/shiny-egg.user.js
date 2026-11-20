// ============================================================
// 异色蛋预览（内置脚本，可在设置里开关）
//
// 实现依据：outputs/shiny-egg-plugin-development-guide.md
// （游戏 v0.5.07 / 客户端 app.c742526349 核验）
//
// 只做两件事：
//   1) 读本地存档，判断培育屋里尚未孵化的蛋是否为异色，
//      在蛋名后追加游戏原生异色标记 <i class="shiny-mk pces-shiny-egg">；
//   2) 把该蛋卡右侧头像换成游戏自带的异色精灵图 assets/pokemon/shiny/。
//
// 硬性边界（照文档来）：
//   - 只读 localStorage['gachamon-save-v1']，绝不写入 / 删除 / 重建存档键；
//   - 不改蛋数据、孵化计时、孵化结果、save.pension，也不碰游戏内部对象；
//   - 不自动点击 / 孵化 / 喂果 / 收蛋；
//   - 判定不成立时安静退出，不向页面输出错误文本。
// ============================================================
(() => {
  'use strict';

  const L = window.launcher;          // 不在启动器里（或没 preload）就不执行
  if (!L) return;
  if (window.__pcShinyEggInstalled) return;
  window.__pcShinyEggInstalled = true;

  const SAVE_KEY = 'gachamon-save-v1';
  const MARK_CLASS = 'pces-shiny-egg';
  const SPRITE_CLASS = 'pces-shiny-egg-sprite';
  const STYLE_ID = 'pc-shiny-egg-style';
  const VERSION = '1.0.0';

  // 与游戏 CONFIG.PENSION 对齐（v0.5.07）
  const RATES = Object.freeze({
    base: 1 / 512,
    newShinyParent: 1 / 16,
    legacyShinyParent: 1 / 10,
    berryMultiplier: 2,
  });

  // ---------- 判定算法（逐字实现，别改位运算） ----------
  function fixedEggHash(text) {
    const secret = [24348, 41597, 15337, 49222];
    let a = 1779033703 ^ ((secret[0] << 16) | secret[1]);
    let b = 3144134277 ^ ((secret[2] << 16) | secret[3]);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 2654435761);
      b = Math.imul(b ^ code, 1597334677);
    }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return (4294967296 * (2097151 & b) + (a >>> 0)) / 9007199254740992;
  }

  function isShinyEgg(egg, save) {
    if (!egg || typeof egg !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(egg, 'shiny')) return Boolean(egg.shiny);

    const indexed = Number.isInteger(egg.k);
    if (!indexed && egg.uid == null && egg.laidAt == null) return false;

    const trainerSeed = `${save?.trainer?.since ?? ''}:${save?.trainer?.id ?? ''}`;
    const roll = fixedEggHash(indexed
      ? `${trainerSeed}|egg|${egg.k}|0`
      : String(egg.uid ?? egg.laidAt));

    const parent = egg.sp
      ? (Number(egg.sp) === 2 ? RATES.newShinyParent : RATES.legacyShinyParent)
      : 0;
    const rate = Math.max(RATES.base, parent) * (egg.bx ? RATES.berryMultiplier : 1);
    return roll < rate;
  }

  // ---------- 头像切换 ----------
  function eggPokemonSpriteSource(source, shiny) {
    const current = String(source || '');
    const normal = current.replace(/((?:^|\/)assets\/pokemon\/)shiny\//, '$1');
    return shiny
      ? normal.replace(/((?:^|\/)assets\/pokemon\/)(?!shiny\/)/, '$1shiny/')
      : normal;
  }

  // 只恢复「我们自己改过」的（用类名做标记），避免误改游戏刚渲染的普通头像
  function syncShinyEggPokemonIcon(card, shiny) {
    const image = card.querySelector('.egg-mon img');
    if (!image) return;
    const current = image.getAttribute('src') || '';
    if (shiny) {
      const desired = eggPokemonSpriteSource(current, true);
      if (desired !== current) image.setAttribute('src', desired);
      image.classList.toggle(SPRITE_CLASS, /(?:^|\/)assets\/pokemon\/shiny\//.test(desired));
    } else if (image.classList.contains(SPRITE_CLASS)) {
      const desired = eggPokemonSpriteSource(current, false);
      if (desired !== current) image.setAttribute('src', desired);
      image.classList.remove(SPRITE_CLASS);
    }
  }

  // ---------- 存档（只读） ----------
  function readSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const save = JSON.parse(raw);
      return save && typeof save === 'object' ? save : null;
    } catch (_) {
      return null;   // 读取失败 / JSON 非法 → 静默退出
    }
  }

  function eggMapOf(save) {
    const list = Array.isArray(save?.pension?.eggs) ? save.pension.eggs : [];
    const map = new Map();
    for (const egg of list) {
      if (egg && egg.uid != null) map.set(String(egg.uid), egg);
    }
    return map;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = '#pen-eggs .' + MARK_CLASS + ' { margin-inline-start: 4px; }';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- 扫描 ----------
  let grid = null;
  let observer = null;
  let timer = 0;
  let discoveryTimer = 0;
  let enabled = true;

  function scheduleScan() {
    if (!enabled) return;
    if (!timer) timer = setTimeout(() => { timer = 0; scan(); }, 0);
  }

  // 网格存在时由 MutationObserver 实时驱动；这里只低频发现“刚进入/离开培育屋”。
  function scheduleDiscovery() {
    if (!enabled || discoveryTimer) return;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = 0;
      if (!enabled) return;
      scheduleScan();
      scheduleDiscovery();
    }, grid && grid.isConnected ? 5000 : 2500);
  }

  // 关掉开关时：把标记和头像恢复原样，并停掉观察（不留文档级监听）
  function teardownDom() {
    if (grid) {
      grid.querySelectorAll('.pen-egg .' + MARK_CLASS).forEach((m) => { try { m.remove(); } catch (_) {} });
      grid.querySelectorAll('.pen-egg img.' + SPRITE_CLASS).forEach((img) => {
        try {
          const cur = img.getAttribute('src') || '';
          const desired = eggPokemonSpriteSource(cur, false);
          if (desired !== cur) img.setAttribute('src', desired);
          img.classList.remove(SPRITE_CLASS);
        } catch (_) {}
      });
    } else {
      document.querySelectorAll('#pen-eggs .' + MARK_CLASS).forEach((m) => { try { m.remove(); } catch (_) {} });
    }
    if (observer) { try { observer.disconnect(); } catch (_) {} }
    observer = null;
    grid = null;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = 0; }
  }

  function scan() {
    if (!enabled) return;
    ensureStyle();

    const next = document.querySelector('#pen-eggs');
    if (next !== grid) {
      // 蛋网格被替换：先丢掉旧观察器，避免泄漏到已移除的节点
      if (observer) { try { observer.disconnect(); } catch (_) {} }
      if (timer) { clearTimeout(timer); timer = 0; }
      grid = next;
      if (grid) {
        observer = observer || new MutationObserver(scheduleScan);
        observer.observe(grid, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['data-egg'],
        });
      }
    }
    if (!grid || !grid.isConnected) return;
    const cards = grid.querySelectorAll('.pen-egg[data-egg]');
    if (!cards.length) return;

    const save = readSave();
    const eggs = eggMapOf(save);

    for (const card of cards) {
      const egg = eggs.get(card.dataset.egg);
      const shiny = isShinyEgg(egg, save);
      syncShinyEggPokemonIcon(card, shiny);

      const name = card.querySelector('.meta > b');
      if (!name) continue;
      const markers = [...name.querySelectorAll('.' + MARK_CLASS)];
      const nativeMarker = name.querySelector('.shiny-mk:not(.' + MARK_CLASS + ')');
      if (!shiny || nativeMarker) {
        markers.forEach((marker) => marker.remove());
        continue;
      }
      markers.slice(1).forEach((marker) => marker.remove());
      if (markers.length) continue;

      const marker = document.createElement('i');
      marker.className = 'shiny-mk ' + MARK_CLASS;
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', '异色蛋');
      marker.title = '异色蛋';
      name.append(marker);
    }
  }

  // 存档变化（换存档 / 收蛋 / 新蛋）时重扫
  window.addEventListener('storage', (event) => {
    if ((event.key === SAVE_KEY || event.key === null) && grid && grid.isConnected) scheduleScan();
  });

  // ---------- 开关 ----------
  function setEnabled(on) {
    const want = on !== false;
    if (want === enabled) {
      if (want) {
        scheduleScan();   // 已经开着也重扫一次，处理「刚进培育屋」
        scheduleDiscovery();
      }
      return;
    }
    enabled = want;
    if (!enabled) { teardownDom(); return; }
    scheduleScan();
    scheduleDiscovery();
  }

  // 暴露给启动器设置页（只有命名空间内的方法，不外挂业务函数到全局）
  window.__pcShinyEggPreview = {
    version: VERSION,
    set: setEnabled,
    scan: scheduleScan,
    isShinyEgg,          // 仅供自检 / 调试
    hash: fixedEggHash,
  };

  // 启动：读设置决定是否开启；培育屋可能还没渲染，靠定时器 + 观察器兜住
  Promise.resolve(L.getSettings && L.getSettings())
    .then((s) => setEnabled(!s || s.shinyEgg !== false))
    .catch(() => setEnabled(true));
})();
