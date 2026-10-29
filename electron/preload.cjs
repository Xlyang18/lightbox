const { contextBridge, ipcRenderer } = require('electron');

/** 统一清洗 IPC 错误信息：Electron 会把异常包成 "Error invoking remote method 'x': Error: msg" */
const cleanMessage = (msg) => String(msg || '')
  .replace(/^Error invoking remote method '[^']+':\s*/i, '')
  .replace(/^Error:\s*/i, '');

const invoke = async (channel, payload) => {
  try {
    return await ipcRenderer.invoke(channel, payload);
  } catch (e) {
    throw new Error(cleanMessage(e?.message || e));
  }
};
const on = (channel, cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('lightbox', {
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    reset: () => invoke('settings:reset'),
    revealData: () => invoke('settings:revealData')
  },
  dialog: {
    choosePhotoRoot: () => invoke('dialog:choosePhotoRoot'),
    choosePublishRoot: (photoRoot) => invoke('dialog:choosePublishRoot', photoRoot)
  },
  scan: {
    folder: (root, opts = {}) => invoke('scan:folder', { root, force: !!opts.force }),
    subfolder: (root, rel, opts = {}) => invoke('scan:subfolder', { root, rel, force: !!opts.force })
  },
  photo: {
    thumb: (p) => invoke('photo:thumb', p),
    readFile: (p) => invoke('photo:readFile', p),
    exif: (p) => invoke('photo:exif', p)
  },
  analyze: {
    coverage: (photos, platforms) => invoke('analyze:coverage', { photos, platforms })
  },
  batch: {
    plan: (payload) => invoke('batch:plan', payload),
    execute: (payload) => invoke('batch:execute', payload)
  },
  mark: {
    applyBatch: (items) => invoke('mark:applyBatch', { items })
  },
  history: {
    list: () => invoke('history:list'),
    undo: (id) => invoke('history:undo', id)
  },
  shell: {
    reveal: (p) => invoke('shell:reveal', p),
    openPath: (p) => invoke('shell:openPath', p)
  },
  thumb: {
    sweep: () => invoke('thumb:sweep'),
    clear: () => invoke('thumb:clear')
  },
  theme: {
    set: (mode) => invoke('theme:set', mode),
    get: () => invoke('theme:get')
  },
  menu: {
    onAction: (cb) => on('menu:action', cb)
  }
});
