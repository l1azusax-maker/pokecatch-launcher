// ============================================================
// 地下通道掉落预览（内置脚本，可在设置里开关）
//
// 实现依据：游戏客户端 Underground 模块核验
//   - 每次地下通道任务开始时，游戏会将整轮模拟结果预存在本地存档
//     localStorage['gachamon-save-v1'] -> under.slots[i].res.loot（按楼层数组）。
//   - 已到达楼层的掉落由游戏原生正常渲染；尚未到达楼层的剩余掉落，
//     按游戏原生 .ug-loot / .mp-it.ug-li 结构与排序显示，并叠加偏灰色遮罩。
//
// 硬性边界：
//   - 只读 localStorage['gachamon-save-v1']（局部切片提取 under.slots，不做整份存档 JSON.parse）；
//   - 绝不写入 / 修改存档或游戏内部对象；
//   - 仅在地下通道页面（#screen-underground.active）激活时工作，切换其他页面零开销。
// ============================================================
(() => {
  'use strict';

  const L = window.launcher;
  if (!L) return;
  if (window.__pcUndergroundLootInstalled) return;
  window.__pcUndergroundLootInstalled = true;

  const SAVE_KEY = 'gachamon-save-v1';
  const CLOCK_KEY = 'pokecatch.clock';
  const STEP_MS = 2800; // CONFIG.UNDERGROUND.STEP_MS
  const STYLE_ID = 'pc-ug-loot-preview-style';
  const PREVIEW_CLASS = 'pc-ug-prev';

  const GEODE_TIERS = ['common', 'uncommon', 'rare', 'legendary'];
  const FOSSIL_ITEMS = Object.freeze({
    138: 'helix-fossil',
    140: 'dome-fossil',
    142: 'old-amber',
    345: 'root-fossil',
    347: 'claw-fossil',
    408: 'skull-fossil',
    410: 'armor-fossil',
    564: 'cover-fossil',
    566: 'plume-fossil',
  });

  const CSS = `
    .ug-loot .mp-it.${PREVIEW_CLASS} {
      position: relative;
      background: color-mix(in srgb, var(--sunken, #1b2030) 62%, transparent);
      border: 2px dashed rgba(255, 255, 255, .34);
    }
    :root[data-theme="light"] .ug-loot .mp-it.${PREVIEW_CLASS} {
      border-color: rgba(45, 58, 82, .34);
    }
    .ug-loot .mp-it.${PREVIEW_CLASS} img {
      opacity: .72;
      filter: saturate(.85) brightness(.9);
    }
    .ug-loot .mp-it.${PREVIEW_CLASS} .it-c {
      position: absolute;
      z-index: 2;
      opacity: .92;
    }
    .ug-loot .ug-money.${PREVIEW_CLASS} {
      color: var(--muted, #9aa4b2);
      opacity: .78;
      border-bottom: 1px dashed currentColor;
      height: auto;
      line-height: 1.2;
    }
  `;

  let enabled = true;
  let lastSlotsSlice = null;
  let lastParsedSlots = [];
  let observer = null;
  let syncTimer = 0;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function findMatchingBracket(str, openIdx, openChar, closeChar) {
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = openIdx; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function extractUnderSlotsSlice(raw) {
    const pNeedle = '"under":';
    let pIdx = raw.indexOf(pNeedle);
    while (pIdx !== -1) {
      let braceStart = pIdx + pNeedle.length;
      while (braceStart < raw.length && raw[braceStart] <= ' ') braceStart++;
      if (raw[braceStart] === '{') {
        const braceEnd = findMatchingBracket(raw, braceStart, '{', '}');
        if (braceEnd === -1) return null;
        const sub = raw.slice(braceStart, braceEnd + 1);
        const cNeedle = '"slots":';
        let cIdx = sub.indexOf(cNeedle);
        while (cIdx !== -1) {
          let arrStart = cIdx + cNeedle.length;
          while (arrStart < sub.length && sub[arrStart] <= ' ') arrStart++;
          if (sub[arrStart] === '[') {
            const arrEnd = findMatchingBracket(sub, arrStart, '[', ']');
            if (arrEnd !== -1) return sub.slice(arrStart, arrEnd + 1);
          }
          cIdx = sub.indexOf(cNeedle, cIdx + cNeedle.length);
        }
        return '[]';
      }
      pIdx = raw.indexOf(pNeedle, pIdx + pNeedle.length);
    }
    return '[]';
  }

  function readUnderSlots() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) {
        lastSlotsSlice = null;
        lastParsedSlots = [];
        return lastParsedSlots;
      }
      const slice = extractUnderSlotsSlice(raw);
      if (slice === null) return [];
      if (slice === lastSlotsSlice) return lastParsedSlots;
      const parsed = JSON.parse(slice);
      lastSlotsSlice = slice;
      lastParsedSlots = Array.isArray(parsed) ? parsed : [];
      return lastParsedSlots;
    } catch (_) {
      return [];
    }
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

  // 与游戏 Underground.progress(slot, now) 保持一致
  function computeProgress(slot, now) {
    const res = slot && slot.res;
    if (!res || typeof res !== 'object') return { floor: 0, done: true };
    const t = slot.recalled != null ? Number(slot.recalled) : now;
    const start = Number(slot.start) || 0;
    const end = Number(slot.end) || 0;
    const steps = (t - start) / STEP_MS;
    const at = Array.isArray(res.at) ? res.at : [];
    let floor = 0;
    while (floor < at.length && Number(at[floor]) <= steps) floor++;
    const done = t >= end || slot.recalled != null;
    if (done && slot.recalled == null) floor = Number(res.floors) || floor;
    return { floor, done };
  }

  // 汇总 [fromFloor, toFloor) 区间内尚未获得的掉落（与游戏 Underground.lootSum 对齐）
  function sumPendingLoot(slot, fromFloor, toFloor) {
    const out = { money: 0, shards: 0, items: Object.create(null), geodes: [0, 0, 0, 0], plates: [], fossils: [] };
    const loot = Array.isArray(slot && slot.res && slot.res.loot) ? slot.res.loot : [];
    const start = Math.max(0, Math.floor(fromFloor || 0));
    const end = Math.min(loot.length, Math.max(start, Math.floor(toFloor || 0)));
    for (let f = start; f < end; f++) {
      const entries = loot[f];
      if (!Array.isArray(entries)) continue;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || typeof entry !== 'object') continue;
        if (entry.k === 'money') out.money += Number(entry.n) || 0;
        else if (entry.k === 'shards') out.shards += Number(entry.n) || 0;
        else if (entry.k === 'item' && entry.id) out.items[entry.id] = (out.items[entry.id] || 0) + 1;
        else if (entry.k === 'geode' && entry.t >= 0 && entry.t < 4) out.geodes[entry.t]++;
        else if (entry.k === 'plate' && entry.type) out.plates.push(entry);
        else if (entry.k === 'fossil' && entry.id != null) out.fossils.push(entry);
      }
    }
    return out;
  }

  // 按游戏原生 Za() 排序与图标规则生成预览条目
  function buildPendingEntries(pending) {
    const list = [];
    for (let i = 0; i < pending.fossils.length; i++) {
      const f = pending.fossils[i];
      const itemSlug = FOSSIL_ITEMS[f.id] || 'old-amber';
      list.push({
        src: `assets/items/${itemSlug}.png`,
        n: 1,
        rank: 9,
        tip: `fossil:${f.id}`,
      });
    }
    for (let i = 0; i < pending.plates.length; i++) {
      const p = pending.plates[i];
      list.push({
        src: `assets/items/plate-${p.type}.png`,
        n: 1,
        rank: 8,
        tip: `plate:${p.type}`,
      });
    }
    for (let t = 0; t < pending.geodes.length; t++) {
      const count = pending.geodes[t];
      if (!count) continue;
      list.push({
        src: `assets/ui/underground/geode-${GEODE_TIERS[t] || 'common'}.png`,
        n: count,
        rank: 4 + t,
        tip: `geode:${t}`,
      });
    }
    const itemKeys = Object.keys(pending.items);
    for (let i = 0; i < itemKeys.length; i++) {
      const id = itemKeys[i];
      const count = pending.items[id];
      if (!count) continue;
      list.push({
        src: `assets/items/${id}.png`,
        n: count,
        rank: id === 'rare-candy' || id.endsWith('-berry') ? 2 : 3,
        tip: `item:${id}`,
      });
    }
    if (pending.shards > 0) {
      list.push({
        src: 'assets/items/event-shard.png',
        n: pending.shards,
        rank: 1,
        tip: 'item:event-shard',
      });
    }
    list.sort((a, b) => b.rank - a.rank);
    return list;
  }

  function fmtNum(n) {
    return Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('en-US');
  }

  function slotForBay(slots, bayIndex, slotsMax) {
    const exact = slots.find((s) => s && s.bay === bayIndex);
    if (exact) return exact;
    const fallback = slots.filter(
      (s) => s && (
        s.bay == null
        || s.bay >= slotsMax
        || slots.some((o) => o !== s && o.bay === s.bay && slots.indexOf(o) < slots.indexOf(s))
      )
    );
    const freeBays = [];
    for (let i = 0; i < slotsMax; i++) {
      if (!slots.some((s) => s && s.bay === i && !fallback.includes(s))) freeBays.push(i);
    }
    return fallback[freeBays.indexOf(bayIndex)] || null;
  }

  function clearPreviewFromBox(box) {
    const prevNodes = box.querySelectorAll(`.${PREVIEW_CLASS}`);
    for (let i = 0; i < prevNodes.length; i++) prevNodes[i].remove();
    delete box.dataset.pcUgPrevSig;
  }

  function clearAllPreviews() {
    const boxes = document.querySelectorAll('#screen-underground .ug-loot[data-p="loot"]');
    for (let i = 0; i < boxes.length; i++) clearPreviewFromBox(boxes[i]);
  }

  function renderPreviewIntoBox(box, slot, now) {
    if (!slot || !slot.res || !Array.isArray(slot.res.loot)) {
      clearPreviewFromBox(box);
      return;
    }
    const prog = computeProgress(slot, now);
    const totalFloors = Math.max(0, Number(slot.res.floors) || 0);
    if (prog.done || prog.floor >= totalFloors) {
      clearPreviewFromBox(box);
      return;
    }

    const pending = sumPendingLoot(slot, prog.floor, totalFloors);
    const entries = buildPendingEntries(pending);
    if (pending.money <= 0 && entries.length === 0) {
      clearPreviewFromBox(box);
      return;
    }

    const sig = `${slot.id || ''}|${prog.floor}|${pending.money}|${entries.map((e) => `${e.tip}:${e.n}`).join(',')}`;
    // 若游戏刚重置了 innerHTML（导致之前的预览节点被清掉），即便 sig 相同也要重新挂载
    const hasExisting = !!box.querySelector(`.${PREVIEW_CLASS}`);
    if (box.dataset.pcUgPrevSig === sig && hasExisting) return;

    clearPreviewFromBox(box);
    const frag = document.createDocumentFragment();

    if (pending.money > 0) {
      const moneyEl = document.createElement('span');
      moneyEl.className = `ug-li ug-money ${PREVIEW_CLASS}`;
      moneyEl.title = '任务完成前还将获得的金钱';
      moneyEl.textContent = `+${fmtNum(pending.money)} ₽`;
      frag.appendChild(moneyEl);
    }

    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      const chip = document.createElement('span');
      chip.className = `mp-it ug-li ${PREVIEW_CLASS}`;
      chip.setAttribute('data-ftip', item.tip);

      const img = document.createElement('img');
      // 若页面里已渲染过同种道具图标（例如特殊浆果路径），优先复用其 src
      const existingImg = box.querySelector(`[data-ftip="${item.tip}"] img`);
      img.src = (existingImg && existingImg.getAttribute('src')) || item.src;
      img.alt = '';
      chip.appendChild(img);

      if (item.n > 1) {
        const badge = document.createElement('b');
        badge.className = 'it-c';
        badge.textContent = fmtNum(item.n);
        chip.appendChild(badge);
      }
      frag.appendChild(chip);
    }

    box.appendChild(frag);
    box.dataset.pcUgPrevSig = sig;
  }

  function syncNow() {
    if (!enabled) {
      clearAllPreviews();
      return;
    }
    const screen = document.querySelector('#screen-underground.active');
    if (!screen) return;

    ensureStyle();
    const bays = screen.querySelectorAll('.ug-bay[data-bay]');
    if (!bays.length) return;

    const slots = readUnderSlots();
    const now = getGameNow();
    let maxBay = 0;
    for (let i = 0; i < bays.length; i++) {
      const idx = Number(bays[i].getAttribute('data-bay'));
      if (Number.isFinite(idx) && idx + 1 > maxBay) maxBay = idx + 1;
    }
    const slotsMax = Math.max(1, maxBay);

    for (let i = 0; i < bays.length; i++) {
      const bay = bays[i];
      const box = bay.querySelector('.ug-loot[data-p="loot"]');
      if (!box) continue;
      const bayIndex = Number(bay.getAttribute('data-bay'));
      if (!Number.isFinite(bayIndex)) continue;
      const slot = slotForBay(slots, bayIndex, slotsMax);
      renderPreviewIntoBox(box, slot, now);
    }
  }

  function scheduleSync(delayMs = 80) {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = 0;
      syncNow();
    }, delayMs);
  }

  function startObserver() {
    if (observer) return;
    const root = document.getElementById('screen-underground') || document.body || document.documentElement;
    if (!root) return;
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      // 忽略我们自己插入/删除预览节点触发的变更，避免无谓循环
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'attributes') {
          scheduleSync(40);
          return;
        }
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (nodes.some((n) => !(n && n.nodeType === 1 && n.classList && n.classList.contains(PREVIEW_CLASS)))) {
          scheduleSync(40);
          return;
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  window.__pcUndergroundLootPreview = {
    set(next) {
      enabled = next !== false;
      if (enabled) syncNow();
      else clearAllPreviews();
    },
    sync: syncNow,
    isEnabled: () => enabled,
  };

  Promise.resolve(L.getSettings && L.getSettings())
    .then((s) => {
      enabled = !s || s.undergroundPreview !== false;
      startObserver();
      syncNow();
    })
    .catch(() => {
      startObserver();
      syncNow();
    });

  if (typeof L.onSettingsChanged === 'function') {
    L.onSettingsChanged((s) => {
      if (!s || typeof s !== 'object') return;
      if ('undergroundPreview' in s) {
        window.__pcUndergroundLootPreview.set(s.undergroundPreview !== false);
      }
    });
  }

  window.addEventListener('pagehide', () => {
    if (syncTimer) clearTimeout(syncTimer);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }, { once: true });
})();
