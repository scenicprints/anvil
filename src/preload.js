'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anvil', {
  newDoc: () => ipcRenderer.invoke('doc:new'),
  open: () => ipcRenderer.invoke('doc:open'),
  openPath: (file) => ipcRenderer.invoke('doc:openPath', file),
  readAnother: (file) => ipcRenderer.invoke('doc:readAnother', file),
  readLinked: (name, file) => ipcRenderer.invoke('doc:readLinked', { name, file }),
  rename: (to) => ipcRenderer.invoke('doc:rename', to),
  saveCopy: (data) => ipcRenderer.invoke('doc:saveCopy', { data }),
  library: () => ipcRenderer.invoke('library:get'),
  chooseLibrary: () => ipcRenderer.invoke('library:choose'),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  searchLibrary: (query) => ipcRenderer.invoke('library:search', query),
  projects: () => ipcRenderer.invoke('library:projects'),
  createProject: (name) => ipcRenderer.invoke('library:createProject', name),
  createFolder: (within, name) => ipcRenderer.invoke('library:createFolder', { within, name }),
  profiles: () => ipcRenderer.invoke('profiles:list'),
  useProfile: (id) => ipcRenderer.invoke('profiles:use', id),
  addProfile: (name) => ipcRenderer.invoke('profiles:add', name),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  recents: () => ipcRenderer.invoke('profiles:recents'),
  setProfilePicture: (id, bytes) => ipcRenderer.invoke('profiles:setPicture', { id, bytes }),
  profilePicture: (id) => ipcRenderer.invoke('profiles:picture', id),
  clearProfilePicture: (id) => ipcRenderer.invoke('profiles:clearPicture', id),
  // A file that is only a placeholder until something touches it reads slowly
  // rather than failing, so the window is told to say so instead of looking
  // like it has hung.
  onSlowRead: (fn) => ipcRenderer.on('doc:slowRead', (_e, what) => fn(what)),
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
  readFileBytes: (file) => ipcRenderer.invoke('import:binaryPath', file),
  changedOnDisk: () => ipcRenderer.invoke('doc:changedOnDisk'),
  autosave: (doc) => ipcRenderer.invoke('doc:autosave', doc),
  recoveryInterval: () => ipcRenderer.invoke('doc:recoveryInterval'),
  recoverable: () => ipcRenderer.invoke('doc:recoverable'),
  recover: (session) => ipcRenderer.invoke('doc:recover', session),
  discardRecovery: (session) => ipcRenderer.invoke('doc:discardRecovery', session),
  heldByOther: () => ipcRenderer.invoke('doc:heldByOther'),
  showItem: (file) => ipcRenderer.invoke('shell:showItem', file),
  launchFile: (file) => ipcRenderer.invoke('shell:launch', file),
  message: (opts) => ipcRenderer.invoke('dialog:message', opts)
});

// Used only by the test harness page; the app itself never calls it.
contextBridge.exposeInMainWorld('anvilTest', {
  done: (summary) => ipcRenderer.send('test:done', summary)
});
