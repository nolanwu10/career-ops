const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('careerOpsDesktop', {
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  openPath: (targetPath) => ipcRenderer.invoke('desktop:open-path', targetPath),
  pickRoot: () => ipcRenderer.invoke('desktop:pick-root'),
  pickFolder: (title) => ipcRenderer.invoke('desktop:pick-folder', title)
});
