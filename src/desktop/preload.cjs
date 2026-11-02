const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hwpDesktop', {
  isDesktop: true,
  request: (route, args = {}) => ipcRenderer.invoke('hwp:request', route, args),
  onPanelState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hwp:panel-state', listener);
    return () => ipcRenderer.removeListener('hwp:panel-state', listener);
  },
});
