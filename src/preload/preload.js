'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  /** 파일 탐색기(SFTP) */
  sftp: {
    open: (payload) => ipcRenderer.invoke('sftp:open', payload),
    list: (id, path) => ipcRenderer.invoke('sftp:list', { id, path }),
    realpath: (id, path) => ipcRenderer.invoke('sftp:realpath', { id, path }),
    mkdir: (id, path) => ipcRenderer.invoke('sftp:mkdir', { id, path }),
    createFile: (id, path) => ipcRenderer.invoke('sftp:createFile', { id, path }),
    rename: (id, from, to) => ipcRenderer.invoke('sftp:rename', { id, from, to }),
    remove: (id, path) => ipcRenderer.invoke('sftp:remove', { id, path }),
    readFile: (id, path) => ipcRenderer.invoke('sftp:readFile', { id, path }),
    writeFile: (id, path, base64) => ipcRenderer.invoke('sftp:writeFile', { id, path, base64 }),
    parquetPreview: (payload) => ipcRenderer.invoke('sftp:parquetPreview', payload),
    runNotebook: (payload) => ipcRenderer.invoke('sftp:runNotebook', payload),
    download: (payload) => ipcRenderer.invoke('sftp:download', payload),
    upload: (payload) => ipcRenderer.invoke('sftp:upload', payload),
    pickUpload: (directory) => ipcRenderer.invoke('sftp:pickUpload', { directory }),
    dragOut: (payload) => ipcRenderer.invoke('sftp:dragOut', payload),
    close: (id) => ipcRenderer.send('sftp:close', { id }),
    onProgress: (cb) => ipcRenderer.on('sftp:progress', (e, p) => cb(p))
  },

  /** 앱 정보 / 자동 업데이트 */
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.send('app:openExternal', url)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    state: () => ipcRenderer.invoke('update:state'),
    openReleases: () => ipcRenderer.send('update:openReleases'),
    onState: (cb) => ipcRenderer.on('update:state', (e, p) => cb(p))
  },

  /** 창 제어 */
  win: {
    toggleFullScreen: () => ipcRenderer.send('win:toggleFullScreen'),
    toggleDevTools: () => ipcRenderer.send('win:toggleDevTools')
  },

  /** 웹 페인 (판 안의 브라우저) */
  web: {
    chromeInfo: () => ipcRenderer.invoke('web:chromeInfo'),
    favList: () => ipcRenderer.invoke('web:favList'),
    favAdd: (item) => ipcRenderer.invoke('web:favAdd', item),
    favRemove: (url) => ipcRenderer.invoke('web:favRemove', { url }),
    historySuggest: (query) => ipcRenderer.invoke('web:historySuggest', { query }),
    /** webview 가 새 창을 요청하면(target=_blank) 새 탭으로 열라는 신호 */
    onOpenInNewTab: (cb) => ipcRenderer.on('web:openInNewTab', (e, p) => cb(p)),
    openExternal: (url) => ipcRenderer.send('web:openExternal', url),
    /** 크롬처럼 보이게 할 User-Agent (Electron 표시를 뺀다) */
    userAgent: () =>
      `Mozilla/5.0 (${
        process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : process.platform === 'darwin'
            ? 'Macintosh; Intel Mac OS X 10_15_7'
            : 'X11; Linux x86_64'
      }) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  },

  /** 메모장 (<userData>/notes/*.md) */
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    read: (name) => ipcRenderer.invoke('notes:read', { name }),
    write: (name, content) => ipcRenderer.invoke('notes:write', { name, content }),
    create: (name) => ipcRenderer.invoke('notes:create', { name }),
    rename: (from, to) => ipcRenderer.invoke('notes:rename', { from, to }),
    remove: (name) => ipcRenderer.invoke('notes:remove', { name }),
    reveal: () => ipcRenderer.invoke('notes:reveal'),
    dir: () => ipcRenderer.invoke('notes:dir')
  },

  /** 마지막 탭 구성 저장/복원 */
  session: {
    load: () => ipcRenderer.invoke('session:load'),
    save: (snapshot) => ipcRenderer.send('session:save', snapshot)
  },

  /** 원격 서버의 Claude Code 로그인/사용량 정보 */
  claude: {
    info: (sessionId) => ipcRenderer.invoke('claude:info', { sessionId }),
    installHooks: (sessionId) => ipcRenderer.invoke('claude:installHooks', { sessionId })
  },

  util: {
    pickKeyFile: () => ipcRenderer.invoke('util:pickKeyFile'),
    clipboardRead: () => ipcRenderer.invoke('util:clipboardRead'),
    clipboardWrite: (text) => ipcRenderer.send('util:clipboardWrite', text),
    openExternal: (url) => ipcRenderer.send('app:openExternal', url),
    confirm: (message, detail, okLabel) => ipcRenderer.invoke('util:confirm', { message, detail, okLabel }),
    /** 드롭된 File 객체의 실제 경로 (Electron 32+ 에서는 file.path 가 없어 이 API 를 써야 한다) */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch (e) {
        return '';
      }
    }
  },

  /** 메뉴/단축키에서 오는 명령 */
  onMenu: (cb) => {
    const channels = [
      'menu:new-group',
      'menu:new-subtab',
      'menu:split-vertical',
      'menu:split-horizontal',
      'menu:close-tab',
      'menu:copy',
      'menu:paste',
      'menu:cut',
      'menu:selectAll',
      'menu:find',
      'menu:font',
      'menu:help-tmux',
      'menu:help-shortcuts',
      'menu:about',
      'menu:update',
      'menu:toggle-explorer',
      'menu:toggle-notes'
    ];
    for (const ch of channels) {
      ipcRenderer.on(ch, (e, arg) => cb(ch.replace('menu:', ''), arg));
    }
  }
});
