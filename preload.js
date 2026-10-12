const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  capture: (id, rect, hostRect) => ipcRenderer.invoke('capture', { id, rect, hostRect }),
  load: name => ipcRenderer.invoke('data:load', name),
  save: (name, value) => ipcRenderer.invoke('data:save', name, value),
  saveAllSync: all => ipcRenderer.sendSync('data:saveAllSync', all),
  dataDir: () => ipcRenderer.invoke('data:dir'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: id => ipcRenderer.invoke('sources:choose', id),
  compact: on => ipcRenderer.invoke('window:compact', on),
  workArea: () => ipcRenderer.invoke('screen:workArea'),
  saveSnapshot: data => ipcRenderer.invoke('snapshot:save', data),
  openPath: p => ipcRenderer.invoke('shell:open', p),
  exportLearning: data => ipcRenderer.invoke('learning:export', data),
  importLearning: () => ipcRenderer.invoke('learning:import'),
  loadPatternStats: () => ipcRenderer.invoke('patternstats:load'),
});
