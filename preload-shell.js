const { contextBridge, ipcRenderer } = require('electron');

// 本地标题栏只拿窗口控制与基础标题栏状态能力，不接触脚本或文件系统。
contextBridge.exposeInMainWorld('launcher', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximizeChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, isMaximized) => callback(Boolean(isMaximized));
    ipcRenderer.on('window-maximized', listener);
    return () => ipcRenderer.removeListener('window-maximized', listener);
  },
  getShellState: () => ipcRenderer.invoke('shell-state'),
  toggleMute: () => ipcRenderer.send('win-toggle-mute'),
  togglePin: () => ipcRenderer.send('win-toggle-pin'),
  openTitleMenu: () => ipcRenderer.send('win-title-menu'),
  onShellState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state || {});
    ipcRenderer.on('shell-state-changed', listener);
    return () => ipcRenderer.removeListener('shell-state-changed', listener);
  },
});
