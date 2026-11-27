'use strict';

const zlib = require('zlib');

const DEFAULT_FLASH_INTERVAL_MS = 550;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// 编程生成标准 16x16 RGBA 全透明 PNG（IHDR + IDAT + IEND 完整 CRC32 校验），
// 作为 Windows 托盘图标闪烁的空白帧，零第三方依赖、跨 DPI 100% 有效。
function createTransparentPng(width = 16, height = 16) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4), 0);
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TRANSPARENT_PNG_16 = createTransparentPng(16, 16);

// 从存档中只抽取极小的 { id, at } 列表，调用方立刻释放整份存档对象，零常驻内存。
function extractAlertSchedules(save) {
  const eggItems = [];
  const eggs = Array.isArray(save && save.pension && save.pension.eggs) ? save.pension.eggs : [];
  for (let i = 0; i < eggs.length; i++) {
    const egg = eggs[i];
    if (!egg || typeof egg !== 'object') continue;
    const hatchAt = Number(egg.hatchAt);
    if (Number.isFinite(hatchAt) && hatchAt > 0) {
      const id = String(egg.uid != null ? egg.uid : (egg.k != null ? egg.k : `${hatchAt}:${i}`));
      eggItems.push({ id: 'egg:' + id, at: hatchAt });
    }
  }

  const underItems = [];
  const slots = Array.isArray(save && save.under && save.under.slots) ? save.under.slots : [];
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

  return { eggItems, underItems };
}

function evaluateAlertState(schedules, now = Date.now()) {
  const eggs = (schedules && schedules.eggItems) || [];
  const under = (schedules && schedules.underItems) || [];
  const readyIds = [];
  let readyEggs = 0;
  let readyUnderground = 0;
  let nextAt = Infinity;

  for (let i = 0; i < eggs.length; i++) {
    const item = eggs[i];
    if (now >= item.at) {
      readyEggs++;
      readyIds.push(item.id);
    } else if (item.at < nextAt) {
      nextAt = item.at;
    }
  }

  for (let i = 0; i < under.length; i++) {
    const item = under[i];
    if (now >= item.at) {
      readyUnderground++;
      readyIds.push(item.id);
    } else if (item.at < nextAt) {
      nextAt = item.at;
    }
  }

  const nextCheckMs = Number.isFinite(nextAt)
    ? Math.max(250, Math.min(15000, nextAt - now + 250))
    : 15000;

  return {
    readyEggs,
    readyUnderground,
    readyIds,
    shouldFlash: readyIds.length > 0,
    nextCheckMs,
  };
}

function formatMoneyText(money) {
  if (typeof money === 'string') {
    const trimmed = money.trim();
    if (trimmed) return trimmed;
  }
  if (typeof money === 'number' && Number.isFinite(money)) {
    return Math.max(0, Math.floor(money)).toLocaleString('en-US');
  }
  return '--';
}

function buildTooltip({ money = '', readyEggs = 0, readyUnderground = 0 } = {}) {
  const eggs = Math.max(0, Math.floor(Number(readyEggs) || 0));
  const under = Math.max(0, Math.floor(Number(readyUnderground) || 0));
  return [
    "Poke'Catch 启动器",
    `金钱总数：${formatMoneyText(money)}`,
    `孵化完成：${eggs}颗蛋`,
    `挖矿完成：${under}个队伍`,
  ].join('\n');
}

function createTrayFlasher({
  tray,
  normalIcon,
  nativeImage,
  isWindowForeground = () => false,
  intervalMs = DEFAULT_FLASH_INTERVAL_MS,
  dbg = () => {},
}) {
  let blankIcon = null;
  try {
    blankIcon = nativeImage.createFromBuffer(TRANSPARENT_PNG_16);
  } catch (_) {}

  let timer = null;
  let showingBlank = false;
  let active = false;
  let lastTooltip = '';
  let currentReadyIds = new Set();
  const acknowledgedIds = new Set();

  function setIconSafe(icon) {
    if (!tray || tray.isDestroyed() || !icon) return;
    try { tray.setImage(icon); } catch (err) {
      dbg('[tray] setImage failed', err && err.message ? err.message : String(err));
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    active = false;
    if (showingBlank) {
      showingBlank = false;
      setIconSafe(normalIcon);
    }
  }

  function start() {
    if (active) return;
    if (!blankIcon || (typeof blankIcon.isEmpty === 'function' && blankIcon.isEmpty())) {
      dbg('[tray] blank flash icon unavailable');
      return;
    }
    active = true;
    showingBlank = true;
    setIconSafe(blankIcon);
    timer = setInterval(() => {
      if (!tray || tray.isDestroyed()) { stop(); return; }
      showingBlank = !showingBlank;
      setIconSafe(showingBlank ? blankIcon : normalIcon);
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function hasUnreadReady() {
    for (const id of currentReadyIds) {
      if (!acknowledgedIds.has(id)) return true;
    }
    return false;
  }

  function acknowledgeCurrent() {
    for (const id of currentReadyIds) {
      acknowledgedIds.add(id);
    }
    stop();
  }

  function update(payload = {}) {
    const readyEggs = Math.max(0, Math.floor(Number(payload.readyEggs) || 0));
    const readyUnderground = Math.max(0, Math.floor(Number(payload.readyUnderground) || 0));
    const rawIds = Array.isArray(payload.readyIds) ? payload.readyIds : [];

    const nextSet = new Set();
    for (let i = 0; i < rawIds.length; i++) {
      const id = String(rawIds[i] || '').trim();
      if (id) nextSet.add(id);
    }
    // 若调用方仅传了计数而未传 readyIds，按计数兜底生成占位 ID。
    if (nextSet.size === 0 && (readyEggs > 0 || readyUnderground > 0)) {
      for (let i = 0; i < readyEggs; i++) nextSet.add(`egg:#${i}`);
      for (let i = 0; i < readyUnderground; i++) nextSet.add(`ug:#${i}`);
    }

    currentReadyIds = nextSet;
    // 清理已被玩家收蛋/领矿消耗掉的旧已读 ID，防止集合膨胀。
    for (const id of acknowledgedIds) {
      if (!currentReadyIds.has(id)) acknowledgedIds.delete(id);
    }

    const tooltip = buildTooltip({
      money: payload.money,
      readyEggs,
      readyUnderground,
    });
    if (tooltip !== lastTooltip) {
      lastTooltip = tooltip;
      if (tray && !tray.isDestroyed()) {
        try { tray.setToolTip(tooltip); } catch (_) {}
      }
    }

    if (currentReadyIds.size === 0) {
      stop();
      return;
    }

    // 窗口本身就在前台聚焦时，玩家正在看着游戏，自动标为已读不闪烁。
    if (isWindowForeground()) {
      acknowledgeCurrent();
      return;
    }

    if (hasUnreadReady()) start();
    else stop();
  }

  return {
    update,
    acknowledgeCurrent,
    stop,
    isFlashing: () => active,
    dispose: () => {
      stop();
      currentReadyIds.clear();
      acknowledgedIds.clear();
      lastTooltip = '';
    },
  };
}

module.exports = {
  createTransparentPng,
  TRANSPARENT_PNG_16,
  DEFAULT_FLASH_INTERVAL_MS,
  extractAlertSchedules,
  evaluateAlertState,
  formatMoneyText,
  buildTooltip,
  createTrayFlasher,
};
