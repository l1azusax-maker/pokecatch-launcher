const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  gameUrl: 'https://pokecatch-online.app/',

  // ============ 设置 ============
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  reloadGame: () => ipcRenderer.send('reload-game'),
  onSettingsChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, settings) => cb(settings);
    ipcRenderer.on('settings-changed', listener);
    return () => ipcRenderer.removeListener('settings-changed', listener);
  },

  // ============ 启动器版本与自动更新 ============
  appInfo: () => ipcRenderer.invoke('app-info'),
  getAppUpdateState: () => ipcRenderer.invoke('app-update-state'),
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  installAppUpdate: () => ipcRenderer.invoke('install-app-update'),
  onAppUpdateState: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('app-update-state', listener);
    return () => ipcRenderer.removeListener('app-update-state', listener);
  },

  // ============ 油猴脚本 ============
  readScripts: () => ipcRenderer.invoke('read-scripts'),
  importScriptFromUrl: (url, filename) => ipcRenderer.invoke('import-script-from-url', { url, filename }),
  checkScriptUpdate: (name) => ipcRenderer.invoke('check-script-update', { name }),
  applyScriptUpdate: (name, updateToken) => ipcRenderer.invoke('apply-script-update', { name, updateToken }),
  toggleScriptEnabled: (name, enabled) => ipcRenderer.invoke('toggle-script-enabled', { name, enabled }),
  deleteScript: (name) => ipcRenderer.invoke('delete-script', name),
  pickScriptFile: () => ipcRenderer.invoke('pick-script-file'),
  openScriptsDir: () => ipcRenderer.invoke('open-scripts-dir'),
  // 导入 / 更新完脚本后，交给主进程走「关设置 → 弹刷新提示」的流程
  // kind: 'import' | 'update'；items: [{ name, from?, to? }]
  promptScriptRefresh: (payload) => ipcRenderer.send('script-change-prompt', payload),
  // 设置页开着时，后台自动更新完成的通知
  onScriptsUpdated: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, count) => cb(count);
    ipcRenderer.on('scripts-updated', listener);
    return () => ipcRenderer.removeListener('scripts-updated', listener);
  },

  // ============ 托盘角标上报 ============
  reportReadyEggs: (count) => ipcRenderer.send('ready-eggs-count', Number(count) || 0),

  // ============ 离线兜底页专用（主进程仅对 offline.html 放行） ============
  offlineRetry: () => ipcRenderer.send('offline-retry'),
});
