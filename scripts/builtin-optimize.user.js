// ============================================================
// Poke'Catch 内置优化脚本（默认启用）
// 由启动器在游戏页面加载完成后注入
//
// 只有一条纯性能规则：字体抗锯齿。
// 设在 html 上靠继承生效（-webkit-font-smoothing 是继承属性），不要用 `*` ——
// Chromium 会把「右端没有 class/id/标签」的选择器放进「通用失效集」，页面里任何
// 一次 class / 属性变更都要全文档重算样式。这游戏是 DOM 密集型（战斗页一帧动几十
// 上百个节点、开一次面板插入上千个节点），实测同一界面 94fps → 120fps，
// 「插入 300 节点并强制样式+布局」4.4ms → 3.8ms。
// ============================================================
(() => {
  'use strict';

  if (window.__pcOptimizeInstalled) return;   // 导航/重载时可能被注入多次
  window.__pcOptimizeInstalled = true;

  const STYLE_ID = 'pc-optimize-style';

  const CSS = `
    html { -webkit-font-smoothing: antialiased; }
    /* 消除弹窗全屏实时高斯模糊合成开销，保留原有半透明暗色遮罩 */
    .modal-root {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    /* 将设置弹窗滚动容器提升为独立合成层并隔离重绘，避免滚轮滚动连带整窗重绘 */
    .opt-modal {
      contain: layout style;
    }
    .opt-modal .gd-page {
      contain: layout paint;
      will-change: scroll-position;
    }
  `;

  function apply() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    } catch (_) {}
  }

  apply();
  // 游戏偶尔会在别处重建 <head>（SPA 里换页）；样式丢了就补回来
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  }

  // 修复游戏地下通道转场（CaptureFX.dither）在卡片隐藏/最小化尺寸为 0x0 时
  // 调用 createImageData(0, 0) 抛出 IndexSizeError，导致 bay._wiping 永久卡在 true、
  // 探险队伍动画静止且探索结束后不弹出「领取」界面的问题。
  try {
    const proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    if (proto && typeof proto.createImageData === 'function' && !proto.__pcSafeCreateImageData) {
      const origCreateImageData = proto.createImageData;
      proto.createImageData = function (sw, sh) {
        if (typeof sw === 'number' && typeof sh === 'number' && (sw <= 0 || sh <= 0)) {
          return origCreateImageData.call(this, Math.max(1, sw || 0), Math.max(1, sh || 0));
        }
        return origCreateImageData.apply(this, arguments);
      };
      proto.__pcSafeCreateImageData = true;
    }
  } catch (_) {}

  // 兜底自愈：若某个 .ug-bay 的 _wiping 异常持续超过 3.5 秒，自动复位并清理残留转场画布。
  const wipeSince = new WeakMap();
  setInterval(() => {
    try {
      if (document.hidden) return;
      const screen = document.querySelector('#screen-underground.active');
      if (!screen) return;
      const bays = screen.querySelectorAll('.ug-bay[data-bay]');
      const now = Date.now();
      for (let i = 0; i < bays.length; i++) {
        const bay = bays[i];
        if (bay._wiping) {
          const since = wipeSince.get(bay);
          if (!since) {
            wipeSince.set(bay, now);
          } else if (now - since > 3500) {
            bay._wiping = false;
            wipeSince.delete(bay);
            const scene = bay.querySelector('.ug-scene');
            if (scene) {
              scene.classList.remove('leaving', 'entering');
              const dithers = scene.querySelectorAll('canvas.fx-dither');
              for (let j = 0; j < dithers.length; j++) dithers[j].remove();
            }
          }
        } else if (wipeSince.has(bay)) {
          wipeSince.delete(bay);
        }
      }
    } catch (_) {}
  }, 1500);
})();
