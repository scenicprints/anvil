'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anvil', {
  newDoc: () => ipcRenderer.invoke('doc:new'),
  open: () => ipcRenderer.invoke('doc:open'),
  openPath: (file) => ipcRenderer.invoke('doc:openPath', file),
  readAnother: (file) => ipcRenderer.invoke('doc:readAnother', file),
  save: (data, saveAs, sidecar) =>
    ipcRenderer.invoke('doc:save', { data, saveAs, sidecar }),
  currentPath: () => ipcRenderer.invoke('doc:currentPath'),
  exportMesh: (suggestedName, ext, data) =>
    ipcRenderer.invoke('export:mesh', { suggestedName, ext, data }),
  exportImage: (suggestedName, bytes) =>
    ipcRenderer.invoke('export:image', { suggestedName, bytes }),
  exportText: (suggestedName, ext, label, data) =>
    ipcRenderer.invoke('export:text', { suggestedName, ext, label, data }),
  importText: (ext, label) => ipcRenderer.invoke('import:text', { ext, label }),
  importVector: (kind) => ipcRenderer.invoke('import:vector', kind),
  importBinary: (kind) => ipcRenderer.invoke('import:binary', kind),
  changedOnDisk: () => ipcRenderer.invoke('doc:changedOnDisk'),
  heldByOther: () => ipcRenderer.invoke('doc:heldByOther'),
  showItem: (file) => ipcRenderer.invoke('shell:showItem', file),
  launchFile: (file) => ipcRenderer.invoke('shell:launch', file),
  message: (opts) => ipcRenderer.invoke('dialog:message', opts)
});

// Used only by the test harness page; the app itself never calls it.
contextBridge.exposeInMainWorld('anvilTest', {
  done: (summary) => ipcRenderer.send('test:done', summary)
});
