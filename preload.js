const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  gameUrl: 'https://pokecatch-online.netlify.app/',

  // ============ 设置 ============
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  // 启动器自身版本（「关于」里显示，方便确认装的是不是新版）
  appInfo: () => ipcRenderer.invoke('app-info'),

  // ============ 油猴脚本 ============
  readScripts: () => ipcRenderer.invoke('read-scripts'),
  importScriptFromUrl: (url, filename) => ipcRenderer.invoke('import-script-from-url', { url, filename }),
  checkScriptUpdate: (name) => ipcRenderer.invoke('check-script-update', { name }),
  applyScriptUpdate: (name, updateToken) => ipcRenderer.invoke('apply-script-update', { name, updateToken }),
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

});
