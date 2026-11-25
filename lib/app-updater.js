'use strict';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function setupAppUpdater({
  app,
  dialog,
  getMainWindow,
  onStatus = () => {},
  log = console,
  autoUpdaterImpl = null,
}) {
  const currentVersion = (() => {
    try { return app.getVersion(); } catch (_) { return ''; }
  })();

  let status = {
    state: 'idle',
    currentVersion,
    availableVersion: '',
    percent: 0,
    message: '',
    checkedAt: 0,
  };

  function emit(patch) {
    status = { ...status, ...patch };
    try { onStatus({ ...status }); } catch (_) {}
    return { ...status };
  }

  const disabled = !app.isPackaged || process.env.PC_DISABLE_AUTO_UPDATE === '1';
  if (disabled && !autoUpdaterImpl) {
    status = {
      ...status,
      state: 'unsupported',
      message: '开发模式不检查安装包更新',
    };
    return {
      autoUpdater: null,
      getStatus: () => ({ ...status }),
      check: async () => ({ ok: false, ...status }),
      install: () => ({ ok: false, error: '当前模式不支持自动安装更新' }),
      dispose: () => {},
    };
  }

  const autoUpdater = autoUpdaterImpl || require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  let checkingPromise = null;
  let promptedVersion = '';

  autoUpdater.on('checking-for-update', () => {
    log.debug('[updater] checking');
    emit({ state: 'checking', message: '正在检查更新…', percent: 0 });
  });

  autoUpdater.on('update-available', (info) => {
    const version = (info && info.version) || '';
    log.debug('[updater] available', version);
    emit({
      state: 'available',
      availableVersion: version,
      percent: 0,
      message: version ? `发现新版本 v${version}，正在下载…` : '发现新版本，正在下载…',
      checkedAt: Date.now(),
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    const version = (info && info.version) || currentVersion;
    log.debug('[updater] current', version);
    emit({
      state: 'not-available',
      availableVersion: '',
      percent: 0,
      message: currentVersion ? `已是最新版本（v${currentVersion}）` : '已是最新版本',
      checkedAt: Date.now(),
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0)));
    log.debug('[updater] download', percent + '%');
    emit({
      state: 'downloading',
      percent,
      message: status.availableVersion
        ? `正在下载 v${status.availableVersion}（${percent}%）`
        : `正在下载更新（${percent}%）`,
    });
  });

  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) ? String(err.message) : '检查更新失败';
    log.error('[updater] error', err);
    emit({
      state: 'error',
      message: msg,
      checkedAt: Date.now(),
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const version = (info && info.version) || status.availableVersion || '';
    emit({
      state: 'downloaded',
      availableVersion: version,
      percent: 100,
      message: version ? `v${version} 已下载就绪，重启后完成安装` : '更新已下载就绪，重启后完成安装',
      checkedAt: Date.now(),
    });
    if (promptedVersion === version && version) return;
    promptedVersion = version;

    const options = {
      type: 'info',
      title: '启动器更新已就绪',
      message: `PokeCatch ${version || ''} 已下载完成`.trim(),
      detail: '现在重启即可完成更新；也可以稍后关闭启动器时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    try {
      const win = getMainWindow();
      const result = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      log.error('[updater] prompt failed', err);
    }
  });

  const check = async () => {
    if (status.state === 'downloaded') return { ok: true, ...status };
    if (status.state === 'downloading') return { ok: true, ...status };
    if (checkingPromise) return checkingPromise;
    checkingPromise = (async () => {
      try {
        await autoUpdater.checkForUpdates();
        return { ok: status.state !== 'error', ...status };
      } catch (err) {
        log.error('[updater] check failed', err);
        const msg = (err && err.message) ? String(err.message) : '检查更新失败';
        emit({ state: 'error', message: msg, checkedAt: Date.now() });
        return { ok: false, ...status };
      } finally {
        checkingPromise = null;
      }
    })();
    return checkingPromise;
  };

  const install = () => {
    if (status.state !== 'downloaded') {
      return { ok: false, error: '当前没有已下载完成的更新' };
    }
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '重启安装失败' };
    }
  };

  const initialTimer = setTimeout(() => { check(); }, 5000);
  const interval = setInterval(() => { check(); }, CHECK_INTERVAL_MS);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();
  if (typeof interval.unref === 'function') interval.unref();

  return {
    autoUpdater,
    getStatus: () => ({ ...status }),
    check,
    install,
    dispose: () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
}

module.exports = { setupAppUpdater, CHECK_INTERVAL_MS };
