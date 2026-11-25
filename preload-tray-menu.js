const { contextBridge, ipcRenderer } = require('electron');

// 托盘右键菜单窗口只暴露菜单状态读取、固定动作触发与关闭能力。
contextBridge.exposeInMainWorld('trayMenu', {
  getState: () => ipcRenderer.invoke('tray-menu-state'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state || {});
    ipcRenderer.on('tray-menu-state', listener);
    return () => ipcRenderer.removeListener('tray-menu-state', listener);
  },
  action: (name) => ipcRenderer.send('tray-menu-action', String(name || '')),
  close: () => ipcRenderer.send('tray-menu-close'),
});
