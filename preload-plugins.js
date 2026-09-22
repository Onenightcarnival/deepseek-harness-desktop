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
  skillsOpen: (name) => ipcRenderer.invoke('skills:open', name),
  skillsDetail: (name) => ipcRenderer.invoke('skills:detail', name),
  skillsReadFile: (name, rel) => ipcRenderer.invoke('skills:readFile', name, rel),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsSetEnabled: (name, enabled) => ipcRenderer.invoke('skills:setEnabled', name, enabled),
  skillsInstallZip: () => ipcRenderer.invoke('skills:installZip'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (values) => ipcRenderer.invoke('settings:save', values),
  generalGet: () => ipcRenderer.invoke('general:get'),
  generalSave: (values) => ipcRenderer.invoke('general:save', values),
  proxyGet: () => ipcRenderer.invoke('proxy:get'),
  proxySave: (config) => ipcRenderer.invoke('proxy:save', config),
  proxyTest: (config, url) => ipcRenderer.invoke('proxy:test', config, url),
  proxyPickCa: () => ipcRenderer.invoke('proxy:pickCa'),
  serverRestart: () => ipcRenderer.invoke('server:restart'),
  openLog: () => ipcRenderer.invoke('app:openLog'),
})
