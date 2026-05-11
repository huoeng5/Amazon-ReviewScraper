import { contextBridge, ipcRenderer } from 'electron';

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('iceman', {
  data: {
    load: (filters = {}) => ipcRenderer.invoke('data:load', filters),
  },
  crawl: {
    start: (options) => ipcRenderer.invoke('crawl:start', options),
    stop: () => ipcRenderer.invoke('crawl:stop'),
    manualRetry: () => ipcRenderer.invoke('crawl:manualRetry'),
    manualAbort: () => ipcRenderer.invoke('crawl:manualAbort'),
    onLog: (callback) => on('crawl:log', callback),
    onDone: (callback) => on('crawl:done', callback),
    onError: (callback) => on('crawl:error', callback),
  },
  jobs: {
    add: (options) => ipcRenderer.invoke('jobs:add', options),
    start: () => ipcRenderer.invoke('jobs:start'),
    pause: () => ipcRenderer.invoke('jobs:pause'),
    resume: () => ipcRenderer.invoke('jobs:resume'),
    retry: (jobId) => ipcRenderer.invoke('jobs:retry', jobId),
    retryFailed: () => ipcRenderer.invoke('jobs:retryFailed'),
    delete: (jobId) => ipcRenderer.invoke('jobs:delete', jobId),
    clear: () => ipcRenderer.invoke('jobs:clear'),
    onChanged: (callback) => on('jobs:changed', callback),
  },
  app: {
    resetAll: () => ipcRenderer.invoke('app:resetAll'),
    showMessage: (options) => ipcRenderer.invoke('app:showMessage', options),
  },
  export: {
    run: (options = {}) => ipcRenderer.invoke('export:run', options),
  },
  shell: {
    openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),
  },
});
