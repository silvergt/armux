'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, Menu, dialog, clipboard, shell, nativeImage, webUtils, webContents, powerMonitor, Notification } = require('electron');
const store = require('./store');
const ssh = require('./ssh');
const sftp = require('./sftp');
const claudeinfo = require('./claudeinfo');
const notes = require('./notes');
const updater = require('./updater');
const chromehistory = require('./chromehistory');
const webfav = require('./webfav');
const claudehooks = require('./claudehooks');
const codexinfo = require('./codexinfo');
const codexhooks = require('./codexhooks');

const isMac = process.platform === 'darwin';
let mainWindow = null;
let allowClose = false; // 종료 확인을 이미 받았는지
let exitAsking = false; // 확인 창이 이미 떠 있는지

/**
 * 바깥 프로그램(기본 브라우저·메일 앱)으로 넘길 수 있는 링크만 넘긴다.
 *
 * about:blank · javascript: · data: 같은 스킴을 그대로 shell 로 넘기면 OS 가
 * "이 'about' 링크를 열 앱을 다운로드하세요" 같은 대화를 띄운다. 브라우저는
 * 이런 링크를 바깥으로 넘기지 않으므로 우리도 조용히 무시한다.
 */
const EXTERNAL_SCHEMES = /^(https?|mailto|tel|ftp|ftps):/i;
function openExternalSafe(url) {
  const u = String(url || '').trim();
  if (!u || !EXTERNAL_SCHEMES.test(u)) return false;
  shell.openExternal(u).catch(() => {});
  return true;
}

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
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // 판 안 브라우저(webview)의 새 창(target=_blank)은 그 판의 "새 탭" 으로.
  // 최신 Electron 은 webview 의 new-window 이벤트를 없앴기 때문에,
  // 여기서 게스트 webContents 에 핸들러를 달아 렌더러로 알려 줘야 한다.
  mainWindow.webContents.on('did-attach-webview', (e2, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      const u = String(url || '');
      // 평범한 링크(http/https)는 그 판의 새 탭으로
      if (/^https?:\/\//i.test(u)) {
        send('web:openInNewTab', { viewId: guest.id, url: u });
        return { action: 'deny' };
      }
      // window.open('') 처럼 빈 창을 열고 스크립트로 채우는 방식(결제·인쇄·OAuth 등).
      // 새 탭으로 만들면 페이지가 그 창을 다룰 수 없어 빈 화면이 되므로,
      // 크롬처럼 진짜 팝업 창을 허용한다.
      if (!u || /^about:blank/i.test(u)) return { action: 'allow' };
      // mailto:·tel: 등은 OS 에 넘기되, 열 수 없는 스킴은 조용히 무시한다
      openExternalSafe(u);
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
        // 켬/끔 항목. 실제 값은 화면 쪽(localStorage)이 갖고 있고,
        // 시작할 때와 바뀔 때 settings:sync 로 여기 체크 표시를 맞춘다.
        {
          id: 'opt-notify',
          label: '작업 완료 시 알림',
          type: 'checkbox',
          checked: true,
          click: (mi) => mainWindow && mainWindow.webContents.send('menu:option', { key: 'notifyOs', on: mi.checked })
        },
        {
          id: 'opt-reconnect',
          label: '절전에서 깨면 자동 재접속',
          type: 'checkbox',
          checked: true,
          click: (mi) => mainWindow && mainWindow.webContents.send('menu:option', { key: 'autoReconnect', on: mi.checked })
        },
        {
          id: 'opt-tmux',
          label: '재접속하면 tmux 다시 붙기',
          type: 'checkbox',
          checked: true,
          click: (mi) => mainWindow && mainWindow.webContents.send('menu:option', { key: 'tmuxReattach', on: mi.checked })
        },
        { type: 'separator' },
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
          label: 'AI 채팅',
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
  openExternalSafe(url);
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

ipcMain.handle('codex:installHooks', async (e, { sessionId }) => {
  try {
    return await codexhooks.install(sessionId);
  } catch (err) {
    return false;
  }
});

ipcMain.handle('codex:info', async (e, { sessionId }) => {
  try {
    return await codexinfo.fetchInfo(sessionId);
  } catch (err) {
    return { loggedIn: false };
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

/** 화면 쪽 설정값을 메뉴 체크 표시에 반영한다 */
ipcMain.on('settings:sync', (e, opts) => {
  const menu = Menu.getApplicationMenu();
  if (!menu || !opts) return;
  const map = { 'opt-notify': 'notifyOs', 'opt-reconnect': 'autoReconnect', 'opt-tmux': 'tmuxReattach' };
  for (const [id, key] of Object.entries(map)) {
    const item = menu.getMenuItemById(id);
    if (item && typeof opts[key] === 'boolean') item.checked = opts[key];
  }
});

/* ------------------------------- 앱 밖 알림 · 절전 ------------------------------- */

/*
 * 창이 가려져 있을 때도 "끝났다 / 물어본다" 를 알린다.
 * 앱 안의 초록 느낌표만으로는 다른 창에서 일하는 동안 알 수가 없다.
 *   - 알림을 누르면 그 판으로 바로 이동한다.
 *   - 배지(맥/리눅스)와 창 깜빡임(윈도우)으로 대기 건수를 알린다.
 */
ipcMain.on('notify:alert', (e, { leafId, title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: String(title || 'Armux'),
    body: String(body || ''),
    silent: false
  });
  n.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('notify:jump', { leafId });
  });
  n.show();
});

/** 대기 중인 판 개수를 독 배지(맥·리눅스) 또는 창 깜빡임(윈도우)으로 */
ipcMain.on('notify:badge', (e, { count }) => {
  const n = Math.max(0, Number(count) || 0);
  try {
    app.setBadgeCount(n); // 윈도우에서는 조용히 무시된다
  } catch (err) {
    /* noop */
  }
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    // 윈도우는 배지 대신 작업표시줄 깜빡임 (포커스를 얻으면 저절로 멈춘다)
    mainWindow.flashFrame(n > 0 && !mainWindow.isFocused());
  }
});

/*
 * 절전에서 깨어나면 SSH 연결은 대개 죽어 있다(keepalive 20초 × 6회).
 * 노트북을 덮었다 열 때마다 판마다 Enter 를 눌러야 했으므로, 깨어나면
 * 화면 쪽에 알려서 끊긴 판을 알아서 다시 붙이게 한다.
 */
powerMonitor.on('suspend', () => send('power:suspend'));
powerMonitor.on('resume', () => send('power:resume'));

/* ---------------------------------- AI 채팅 ---------------------------------- */

/*
 * AI 채팅 — 원격(또는 로컬) 서버에 설치된 CLI 를 그대로 빌려 쓴다.
 * API 키가 필요 없고, 사용량은 그 서버에 로그인된 계정에서 나간다.
 *
 *   claude : claude -p --output-format stream-json  (--resume 로 맥락 유지)
 *   codex  : codex exec --json                      (exec resume <id> 로 맥락 유지)
 *
 * 프롬프트는 따옴표 문제를 피하려고 base64 → stdin 으로 넘긴다.
 */

/** claude 실행 파일 찾기 (SSH exec 는 로그인 셸이 아닐 수 있다) */
const FIND_CLAUDE = `
CLAUDE="$(command -v claude 2>/dev/null)"
if [ -z "$CLAUDE" ]; then
  for c in "$HOME"/.local/bin/claude "$HOME"/.claude/local/claude /usr/local/bin/claude /opt/homebrew/bin/claude; do
    [ -x "$c" ] && CLAUDE="$c" && break
  done
fi`.trim();

/** 이어지는 대화 id 는 셸로 들어가므로 UUID 글자만 남긴다 */
const safeId = (id) => String(id || '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 64);

/**
 * 질문 한 번을 실행할 셸 스크립트.
 * @param {'claude'|'codex'} tool
 * @param {boolean} stream  조각조각 흘려보낼지(true) 한 번에 받을지(false)
 */
function buildAskScript(tool, promptB64, resumeId, stream) {
  const decode = `printf %s ${promptB64} | { base64 -d 2>/dev/null || base64 --decode; }`;
  if (tool === 'codex') {
    // 주의: resume 은 하위 명령이라 --json 같은 옵션보다 "뒤" 에 와야 한다.
    //   codex exec <옵션들> resume <스레드id> -     ← 맞음
    //   codex exec resume <스레드id> <옵션들> -     ← resume 이 그 옵션들을 모른다
    const resume = resumeId ? ` resume ${safeId(resumeId)}` : '';
    // 채팅용이므로 읽기 전용 모래상자로 돌린다(실수로 파일을 고치지 않게).
    /*
     * codex 는 "그 대화가 없다" 를 stderr 로 낸다(stdout 은 JSONL 전용).
     * 그래서 stderr 를 따로 받아 두었다가, 그 경우에만 표식을 한 줄 남긴다.
     * (stderr 를 통째로 stdout 에 합치면 모델 갱신 경고 같은 잡음이 섞인다)
     */
    return `
${codexinfo.FIND_CODEX}
if [ -z "$CODEX" ]; then echo 'ARMUX_AI:no-codex'; exit 0; fi
cd "$HOME" 2>/dev/null
ERR=$(mktemp 2>/dev/null || echo "$HOME/.armux-codex-err.$$")
${decode} | "$CODEX" exec --json --skip-git-repo-check -s read-only${resume} - 2>"$ERR"
grep -qiE 'no rollout found|thread not found|no such thread' "$ERR" && echo 'ARMUX_AI:resume-gone'
rm -f "$ERR"
`.trim();
  }
  const resume = resumeId ? `--resume ${safeId(resumeId)} ` : '';
  const fmt = stream
    ? '--output-format stream-json --include-partial-messages --verbose'
    : '--output-format json';
  return `
${FIND_CLAUDE}
if [ -z "$CLAUDE" ]; then echo 'ARMUX_AI:no-claude'; exit 0; fi
cd "$HOME" 2>/dev/null
${decode} | "$CLAUDE" -p ${resume}${fmt} 2>/dev/null
`.trim();
}

/** 그 서버에 CLI 가 없을 때 보여 줄 말 */
function missingMsg(tool) {
  return tool === 'codex'
    ? '이 서버에서 codex 명령을 찾지 못했습니다. Codex CLI 가 설치되어 있어야 합니다.'
    : '이 서버에서 claude 명령을 찾지 못했습니다. Claude Code 가 설치되어 있어야 합니다.';
}

/** 스크립트를 로그인 셸로 감싸 원격에서 돌릴 형태로 */
function wrapRemote(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `S=${b64}; { printf %s "$S" | base64 -d 2>/dev/null || printf %s "$S" | base64 --decode 2>/dev/null; } | bash -l`;
}

ipcMain.handle('ai:ask', async (e, { sessionId, prompt, resumeId, tool }) => {
  const kind = tool === 'codex' ? 'codex' : 'claude';
  const b64 = Buffer.from(String(prompt || ''), 'utf8').toString('base64');
  const script = buildAskScript(kind, b64, resumeId, false);

  let stdout = '';
  if (ssh.isLocal(sessionId)) {
    // 로컬 터미널 그룹: 이 PC 의 CLI 를 직접 실행한다 (win 은 아직 미지원)
    if (process.platform === 'win32') {
      return { error: '로컬 터미널의 AI 채팅은 아직 macOS/리눅스에서만 지원합니다.' };
    }
    stdout = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('bash', ['-lc', script], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(String(out || ''));
      });
    });
  } else {
    const res = await ssh.exec(sessionId, wrapRemote(script), 180000);
    stdout = res.stdout; // 답변이 길면 오래 걸린다
  }
  const text = String(stdout);
  if (text.includes('ARMUX_AI:no-claude') || text.includes('ARMUX_AI:no-codex')) {
    return { error: missingMsg(kind) };
  }

  if (kind === 'codex') {
    // codex 는 JSONL 이라 마지막 agent_message 를 답으로 삼는다
    let answer = '';
    let threadId = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let o = null;
      try {
        o = JSON.parse(t);
      } catch (err) {
        continue;
      }
      if (o.type === 'thread.started' && o.thread_id) threadId = o.thread_id;
      if (o.type === 'item.completed' && o.item && o.item.type === 'agent_message') {
        answer = String(o.item.text || '');
      }
    }
    if (!answer) return { error: '응답이 비어 있습니다. (codex 로그인 상태를 확인해 보세요)' };
    return { result: answer, sessionId: threadId };
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

/**
 * 스트리밍판. 사고 과정(thinking)·도구 사용·답변 텍스트를 조각조각 흘려보낸다.
 *   ai:delta → { reqId, kind: 'thinking'|'text'|'step', text }
 * invoke 자체는 끝났을 때 { result, sessionId } 또는 { error } 로 완결된다.
 *
 * claude 는 토큰 단위로 흐르고, codex 는 "항목이 끝날 때마다" 온다(줄 단위).
 * 둘 다 같은 delta 모양으로 바꿔서 보내므로 화면 쪽은 구분할 필요가 없다.
 */
ipcMain.handle('ai:askStream', async (e, { reqId, sessionId, prompt, resumeId, tool }) => {
  // 이어 말하기가 통하지 않으면(그 서버에 그 대화가 없다) 새 대화로 한 번 더 시도한다
  const first = await runAskStream(e, { reqId, sessionId, prompt, resumeId, tool });
  if (!first.resumeFailed) return first;
  const again = await runAskStream(e, { reqId, sessionId, prompt, resumeId: null, tool, retry: true });
  return { ...again, restarted: true }; // 화면에 "새 대화로 다시 보냈다" 고 알린다
});

async function runAskStream(e, { reqId, sessionId, prompt, resumeId, tool, retry }) {
  const kind = tool === 'codex' ? 'codex' : 'claude';
  const b64 = Buffer.from(String(prompt || ''), 'utf8').toString('base64');
  const script = buildAskScript(kind, b64, resumeId, true);

  // 델타는 "요청을 보낸 창" 으로 직접 보낸다.
  // (send() 는 메인 창 전용이라 다른 창에서는 델타를 못 받는다)
  const sender = e.sender;
  return await new Promise((resolve) => {
    let buf = '';
    let final = null; // claude 의 result 이벤트
    let answer = ''; // codex 의 마지막 agent_message
    let threadId = null; // codex 의 thread_id
    let sawMissing = false;
    let resumeGone = false; // 이어 말하기 id 가 그 서버에 없다

    const emit = (dkind, text) => {
      if (!sender.isDestroyed()) sender.send('ai:delta', { reqId, kind: dkind, text });
    };
    // 다시 보내는 것이면 첫 시도에서 흘러갔을 조각을 화면에서 먼저 지운다
    if (retry) emit('reset', '');

    const handleClaude = (o) => {
      if (o.type === 'stream_event' && o.event) {
        const ev = o.event;
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'thinking_delta') emit('thinking', ev.delta.thinking || '');
          else if (ev.delta.type === 'text_delta') emit('text', ev.delta.text || '');
        } else if (ev.type === 'content_block_start' && ev.content_block) {
          if (ev.content_block.type === 'tool_use') {
            emit('step', `도구 실행: ${ev.content_block.name || '?'}`);
          }
        }
      } else if (o.type === 'result') {
        final = o;
      }
    };

    const handleCodex = (o) => {
      if (o.type === 'thread.started' && o.thread_id) {
        threadId = o.thread_id;
        return;
      }
      const item = o.item;
      if (o.type === 'item.started' && item && item.type === 'command_execution') {
        emit('step', `명령 실행: ${String(item.command || '').slice(0, 120)}`);
        return;
      }
      if (o.type !== 'item.completed' || !item) return;
      if (item.type === 'agent_message') {
        // codex 는 중간 안내 메시지도 agent_message 로 보낸다.
        // 마지막 것이 최종 답이므로, 새 메시지가 오면 앞의 것은 사고 과정으로 접어 둔다.
        if (answer) emit('thinking', `${answer}\n\n`);
        answer = String(item.text || '');
        emit('answer', answer); // 화면은 이 값으로 답변을 통째로 갈아 끼운다
      } else if (item.type === 'reasoning') {
        emit('thinking', `${String(item.text || item.summary || '')}\n`);
      } else if (item.type === 'command_execution') {
        const code = item.exit_code;
        emit('step', `명령 끝남 (exit ${code == null ? '?' : code})`);
      } else if (item.type === 'file_change' || item.type === 'patch') {
        emit('step', '파일 변경 제안');
      } else if (item.type === 'mcp_tool_call' || item.type === 'web_search') {
        emit('step', `도구 실행: ${item.type}`);
      }
    };

    const feed = (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.includes('ARMUX_AI:no-claude') || line.includes('ARMUX_AI:no-codex')) {
          sawMissing = true;
          continue;
        }
        /*
         * 이어 말하기 id 는 "그 서버의" 대화 id 다. 그 서버에 그런 대화가 없으면
         * JSON 이 아니라 한 줄 오류만 나온다. 이때만 새 대화로 다시 시도한다.
         *   claude: No conversation found with session ID: ...
         *   codex : thread/resume failed: no rollout found for thread id ...
         * (그 밖의 실패까지 다시 보내면 시간이 두 배로 들고, 하던 대화가
         *  까닭 없이 새로 시작될 수 있다)
         */
        if (
          line.includes('ARMUX_AI:resume-gone') || // codex (stderr 를 검사해 남긴 표식)
          /No conversation found|session not found/i.test(line) // claude (stdout 으로 나온다)
        ) {
          resumeGone = true;
          continue;
        }
        let o = null;
        try {
          o = JSON.parse(line);
        } catch (err) {
          continue; // JSON 이 아닌 줄(셸 잡음)은 무시
        }
        if (kind === 'codex') handleCodex(o);
        else handleClaude(o);
      }
    };

    const done = (err) => {
      if (sawMissing) return resolve({ error: missingMsg(kind) });
      // 이어 말하기가 통하지 않았다 — 부른 쪽이 새 대화로 다시 시도한다
      if (resumeGone) return resolve({ resumeFailed: true });
      if (kind === 'codex') {
        if (answer) return resolve({ result: answer, sessionId: threadId });
        return resolve({
          error: err ? String(err.message || err) : '응답이 비어 있습니다. (codex 로그인 상태를 확인해 보세요)'
        });
      }
      if (final) {
        if (final.is_error) return resolve({ error: String(final.result || '오류가 났습니다.') });
        return resolve({ result: String(final.result || ''), sessionId: final.session_id || null });
      }
      resolve({ error: err ? String(err.message || err) : '응답이 비어 있습니다. (로그인 상태를 확인해 보세요)' });
    };

    if (ssh.isLocal(sessionId)) {
      if (process.platform === 'win32') {
        return resolve({ error: '로컬 터미널의 AI 채팅은 아직 macOS/리눅스에서만 지원합니다.' });
      }
      const { spawn } = require('child_process');
      const child = spawn('bash', ['-lc', script]);
      const killer = setTimeout(() => child.kill('SIGKILL'), 300000);
      child.stdout.on('data', (d) => feed(d.toString('utf8')));
      child.on('close', () => {
        clearTimeout(killer);
        done(null);
      });
      child.on('error', (err) => {
        clearTimeout(killer);
        done(err);
      });
      return;
    }

    ssh.execStream(sessionId, wrapRemote(script), 300000, feed, (err) => done(err));
  });
}

/**
 * 이 서버에 어떤 AI CLI 가 깔려 있는지 본다. (없는 것은 채팅 목록에 띄우지 않는다)
 * 결과: { claude: boolean, codex: boolean }
 */
ipcMain.handle('ai:tools', async (e, { sessionId }) => {
  const script = `
${FIND_CLAUDE}
${codexinfo.FIND_CODEX}
printf 'ARMUX_TOOLS:%s:%s\\n' "$([ -n "$CLAUDE" ] && echo 1 || echo 0)" "$([ -n "$CODEX" ] && echo 1 || echo 0)"
`.trim();
  try {
    let out = '';
    if (ssh.isLocal(sessionId)) {
      if (process.platform === 'win32') return { claude: false, codex: false };
      out = await new Promise((resolve) => {
        const { execFile } = require('child_process');
        execFile('bash', ['-lc', script], { timeout: 15000 }, (err, so) => resolve(String(so || '')));
      });
    } else {
      const res = await ssh.exec(sessionId, wrapRemote(script), 15000);
      out = String(res.stdout || '');
    }
    const m = out.match(/ARMUX_TOOLS:([01]):([01])/);
    if (!m) return { claude: false, codex: false };
    return { claude: m[1] === '1', codex: m[2] === '1' };
  } catch (err) {
    return { claude: false, codex: false };
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
  openExternalSafe(url);
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
