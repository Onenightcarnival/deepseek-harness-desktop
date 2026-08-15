'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pluginApi', {
  list: () => ipcRenderer.invoke('plugins:list'),
  run: (action, spec) => ipcRenderer.invoke('plugins:run', action, spec),
  restart: () => ipcRenderer.invoke('plugins:restart'),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (servers) => ipcRenderer.invoke('mcp:save', servers),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsOpen: () => ipcRenderer.invoke('skills:open'),
  skillsCreate: (name) => ipcRenderer.invoke('skills:create', name),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
})
