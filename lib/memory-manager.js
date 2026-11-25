'use strict';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const CDP_COMMAND_TIMEOUT_MS = 3000;

function sumProcessMemoryKB(metrics) {
  let totalKB = 0;
  for (const proc of Array.isArray(metrics) ? metrics : []) {
    const mem = proc && proc.memory;
    if (!mem) continue;
    const kb = Number(mem.workingSetSize || mem.privateBytes || 0);
    if (Number.isFinite(kb) && kb > 0) totalKB += kb;
  }
  return totalKB;
}

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('cdp-timeout')), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createMemoryManager({
  app,
  session,
  isGameUrl,
  isWindowVisible = () => true,
  dbg = () => {},
  intervalMs = DEFAULT_INTERVAL_MS,
  commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS,
}) {
  let collecting = false;
  let lastCleanupAt = 0;

  async function clearCodeCachesQuietly() {
    if (!session || typeof session.clearCodeCaches !== 'function') return false;
    try {
      await session.clearCodeCaches({});
      return true;
    } catch (err) {
      dbg('[memory] clearCodeCaches skipped', err && err.message ? err.message : String(err));
      return false;
    }
  }

  // 只使用最安全、带超时保护的 V8 HeapProfiler.collectGarbage；
  // 不再调用 Memory.simulatePressureNotification / Memory.forciblyPurgeJavaScriptMemory，
  // 避免在 Chromium/Electron 45 中触发渲染器或 Canvas/GPU 合成器冻结。
  async function runSafeGc(wc, { reason = 'scheduled', force = false, clearCodeCache = false } = {}) {
    if (!wc || wc.isDestroyed() || wc.isCrashed() || wc.isLoadingMainFrame()) {
      return { ok: false, skipped: true, reason: 'unavailable' };
    }
    if (!isGameUrl(wc.getURL()) || wc.isDevToolsOpened()) {
      return { ok: false, skipped: true, reason: 'not-game-or-devtools' };
    }
    if (!force && !isWindowVisible()) {
      return { ok: false, skipped: true, reason: 'window-hidden' };
    }
    if (collecting) {
      return { ok: false, skipped: true, reason: 'busy' };
    }
    const now = Date.now();
    if (!force && lastCleanupAt && now - lastCleanupAt < 60000) {
      return { ok: false, skipped: true, reason: 'cooldown' };
    }

    const client = wc.debugger;
    if (client.isAttached()) {
      return { ok: false, skipped: true, reason: 'debugger-attached' };
    }

    const beforeKB = (() => {
      try { return sumProcessMemoryKB(app.getAppMetrics()); } catch (_) { return 0; }
    })();

    collecting = true;
    try {
      if (clearCodeCache) {
        await clearCodeCachesQuietly();
      }
      client.attach();
      await withTimeout(client.sendCommand('HeapProfiler.collectGarbage'), commandTimeoutMs);
      lastCleanupAt = Date.now();

      const afterKB = (() => {
        try { return sumProcessMemoryKB(app.getAppMetrics()); } catch (_) { return 0; }
      })();
      const freedKB = Math.max(0, beforeKB - afterKB);
      dbg('[memory] safe gc complete', {
        reason,
        beforeMB: Math.round(beforeKB / 1024),
        afterMB: Math.round(afterKB / 1024),
        freedMB: Math.round(freedKB / 1024),
      });
      return {
        ok: true,
        beforeMB: Math.round(beforeKB / 1024),
        afterMB: Math.round(afterKB / 1024),
        freedMB: Math.round(freedKB / 1024),
      };
    } catch (err) {
      dbg('[memory] safe gc skipped', reason, err && err.message ? err.message : String(err));
      return { ok: false, error: err && err.message ? err.message : 'gc-failed' };
    } finally {
      collecting = false;
      try {
        if (!wc.isDestroyed() && client.isAttached()) client.detach();
      } catch (_) {}
    }
  }

  function scheduleFor(wc) {
    if (!wc || wc.isDestroyed()) return { dispose: () => {} };
    let disposed = false;

    const timer = setInterval(async () => {
      if (disposed || wc.isDestroyed()) return;
      await runSafeGc(wc, { reason: 'interval' });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    const dispose = () => {
      disposed = true;
      clearInterval(timer);
    };
    wc.once('destroyed', dispose);

    return { dispose };
  }

  return {
    runSafeGc,
    clearCodeCachesQuietly,
    scheduleFor,
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  CDP_COMMAND_TIMEOUT_MS,
  sumProcessMemoryKB,
  createMemoryManager,
};
