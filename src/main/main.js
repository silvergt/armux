'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard, shell, nativeImage, webUtils, webContents } = require('electron');
const store = require('./store');
const ssh = require('./ssh');
const sftp = require('./sftp');
const claudeinfo = require('./claudeinfo');
const notes = require('./notes');
const updater = require('./updater');
const chromehistory = require('./chromehistory');
const claudehooks = require('./claudehooks');

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
    // 제목 줄을 없애고, 앱이 직접 그리는 메뉴 줄 하나로 합친다.
    // (윈도우/리눅스는 최소화·최대화·닫기 버튼만 오버레이로 남긴다)
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac
      ? undefined
      : { color: '#16181c', symbolColor: '#d5d8de', height: 34 },
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: true // 판 안에 웹 페이지를 띄우기 위해
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

  updater.init(send); // 업데이트 진행 상태를 렌더러로 보낸다

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

/**
 * 편집 명령을 알맞은 대상에 보낸다.
 * 웹 화면(webview)이 포커스면 그쪽에서 바로 처리하고,
 * 앱 화면이면 렌더러가 입력칸인지 터미널인지 가려서 처리한다.
 */
function editCommand(kind) {
  const focused = webContents.getFocusedWebContents();
  if (focused && mainWindow && focused.id !== mainWindow.webContents.id) {
    if (typeof focused[kind] === 'function') focused[kind]();
    return;
  }
  if (mainWindow) mainWindow.webContents.send(`menu:${kind}`);
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
      submenu: isMac
        ? [
            // macOS 는 메뉴 가속기가 키를 먼저 가져가므로, 여기서 대상(웹 화면 / 입력칸 / 터미널)을
            // 가려서 처리해야 어디서든 ⌘A·⌘C·⌘V 가 동작한다.
            { role: 'undo', label: '실행 취소' },
            { role: 'redo', label: '다시 실행' },
            { type: 'separator' },
            { label: '잘라내기', accelerator: 'Cmd+X', click: () => editCommand('cut') },
            { label: '복사', accelerator: 'Cmd+C', click: () => editCommand('copy') },
            { label: '붙여넣기', accelerator: 'Cmd+V', click: () => editCommand('paste') },
            { label: '전체 선택', accelerator: 'Cmd+A', click: () => editCommand('selectAll') },
            { type: 'separator' },
            {
              label: '찾기',
              accelerator: 'Cmd+F',
              click: () => mainWindow && mainWindow.webContents.send('menu:find')
            }
          ]
        : [
            {
              label: '복사',
              accelerator: 'Ctrl+Shift+C',
              click: () => mainWindow && mainWindow.webContents.send('menu:copy')
            },
            {
              label: '붙여넣기',
              accelerator: 'Ctrl+Shift+V',
              click: () => mainWindow && mainWindow.webContents.send('menu:paste')
            },
            { type: 'separator' },
            {
              label: '찾기',
              accelerator: 'Ctrl+F',
              click: () => mainWindow && mainWindow.webContents.send('menu:find')
            }
          ]
    },
    {
      label: '보기',
      submenu: [
        ...(isMac
          ? [
              // macOS 는 메뉴에 등록해 두어야 ⌘` 같은 키가 앱으로 확실히 들어온다
              {
                label: '파일 탐색기',
                accelerator: 'Cmd+`',
                click: () => mainWindow && mainWindow.webContents.send('menu:toggle-explorer')
              },
              {
                label: '메모장',
                accelerator: 'Cmd+Control+`',
                click: () => mainWindow && mainWindow.webContents.send('menu:toggle-notes')
              },
              { type: 'separator' }
            ]
          : []),
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
      label: '정보',
      submenu: [
        {
          label: '버전',
          click: () => mainWindow && mainWindow.webContents.send('menu:about')
        },
        {
          label: '업데이트 확인',
          click: () => mainWindow && mainWindow.webContents.send('menu:update')
        }
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
  // 보여 줄 순서: 정보 · 탭 · 편집 · 보기 · 도움 (앱 메뉴는 mac 규칙상 항상 맨 앞)
  const order = ['정보', '탭', '편집', '보기', '도움'];
  template.sort((a, b) => {
    const ai = order.indexOf(a.label);
    const bi = order.indexOf(b.label);
    if (ai < 0) return -1;
    if (bi < 0) return 1;
    return ai - bi;
  });

  // macOS 는 화면 상단 시스템 메뉴 막대를 그대로 쓰고,
  // 윈도우/리눅스는 앱이 직접 그리는 메뉴 줄만 쓰므로 네이티브 메뉴는 없앤다.
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate(template) : null);
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
ipcMain.handle('sftp:readFile', (e, { id, path: p }) => sftp.readFile(id, p));
ipcMain.handle('sftp:writeFile', (e, { id, path: p, base64 }) => sftp.writeFile(id, p, base64));

// 원격 도구로 처리하는 것들 (해당 도구가 서버에 있어야 동작)
// parquet 미리보기: duckdb 또는 python(pandas) 로 앞부분을 CSV 로 뽑는다
// 원격 명령을 로그인 셸로 감싼다(venv/conda 등 PATH 확보). base64 로 넘겨 따옴표 문제 회피.
function wrapLogin(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s ${b64} | base64 -d | bash -l 2>/dev/null || printf %s ${b64} | base64 --decode | bash -l`;
}

ipcMain.handle('sftp:parquetPreview', async (e, { sessionId, path: p, limit }) => {
  const n = Number(limit) || 300;
  const q = p.replace(/'/g, `'\\''`);
  // venv/conda 등 여러 곳에서 pandas 있는 python 을 직접 찾는다(로그인 PATH 에 없어도).
  const script =
    `F='${q}'; N=${n}
` +
    `CANDS="python3 python $VIRTUAL_ENV/bin/python $HOME/.virtualenv/*/bin/python $HOME/.venv/bin/python $HOME/venv/bin/python $HOME/miniconda3/bin/python $HOME/anaconda3/bin/python /opt/conda/bin/python $HOME/miniconda3/envs/*/bin/python $HOME/anaconda3/envs/*/bin/python"
` +
    `if command -v duckdb >/dev/null 2>&1; then
` +
    `  duckdb -csv -c "SELECT * FROM read_parquet('$F') LIMIT $N" 2>/dev/null && exit 0
` +
    `fi
` +
    `for PY in $CANDS; do
` +
    `  [ -x "$PY" ] || command -v "$PY" >/dev/null 2>&1 || continue
` +
    `  "$PY" -c 'import pandas' 2>/dev/null || continue
` +
    `  "$PY" -c 'import sys,pandas as pd; df=pd.read_parquet(sys.argv[1]); print("ARMUX_SHAPE:%d,%d"%df.shape); print(df.head(int(sys.argv[2])).to_csv(index=False),end="")' "$F" "$N" && exit 0
` +
    `done
` +
    `echo ARMUX_ERR:no-pandas`;
  const { stdout } = await ssh.exec(sessionId, wrapLogin(script), 30000);
  return String(stdout);
});

// ipynb 실행: 서버의 jupyter 로 노트북 전체를 실행하고 결과를 파일에 덮어쓴다
ipcMain.handle('sftp:runNotebook', async (e, { sessionId, path: p, timeout }) => {
  const q = p.replace(/'/g, `'\\''`);
  const to = Number(timeout) || 300;
  const script =
    `F='${q}'; TO=${to}
` +
    `CANDS="python3 python $VIRTUAL_ENV/bin/python $HOME/.virtualenv/*/bin/python $HOME/.venv/bin/python $HOME/venv/bin/python $HOME/miniconda3/bin/python $HOME/anaconda3/bin/python /opt/conda/bin/python $HOME/miniconda3/envs/*/bin/python $HOME/anaconda3/envs/*/bin/python"
` +
    `for PY in $CANDS; do
` +
    `  [ -x "$PY" ] || command -v "$PY" >/dev/null 2>&1 || continue
` +
    `  "$PY" -c 'import nbconvert' 2>/dev/null || continue
` +
    `  "$PY" -m nbconvert --to notebook --execute --inplace --ExecutePreprocessor.timeout=$TO "$F" 2>&1 | tail -6; echo ARMUX_DONE; exit 0
` +
    `done
` +
    `echo ARMUX_NONBCONVERT`;
  const { stdout } = await ssh.exec(sessionId, wrapLogin(script), (to + 30) * 1000);
  return String(stdout);
});

/* --------------------------------- IPC: 메모장 -------------------------------- *//* --------------------------------- IPC: 메모장 -------------------------------- */

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

ipcMain.handle('claude:installHooks', async (e, { sessionId }) => {
  try {
    return await claudehooks.install(sessionId);
  } catch (err) {
    return false;
  }
});

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
ipcMain.handle('util:confirm', async (e, { message, detail, okLabel }) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['취소', okLabel || '확인'],
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
