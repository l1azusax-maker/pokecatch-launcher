'use strict';

// 5x7 清晰像素字形（用于托盘 32x32 图标右下角角标，缩放到 16x16 仍清晰可辨）
const DIGITS_5X7 = Object.freeze({
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
});

// 在 32x32 BGRA 位图右下角叠加高对比度圆角红底数字角标（纯 Buffer 运算，无第三方依赖）
function drawBadgeOnBgraBitmap(bgra, width, height, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const out = Buffer.from(bgra);
  if (n <= 0 || width < 16 || height < 16) return out;

  const text = n > 99 ? '99' : String(n);
  const twoDigits = text.length >= 2;

  const scaleX = twoDigits ? 1 : 2;
  const scaleY = twoDigits ? 2 : 2;
  const glyphW = 5 * scaleX;
  const glyphH = 7 * scaleY;
  const gap = twoDigits ? 2 : 0;
  const textW = text.length * glyphW + (text.length - 1) * gap;

  const padX = twoDigits ? 3 : 4;
  const padY = 2;
  const badgeW = Math.min(width, textW + padX * 2);
  const badgeH = Math.min(height, glyphH + padY * 2);
  const x0 = width - badgeW;
  const y0 = height - badgeH;
  const radius = Math.min(Math.floor(badgeH / 2), 6);

  // Electron nativeImage bitmap 在 Windows 上是 BGRA 预乘格式
  const setPixel = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    out[i] = b;
    out[i + 1] = g;
    out[i + 2] = r;
    out[i + 3] = a;
  };

  const inRoundedRect = (px, py, rx0, ry0, rw, rh, rad) => {
    const rx1 = rx0 + rw - 1;
    const ry1 = ry0 + rh - 1;
    if (px < rx0 || px > rx1 || py < ry0 || py > ry1) return false;
    const cx = px < rx0 + rad ? rx0 + rad : (px > rx1 - rad ? rx1 - rad : px);
    const cy = py < ry0 + rad ? ry0 + rad : (py > ry1 - rad ? ry1 - rad : py);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= rad * rad + 0.5;
  };

  // 先画 1px 深色外描边，把角标和精灵球红白底清晰分开，再填亮红底
  for (let y = Math.max(0, y0 - 1); y < height; y++) {
    for (let x = Math.max(0, x0 - 1); x < width; x++) {
      if (inRoundedRect(x, y, x0, y0, badgeW, badgeH, radius)) {
        setPixel(x, y, 232, 42, 52, 255);
      } else if (inRoundedRect(x, y, x0 - 1, y0 - 1, badgeW + 2, badgeH + 2, radius + 1)) {
        setPixel(x, y, 20, 24, 38, 255);
      }
    }
  }

  // 绘制纯白像素数字
  const startX = x0 + Math.floor((badgeW - textW) / 2);
  const startY = y0 + Math.floor((badgeH - glyphH) / 2);
  for (let ci = 0; ci < text.length; ci++) {
    const rows = DIGITS_5X7[text[ci]];
    if (!rows) continue;
    const gx = startX + ci * (glyphW + gap);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '1') continue;
        for (let sy = 0; sy < scaleY; sy++) {
          for (let sx = 0; sx < scaleX; sx++) {
            setPixel(gx + c * scaleX + sx, startY + r * scaleY + sy, 255, 255, 255, 255);
          }
        }
      }
    }
  }

  return out;
}

function createTrayBadgeRenderer({ nativeImage, baseIcon, basePngPath }) {
  const cache = new Map();
  let baseBitmap32 = null;

  function ensureBaseBitmap() {
    if (baseBitmap32) return baseBitmap32;
    try {
      const src = basePngPath ? nativeImage.createFromPath(basePngPath) : baseIcon;
      if (!src || src.isEmpty()) return null;
      const resized = src.resize({ width: 32, height: 32, quality: 'best' });
      const size = resized.getSize();
      const buf = resized.toBitmap();
      if (!buf || buf.length < size.width * size.height * 4) return null;
      baseBitmap32 = { buf, width: size.width, height: size.height };
      return baseBitmap32;
    } catch (_) {
      return null;
    }
  }

  return function getTrayIconForCount(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0) return baseIcon;
    const key = Math.min(n, 99);
    if (cache.has(key)) return cache.get(key);
    const base = ensureBaseBitmap();
    if (!base) return baseIcon;
    try {
      const badged = drawBadgeOnBgraBitmap(base.buf, base.width, base.height, key);
      const img = nativeImage.createFromBitmap(badged, { width: base.width, height: base.height });
      if (!img || img.isEmpty()) return baseIcon;
      cache.set(key, img);
      return img;
    } catch (_) {
      return baseIcon;
    }
  };
}

function countReadyEggsFromSave(save, now = Date.now()) {
  const eggs = Array.isArray(save && save.pension && save.pension.eggs) ? save.pension.eggs : [];
  let ready = 0;
  for (const egg of eggs) {
    if (!egg || typeof egg !== 'object') continue;
    const hatchAt = Number(egg.hatchAt);
    if (Number.isFinite(hatchAt) && hatchAt > 0 && now >= hatchAt) {
      ready++;
    }
  }
  return ready;
}

module.exports = {
  drawBadgeOnBgraBitmap,
  createTrayBadgeRenderer,
  countReadyEggsFromSave,
};
