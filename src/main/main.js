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
const webfav = require('./webfav');
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

  // 판 안 브라우저(webview)의 새 창(target=_blank)은 그 판의 "새 탭" 으로.
  // 최신 Electron 은 webview 의 new-window 이벤트를 없앴기 때문에,
  // 여기서 게스트 webContents 에 핸들러를 달아 렌더러로 알려 줘야 한다.
  mainWindow.webContents.on('did-attach-webview', (e2, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      send('web:openInNewTab', { viewId: guest.id, url });
      return { action: 'deny' };
    });
  });

  // 렌더러(화면 프로세스)가 죽어도 앱이 통째로 꺼지지 않게 자동 복구한다.
  // 새로고침하면 지난 세션 복원 기능이 탭 구성을 되살린다.
  // 1분에 4번 이상 반복해서 죽으면 루프 방지를 위해 안내만 하고 멈춘다.
  let rendererCrashAt = [];
  mainWindow.webContents.on('render-process-gone', (e2, details) => {
    if (!details || details.reason === 'clean-exit') return;
    console.error('[armux] renderer crashed:', details.reason, details.exitCode);
    const now = Date.now();
    rendererCrashAt = rendererCrashAt.filter((t) => now - t < 60000);
    rendererCrashAt.push(now);
    if (rendererCrashAt.length <= 3) {
      mainWindow.webContents.reload();
    } else {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: '화면이 반복해서 중단됩니다.',
        detail: `이유: ${details.reason}. 앱을 다시 시작해 주세요. 계속되면 GitHub 이슈로 알려주세요.`
      });
    }
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
          label: 'AI 질문',
          accelerator: 'CmdOrCtrl+K',
          click: () => mainWindow && mainWindow.webContents.send('menu:ai')
        },
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

/** 로컬 터미널 세션 — 이 PC 의 셸을 PTY 로 띄운다. 데이터는 ssh:* 채널을 그대로 쓴다. */
ipcMain.handle('local:spawn', (e, { size }) => {
  const sessionId = ssh.openLocal(size, {
    onReady: (id) => send('ssh:ready', { id }),
    onData: (id, data) => send('ssh:data', { id, data: new Uint8Array(Buffer.from(data, 'utf8')) }),
    onExit: (id) => send('ssh:exit', { id }),
    onError: (id, message) => send('ssh:error', { id, message })
  });
  return { sessionId };
});

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

/* --------------------------- IPC: 앱 정보 / 업데이트 --------------------------- */

/** 빌드 시점 정보 (scripts/write-buildinfo.js 가 만든다) */
function buildInfo() {
  try {
    return require('../buildinfo.json');
  } catch (err) {
    return { version: app.getVersion(), builtAt: null, commit: '' };
  }
}

ipcMain.handle('app:info', () => {
  const info = buildInfo();
  return {
    name: 'Armux Terminal',
    version: info.version || app.getVersion(),
    builtAt: info.builtAt,
    commit: info.commit || '',
    developer: 'Jun Yeol Yang',
    repoUrl: `https://github.com/${updater.REPO.owner}/${updater.REPO.repo}`,
    releasesUrl: updater.RELEASES_URL,
    electron: process.versions.electron,
    node: process.versions.node,
    packaged: app.isPackaged
  };
});

ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('update:state', () => updater.getState());
ipcMain.on('update:openReleases', () => updater.openReleases());
ipcMain.on('app:openExternal', (e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

/* -------------------------------- IPC: 창 제어 -------------------------------- */

ipcMain.on('win:toggleFullScreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});
ipcMain.on('win:toggleDevTools', () => {
  if (mainWindow) mainWindow.webContents.toggleDevTools();
});

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

/* ---------------------------------- AI 질문 ---------------------------------- */

/** AI 질문 창 (하나만 유지). 메인 창을 가리지 않는 독립 윈도우다. */
let aiWindow = null;
let aiWinBounds = null; // 닫았다 다시 열어도 자리·크기를 기억

function openAiWindow(payload) {
  if (aiWindow && !aiWindow.isDestroyed()) {
    aiWindow.show();
    aiWindow.focus();
    aiWindow.webContents.send('ai:context', payload);
    return;
  }
  aiWindow = new BrowserWindow({
    width: (aiWinBounds && aiWinBounds.width) || 460,
    height: (aiWinBounds && aiWinBounds.height) || 620,
    x: aiWinBounds ? aiWinBounds.x : undefined,
    y: aiWinBounds ? aiWinBounds.y : undefined,
    minWidth: 320,
    minHeight: 360,
    title: 'AI 질문',
    backgroundColor: '#101318',
    parent: undefined, // 독립 창 — 메인 창을 가리지도, 따라다니지도 않는다
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  aiWindow.setMenuBarVisibility(false);
  aiWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ai.html'));
  aiWindow.webContents.once('did-finish-load', () => {
    if (aiWindow && !aiWindow.isDestroyed()) aiWindow.webContents.send('ai:context', payload);
  });
  aiWindow.on('close', () => {
    try {
      aiWinBounds = aiWindow.getBounds();
    } catch (e) {
      /* noop */
    }
  });
  aiWindow.on('closed', () => {
    aiWindow = null;
  });
}

ipcMain.on('ai:openWindow', (e, payload) => openAiWindow(payload || {}));
ipcMain.handle('ai:togglePin', () => {
  if (!aiWindow || aiWindow.isDestroyed()) return false;
  const next = !aiWindow.isAlwaysOnTop();
  aiWindow.setAlwaysOnTop(next);
  return next;
});

/**
 * 판에서 Ctrl/⌘+K 로 여는 AI 질문. 원격 서버에 로그인된 Claude 계정으로
 * `claude -p` 를 실행해 답을 받아온다(API 키 불필요, 사용량은 그 계정 기준).
 * 이어지는 질문은 --resume <세션id> 로 맥락을 유지한다.
 * 프롬프트는 따옴표 문제를 피하려고 base64 → stdin 으로 넘긴다.
 */
ipcMain.handle('ai:ask', async (e, { sessionId, prompt, resumeId }) => {
  const b64 = Buffer.from(String(prompt || ''), 'utf8').toString('base64');
  const resume = resumeId ? `--resume ${String(resumeId).replace(/[^0-9a-f-]/gi, '')} ` : '';
  const script = `
CLAUDE="$(command -v claude 2>/dev/null)"
if [ -z "$CLAUDE" ]; then
  for c in "$HOME"/.local/bin/claude "$HOME"/.claude/local/claude /usr/local/bin/claude /opt/homebrew/bin/claude; do
    [ -x "$c" ] && CLAUDE="$c" && break
  done
fi
if [ -z "$CLAUDE" ]; then echo 'ARMUX_AI:no-claude'; exit 0; fi
cd "$HOME" 2>/dev/null
printf %s ${b64} | { base64 -d 2>/dev/null || base64 --decode; } | "$CLAUDE" -p ${resume}--output-format json 2>/dev/null
`.trim();

  let stdout = '';
  if (ssh.isLocal(sessionId)) {
    // 로컬 터미널 그룹: 이 PC 의 claude 를 직접 실행한다 (win 은 아직 미지원)
    if (process.platform === 'win32') {
      return { error: '로컬 터미널의 AI 질문은 아직 macOS/리눅스에서만 지원합니다.' };
    }
    stdout = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('bash', ['-lc', script], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(String(out || ''));
      });
    });
  } else {
    const res = await ssh.exec(sessionId, `S=${Buffer.from(script, 'utf8').toString('base64')}; { printf %s "$S" | base64 -d 2>/dev/null || printf %s "$S" | base64 --decode 2>/dev/null; } | bash -l`, 180000);
    stdout = res.stdout; // 답변이 길면 오래 걸린다
  }
  const text = String(stdout);
  if (text.includes('ARMUX_AI:no-claude')) {
    return { error: '이 서버에서 claude 명령을 찾지 못했습니다. Claude Code 가 설치되어 있어야 합니다.' };
  }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return { error: '응답이 비어 있습니다. (로그인 상태를 확인해 보세요)' };
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    if (j.is_error) return { error: String(j.result || '오류가 났습니다.') };
    return { result: String(j.result || ''), sessionId: j.session_id || null };
  } catch (err) {
    return { error: '응답을 해석하지 못했습니다.' };
  }
});

/* ------------------------------------ 웹 판 ------------------------------------ */

// 주소창 자동완성용: 이 PC 크롬 방문 기록에서 후보를 뽑는다(읽기 전용).
ipcMain.handle('web:chromeInfo', () => ({
  historyAvailable: chromehistory.available(),
  chromiumVersion: process.versions.chrome
}));
ipcMain.handle('web:historySuggest', (e, { query }) => chromehistory.suggest(query));
// 진짜 크롬(기본 브라우저)으로 열기
ipcMain.on('web:openExternal', (e, url) => {
  if (url) shell.openExternal(url);
});
/*
 * 인증서를 확인할 수 없는 사이트(자체 서명·만료·사설 CA 등) 처리.
 * 기본 동작은 "차단" 이라 화면이 하얗게 비어 버린다. 브라우저처럼 한 번 물어보고,
 * 사용자가 계속을 고르면 그 호스트만 허용한 뒤 다시 불러온다.
 * 무조건 허용하지는 않는다(중간자 공격을 그냥 통과시키게 되므로).
 * 허용 기록은 이번 실행 동안만 기억한다.
 */
const certAllowed = new Set(); // 사용자가 허용한 호스트
const certAsking = new Set(); // 이미 물어보는 중인 호스트(중복 창 방지)

app.on('certificate-error', (event, wc, url, error, certificate, callback) => {
  let host = url;
  try {
    host = new URL(url).host;
  } catch (e) {
    /* URL 이 아니면 원문 그대로 쓴다 */
  }
  if (certAllowed.has(host)) {
    event.preventDefault();
    callback(true); // 이미 허용한 곳
    return;
  }
  callback(false); // 일단 막는다. 허용하면 아래에서 다시 불러온다.
  if (certAsking.has(host)) return;
  certAsking.add(host);

  dialog
    .showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['취소', '위험을 감수하고 열기'],
      defaultId: 0,
      cancelId: 0,
      message: `${host} 의 인증서를 확인할 수 없습니다.`,
      detail:
        `${error}\n\n` +
        '자체 서명 인증서이거나 만료된 인증서일 수 있습니다.\n' +
        '직접 관리하는 서버처럼 믿을 수 있는 곳일 때만 계속하세요.\n' +
        '(허용은 앱을 끄면 사라집니다)'
    })
    .then((res) => {
      certAsking.delete(host);
      if (res.response !== 1) return;
      certAllowed.add(host);
      if (wc && !wc.isDestroyed()) wc.loadURL(url); // 허용했으니 다시 시도
    })
    .catch(() => certAsking.delete(host));
});

// 즐겨찾기 저장소
ipcMain.handle('web:favList', () => webfav.list());
ipcMain.handle('web:favAdd', (e, item) => webfav.add(item));
ipcMain.handle('web:favRemove', (e, { url }) => webfav.remove(url));

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
