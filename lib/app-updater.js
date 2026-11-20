'use strict';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function setupAppUpdater({ app, dialog, getMainWindow, log = console }) {
  if (!app.isPackaged || process.env.PC_DISABLE_AUTO_UPDATE === '1') return null;

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => log.debug('[updater] checking'));
  autoUpdater.on('update-available', (info) => log.debug('[updater] available', info.version));
  autoUpdater.on('update-not-available', (info) => log.debug('[updater] current', info.version));
  autoUpdater.on('download-progress', (progress) => {
    log.debug('[updater] download', Math.round(progress.percent || 0) + '%');
  });
  autoUpdater.on('error', (err) => log.error('[updater] error', err));
  autoUpdater.on('update-downloaded', async (info) => {
    const options = {
      type: 'info',
      title: '启动器更新已就绪',
      message: `PokeCatch ${info.version} 已下载完成`,
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

  const check = () => autoUpdater.checkForUpdates().catch((err) => log.error('[updater] check failed', err));
  const initialTimer = setTimeout(check, 5000);
  const interval = setInterval(check, CHECK_INTERVAL_MS);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();
  if (typeof interval.unref === 'function') interval.unref();

  return { autoUpdater, check, dispose: () => { clearTimeout(initialTimer); clearInterval(interval); } };
}

module.exports = { setupAppUpdater, CHECK_INTERVAL_MS };
