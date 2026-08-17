'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard, shell, nativeImage, webUtils } = require('electron');
const store = require('./store');
const ssh = require('./ssh');
const sftp = require('./sftp');
const claudeinfo = require('./claudeinfo');
const notes = require('./notes');

const isMac = process.platform === 'darwin';
let mainWindow = null;
let allowClose = false; // 종료 확인을 이미 받았는지
let exitAsking = false; // 확인 창이 이미 떠 있는지

/** 종료 전 확인. 열린 세션이 없으면 묻지 않는다. */
async function confirmExit() {
  if (exitAsking) return false;
  const n = ssh.count();
  if (n === 0) return true;
  exitAsking = true;
  try {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['취소', '닫기'],
      defaultId: 0,
      cancelId: 0,
      message: 'Armux Terminal 을 닫을까요?',
      detail: `열려 있는 SSH 세션 ${n}개가 모두 종료됩니다.`
    });
    return res.response === 1;
  } finally {
    exitAsking = false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#000000',
    // macOS 에서는 신호등 버튼만 남기고 타이틀바를 숨겨 탭바가 상단에 붙게 한다
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 열려 있는 세션이 있으면 창을 닫기 전에 한 번 물어본다
  mainWindow.on('close', (e) => {
    if (allowClose || ssh.count() === 0) return;
    e.preventDefault();
    confirmExit().then((ok) => {
      if (!ok || !mainWindow) return;
      allowClose = true;
      mainWindow.close();
    });
  });

  // 터미널 안의 링크는 외부 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: '탭',
      submenu: [
        {
          label: '새 SSH 탭',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow && mainWindow.webContents.send('menu:new-group')
        },
        {
          label: '현재 그룹에 서브탭 추가',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow && mainWindow.webContents.send('menu:new-subtab')
        },
        { type: 'separator' },
        {
          label: '좌우로 분할',
          accelerator: isMac ? 'Cmd+D' : 'Ctrl+Shift+D',
          click: () => mainWindow && mainWindow.webContents.send('menu:split-vertical')
        },
        {
          label: '위아래로 분할',
          accelerator: isMac ? 'Cmd+Shift+D' : 'Ctrl+Shift+E',
          click: () => mainWindow && mainWindow.webContents.send('menu:split-horizontal')
        },
        { type: 'separator' },
        {
          label: '현재 창 닫기',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow && mainWindow.webContents.send('menu:close-tab')
        }
      ]
    },
    {
      label: '편집',
      submenu: [
        {
          label: '복사',
          accelerator: isMac ? 'Cmd+C' : 'Ctrl+Shift+C',
          click: () => mainWindow && mainWindow.webContents.send('menu:copy')
        },
        {
          label: '붙여넣기',
          accelerator: isMac ? 'Cmd+V' : 'Ctrl+Shift+V',
          click: () => mainWindow && mainWindow.webContents.send('menu:paste')
        },
        { type: 'separator' },
        {
          label: '찾기',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow && mainWindow.webContents.send('menu:find')
        }
      ]
    },
    {
      label: '보기',
      submenu: [
        {
          label: '글자 크게',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => mainWindow && mainWindow.webContents.send('menu:font', 1)
        },
        {
          label: '글자 작게',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow && mainWindow.webContents.send('menu:font', -1)
        },
        {
          label: '글자 크기 초기화',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow && mainWindow.webContents.send('menu:font', 0)
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '도움',
      submenu: [
        {
          label: 'tmux 사용법',
          click: () => mainWindow && mainWindow.webContents.send('menu:help-tmux')
        },
        {
          label: '단축키 모음',
          click: () => mainWindow && mainWindow.webContents.send('menu:help-shortcuts')
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------ IPC: 호스트 저장소 ------------------------------ */

ipcMain.handle('hosts:list', () => store.list());
ipcMain.handle('hosts:save', (e, profile) => store.save(profile));
ipcMain.handle('hosts:remove', (e, id) => {
  store.remove(id);
  return true;
});
ipcMain.handle('hosts:canSavePassword', () => store.canEncrypt());

/* -------------------------------- IPC: SSH 세션 -------------------------------- */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * 저장하지 않은 접속의 자격증명을 메모리에만 보관한다.
 * 같은 그룹에 서브탭을 추가할 때 비밀번호를 다시 묻지 않기 위한 용도이며,
 * 앱을 종료하면 사라진다.
 */
const ephemeralCreds = new Map(); // credId -> profile(비밀번호 포함)

/**
 * 접속에 쓸 자격증명을 정한다.
 * 우선순위: 메모리 자격증명(credId) → 저장된 호스트(hostId) → 폼 입력값.
 * 폼에서 새로 들어온 값이 있으면 그 값으로 덮어쓴다.
 */
function resolveCredentials({ hostId, credId, profile }) {
  if (credId && ephemeralCreds.has(credId)) {
    return { ...ephemeralCreds.get(credId), ...pruneEmpty(profile || {}) };
  }
  if (hostId) {
    const secret = store.getSecret(hostId);
    if (!secret) throw new Error('저장된 호스트를 찾을 수 없습니다.');
    store.touch(hostId);
    return { ...secret, ...pruneEmpty(profile || {}) };
  }
  return profile || {};
}

ipcMain.handle('ssh:connect', (e, { hostId, credId, profile, size }) => {
  const effective = resolveCredentials({ hostId, credId, profile });

  // 서브탭/재접속에서 재사용할 자격증명 토큰
  const token = credId && ephemeralCreds.has(credId) ? credId : crypto.randomUUID();
  ephemeralCreds.set(token, effective);

  const sessionId = ssh.open(effective, size, {
    onReady: (id) => send('ssh:ready', { id }),
    onData: (id, data) => send('ssh:data', { id, data: new Uint8Array(data) }),
    onExit: (id) => send('ssh:exit', { id }),
    onError: (id, message) => send('ssh:error', { id, message })
  });

  return {
    sessionId,
    credId: token,
    host: {
      id: hostId || null,
      name: effective.name || `${effective.username}@${effective.host}`,
      host: effective.host,
      port: Number(effective.port) || 22,
      username: effective.username,
      authType: effective.authType || 'password'
    }
  };
});

/** 빈 문자열/undefined 필드는 저장된 값이 덮어씌워지지 않도록 제거 */
function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== '' && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

ipcMain.on('ssh:write', (e, { id, data }) => ssh.write(id, data));
ipcMain.on('ssh:resize', (e, { id, cols, rows }) => ssh.resize(id, cols, rows));
ipcMain.on('ssh:close', (e, { id }) => ssh.close(id));

/* --------------------------------- IPC: SFTP --------------------------------- */

// 탐색기용 SFTP 세션. 터미널 세션과 같은 자격증명(credId/hostId)을 재사용한다.
ipcMain.handle('sftp:open', async (e, { hostId, credId, profile }) => {
  const effective = resolveCredentials({ hostId, credId, profile });
  const id = await sftp.open(effective);
  const home = await sftp.realpath(id, '.');
  return { sftpId: id, home };
});

ipcMain.handle('sftp:list', (e, { id, path: p }) => sftp.list(id, p));
ipcMain.handle('sftp:realpath', (e, { id, path: p }) => sftp.realpath(id, p));
ipcMain.handle('sftp:mkdir', (e, { id, path: p }) => sftp.mkdir(id, p));
ipcMain.handle('sftp:createFile', (e, { id, path: p }) => sftp.createFile(id, p));
ipcMain.handle('sftp:rename', (e, { id, from, to }) => sftp.rename(id, from, to));
ipcMain.handle('sftp:remove', (e, { id, path: p }) => sftp.remove(id, p));
ipcMain.on('sftp:close', (e, { id }) => sftp.close(id));

/** 전송 진행률을 렌더러로 (100ms 간격으로만) */
function progressReporter(id) {
  let last = 0;
  return (name, transferred, total) => {
    const now = Date.now();
    if (now - last < 100 && transferred !== total) return;
    last = now;
    send('sftp:progress', { id, name, transferred, total });
  };
}

/** 원격 → 로컬. localPath 를 안 주면 저장 위치를 물어본다. */
ipcMain.handle('sftp:download', async (e, { id, remote, name, isDir, localPath }) => {
  let target = localPath;
  if (!target) {
    if (isDir) {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '폴더를 내려받을 위치 선택',
        properties: ['openDirectory', 'createDirectory']
      });
      if (res.canceled || !res.filePaths.length) return null;
      target = path.join(res.filePaths[0], name);
    } else {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '다른 이름으로 저장',
        defaultPath: path.join(app.getPath('downloads'), name)
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
  }
  await sftp.download(id, remote, target, progressReporter(id));
  return target;
});

/** 로컬 → 원격 업로드 */
ipcMain.handle('sftp:upload', async (e, { id, localPaths, remoteDir }) => {
  const done = [];
  for (const local of localPaths) {
    const base = path.basename(local);
    await sftp.upload(id, local, sftp.joinRemote(remoteDir, base), progressReporter(id));
    done.push(base);
  }
  return done;
});

/** 로컬에서 업로드할 파일 고르기 */
ipcMain.handle('sftp:pickUpload', async (e, { directory }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: directory ? '업로드할 폴더 선택' : '업로드할 파일 선택',
    properties: directory ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths;
});

/**
 * 탐색기에서 바탕화면 등으로 파일을 끌어다 놓기 위한 처리.
 * 원격 파일을 임시 폴더로 내려받은 뒤 OS 드래그를 시작한다.
 */
ipcMain.handle('sftp:dragOut', async (e, { id, remote, name }) => {
  const dir = path.join(app.getPath('temp'), 'armux-drag', String(Date.now()));
  const local = path.join(dir, name);
  await sftp.download(id, remote, local, progressReporter(id));
  try {
    e.sender.startDrag({ file: local, icon: dragIcon() });
  } catch (err) {
    return { path: local, dragStarted: false };
  }
  return { path: local, dragStarted: true };
});

/** startDrag 는 아이콘이 필수라 1x1 투명 이미지를 만들어 쓴다 */
let cachedDragIcon = null;
function dragIcon() {
  if (!cachedDragIcon) {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
    const img = nativeImage.createFromPath(iconPath);
    cachedDragIcon = img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 64, height: 64 });
  }
  return cachedDragIcon;
}

/* --------------------------------- IPC: 메모장 -------------------------------- */

ipcMain.handle('notes:list', () => notes.list());
ipcMain.handle('notes:read', (e, { name }) => notes.read(name));
ipcMain.handle('notes:write', (e, { name, content }) => notes.write(name, content));
ipcMain.handle('notes:create', (e, { name }) => notes.create(name));
ipcMain.handle('notes:rename', (e, { from, to }) => notes.rename(from, to));
ipcMain.handle('notes:remove', (e, { name }) => notes.remove(name));
ipcMain.handle('notes:reveal', () => notes.reveal());
ipcMain.handle('notes:dir', () => notes.dir());

/* ------------------------- IPC: 세션(탭 배치) 저장/복원 ------------------------- */

// 마지막으로 열려 있던 탭 구성을 <userData>/session.json 에 저장해 두고 다음 실행 때 복원한다.
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');

function writeSession(snapshot) {
  try {
    if (!snapshot || !Array.isArray(snapshot.groups) || snapshot.groups.length === 0) {
      fs.rmSync(sessionFile(), { force: true }); // 열린 탭이 없으면 기록도 지운다
      return true;
    }
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
    fs.writeFileSync(sessionFile(), JSON.stringify(snapshot, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

ipcMain.handle('session:load', () => {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
  } catch (err) {
    return null;
  }
});
ipcMain.on('session:save', (e, snapshot) => writeSession(snapshot));

/* ----------------------------- IPC: Claude 계정 정보 ---------------------------- */

ipcMain.handle('claude:info', async (e, { sessionId }) => {
  try {
    return await claudeinfo.fetchInfo(sessionId);
  } catch (err) {
    return { loggedIn: false, error: String((err && err.message) || err) };
  }
});

/* ------------------------------- IPC: 기타 유틸 -------------------------------- */

ipcMain.handle('util:pickKeyFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '개인키 파일 선택',
    properties: ['openFile', 'showHiddenFiles'],
    defaultPath: path.join(app.getPath('home'), '.ssh')
  });
  if (res.canceled || !res.filePaths.length) return '';
  return res.filePaths[0];
});

ipcMain.handle('util:clipboardRead', () => clipboard.readText());
ipcMain.on('util:clipboardWrite', (e, text) => clipboard.writeText(text));
ipcMain.handle('util:confirm', async (e, { message, detail }) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['취소', '확인'],
    defaultId: 1,
    cancelId: 0,
    message,
    detail
  });
  return res.response === 1;
});

/* ---------------------------------- 앱 수명주기 ---------------------------------- */

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ssh.closeAll();
  sftp.closeAll();
  if (!isMac) app.quit();
});

// ⌘Q / 메뉴 종료도 같은 확인을 거친다
app.on('before-quit', (e) => {
  if (allowClose || ssh.count() === 0) return;
  e.preventDefault();
  confirmExit().then((ok) => {
    if (!ok) return;
    allowClose = true;
    app.quit();
  });
});

app.on('will-quit', () => {
  ssh.closeAll();
  sftp.closeAll();
  ephemeralCreds.clear();
});
