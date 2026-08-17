'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 렌더러에 노출되는 안전한 API (contextIsolation 사용) */
contextBridge.exposeInMainWorld('armux', {
  platform: process.platform,

  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    save: (profile) => ipcRenderer.invoke('hosts:save', profile),
    remove: (id) => ipcRenderer.invoke('hosts:remove', id),
    canSavePassword: () => ipcRenderer.invoke('hosts:canSavePassword')
  },

  ssh: {
    connect: (payload) => ipcRenderer.invoke('ssh:connect', payload),
    write: (id, data) => ipcRenderer.send('ssh:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', { id, cols, rows }),
    close: (id) => ipcRenderer.send('ssh:close', { id }),
    onReady: (cb) => ipcRenderer.on('ssh:ready', (e, p) => cb(p)),
    onData: (cb) => ipcRenderer.on('ssh:data', (e, p) => cb(p)),
    onExit: (cb) => ipcRenderer.on('ssh:exit', (e, p) => cb(p)),
    onError: (cb) => ipcRenderer.on('ssh:error', (e, p) => cb(p))
  },

  util: {
    pickKeyFile: () => ipcRenderer.invoke('util:pickKeyFile'),
    clipboardRead: () => ipcRenderer.invoke('util:clipboardRead'),
    clipboardWrite: (text) => ipcRenderer.send('util:clipboardWrite', text),
    confirm: (message, detail) => ipcRenderer.invoke('util:confirm', { message, detail })
  },

  /** 메뉴/단축키에서 오는 명령 (new-group, new-subtab, close-tab, copy, paste, find, font) */
  onMenu: (cb) => {
    const channels = [
      'menu:new-group',
      'menu:new-subtab',
      'menu:close-tab',
      'menu:copy',
      'menu:paste',
      'menu:find',
      'menu:font'
    ];
    for (const ch of channels) {
      ipcRenderer.on(ch, (e, arg) => cb(ch.replace('menu:', ''), arg));
    }
  }
});
