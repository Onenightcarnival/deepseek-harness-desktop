'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pluginApi', {
  list: () => ipcRenderer.invoke('plugins:list'),
  run: (action, spec) => ipcRenderer.invoke('plugins:run', action, spec),
  installLocal: (kind) => ipcRenderer.invoke('plugins:installLocal', kind),
  restart: () => ipcRenderer.invoke('plugins:restart'),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (servers) => ipcRenderer.invoke('mcp:save', servers),
  mcpTest: (server) => ipcRenderer.invoke('mcp:test', server),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsOpen: () => ipcRenderer.invoke('skills:open'),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsInstallZip: () => ipcRenderer.invoke('skills:installZip'),
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySave: (config) => ipcRenderer.invoke('proxy:save', config),
  proxyTest: (config, url) => ipcRenderer.invoke('proxy:test', config, url),
  proxyPickCa: () => ipcRenderer.invoke('proxy:pickCa'),
  serverRestart: () => ipcRenderer.invoke('server:restart'),
  openLog: () => ipcRenderer.invoke('app:openLog'),
})
