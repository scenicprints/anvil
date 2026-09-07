'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anvil', {
  newDoc: () => ipcRenderer.invoke('doc:new'),
  open: () => ipcRenderer.invoke('doc:open'),
  openPath: (file) => ipcRenderer.invoke('doc:openPath', file),
  save: (data, saveAs) => ipcRenderer.invoke('doc:save', { data, saveAs }),
  currentPath: () => ipcRenderer.invoke('doc:currentPath'),
  exportMesh: (suggestedName, ext, data) =>
    ipcRenderer.invoke('export:mesh', { suggestedName, ext, data }),
  importVector: (kind) => ipcRenderer.invoke('import:vector', kind),
  importBinary: (kind) => ipcRenderer.invoke('import:binary', kind),
  changedOnDisk: () => ipcRenderer.invoke('doc:changedOnDisk'),
  showItem: (file) => ipcRenderer.invoke('shell:showItem', file),
  message: (opts) => ipcRenderer.invoke('dialog:message', opts)
});

// Used only by the test harness page; the app itself never calls it.
contextBridge.exposeInMainWorld('anvilTest', {
  done: (summary) => ipcRenderer.send('test:done', summary)
});
