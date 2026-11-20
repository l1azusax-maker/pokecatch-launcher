const { contextBridge, ipcRenderer } = require('electron');

// 刷新提示框只能提交“刷新 / 取消”，不暴露其它启动器能力。
contextBridge.exposeInMainWorld('launcher', {
  noticeAction: (action) => ipcRenderer.send('notice-action', action === 'refresh' ? 'refresh' : 'cancel'),
});
