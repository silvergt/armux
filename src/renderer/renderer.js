'use strict';

/* global Terminal, FitAddon, WebLinksAddon, SearchAddon, UnicodeGraphemesAddon, WebglAddon */

/**
 * Armux Terminal 렌더러.
 *
 * 화면 계층은 3단계다.
 *   - 그룹(메인탭)  : 상단 탭바의 각 항목 = "세로 열". Ctrl+Alt+숫자 로 이동.
 *   - 탭(서브탭)    : 그룹 아래 탭바의 각 항목 = "가로 줄". Ctrl+숫자 로 이동.
 *   - 페인(분할 창) : 탭 하나를 좌우/상하로 쪼갠 조각. 각각이 독립된 SSH 셸이다.
 *
 * 페인 구조는 이진 트리로 관리한다.
 *   leaf  = { kind:'leaf',  ... 터미널 1개 = SSH 세션 1개 }
 *   split = { kind:'split', dir:'row'|'col', children:[a,b], sizes:[0.5,0.5] }
 */

const api = window.armux;

/* --------------------------------- 전역 상태 --------------------------------- */

const state = {
  groups: [], // 메인탭 목록
  activeGroupId: null,
  notesOpen: false, // 메모장 화면을 보고 있는지
  fontSize: Number(localStorage.getItem('fontSize')) || 13
};

const sessionToLeaf = new Map(); // sessionId -> leaf (IPC 이벤트 라우팅용)
let uid = 0;
const nextId = (prefix) => `${prefix}${++uid}`;

/* --------------------------------- DOM 참조 --------------------------------- */

const el = {
  body: document.body,
  tabstrip: document.getElementById('tabstrip'),
  substrip: document.getElementById('substrip'),
  terms: document.getElementById('terms'),
  stage: document.getElementById('stage'),
  dock: document.getElementById('dock'),
  dockDivider: document.getElementById('dock-divider'),
  emptyState: document.getElementById('empty-state'),
  newGroupBtn: document.getElementById('new-group-btn'),
  notesTab: document.getElementById('notes-tab'),
  clock: document.getElementById('clock'),
  statusLeft: document.getElementById('status-left'),
  statusClaude: document.getElementById('status-claude'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('find-input')
};

if (api.platform === 'darwin') el.body.classList.add('is-mac');

/* ------------------------------ 터미널 테마/폰트 ------------------------------ */

const THEME = {
  background: '#000000',
  foreground: '#e4e4e4',
  cursor: '#f2f2f2',
  cursorAccent: '#000000',
  selectionBackground: '#2f5c8f',
  black: '#000000',
  red: '#ff5f57',
  green: '#5af78e',
  yellow: '#f3f99d',
  blue: '#57c7ff',
  magenta: '#ff6ac1',
  cyan: '#9aedfe',
  white: '#d0d0d0',
  brightBlack: '#686868',
  brightRed: '#ff5f57',
  brightGreen: '#5af78e',
  brightYellow: '#f3f99d',
  brightBlue: '#57c7ff',
  brightMagenta: '#ff6ac1',
  brightCyan: '#9aedfe',
  brightWhite: '#ffffff'
};

/**
 * OS별 폰트 스택.
 * - windows: PowerShell / Windows Terminal 기본 글꼴인 Cascadia Mono → Consolas 순.
 *   한글은 윈도우 터미널과 동일하게 맑은 고딕으로 폴백하고, 이모지는 Segoe UI Emoji 가 받는다.
 * - macOS: 터미널 기본 Menlo → SF Mono, 한글 Apple SD Gothic Neo, 이모지 Apple Color Emoji.
 */
const FONT_STACKS = {
  win32:
    '"Cascadia Mono", "Cascadia Code", Consolas, "D2Coding", "Malgun Gothic", "맑은 고딕", "Segoe UI Emoji", "Segoe UI Symbol", monospace',
  darwin:
    'Menlo, "SF Mono", Monaco, "D2Coding", "Apple SD Gothic Neo", "Apple Color Emoji", monospace',
  linux:
    '"DejaVu Sans Mono", "Liberation Mono", "D2Coding", "Noto Sans Mono CJK KR", "Noto Color Emoji", monospace'
};
const FONT_STACK = FONT_STACKS[api.platform] || FONT_STACKS.linux;

// 메인탭 전환 단축키 표시 (Ctrl+Alt+숫자)
const MAIN_TAB_MOD = api.platform === 'darwin' ? '⌘⌃' : 'Alt';
const isMacPlatform = api.platform === 'darwin';

/** 이 이벤트가 "우리 단축키의 주 수정키"를 누른 상태인가 (mac ⌘ / 그 외 Ctrl) */
const hasMod = (e) => (isMacPlatform ? e.metaKey : e.ctrlKey);

/**
 * 이벤트 대상이 "글자를 입력받는 칸" 인지.
 * xterm 이 쓰는 숨은 textarea 는 터미널로 취급해야 하므로 제외한다.
 */
function isTextInput(target) {
  if (!target || !target.tagName) return false;
  if (target.classList && target.classList.contains('xterm-helper-textarea')) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true;
}

/* ------------------------------- 상태 조회 헬퍼 ------------------------------- */

const activeGroup = () => state.groups.find((g) => g.id === state.activeGroupId) || null;

function activeTab() {
  const g = activeGroup();
  return g ? g.tabs.find((t) => t.id === g.activeTabId) || null : null;
}

function activeLeaf() {
  const t = activeTab();
  if (!t) return null;
  return findLeaf(t.root, t.activeLeafId) || firstLeaf(t.root);
}

/** 트리를 순회하며 leaf 를 모두 모은다 */
function leavesOf(node, out = []) {
  if (!node) return out;
  if (node.kind === 'leaf') out.push(node);
  else node.children.forEach((c) => leavesOf(c, out));
  return out;
}

const firstLeaf = (node) => leavesOf(node)[0] || null;
const findLeaf = (node, id) => leavesOf(node).find((l) => l.id === id) || null;

/** 트리에서 target 노드를 replacement 로 교체 (루트면 tab.root 자체를 바꾼다) */
function replaceNode(tab, target, replacement) {
  if (tab.root === target) {
    tab.root = replacement;
    return true;
  }
  const walk = (node) => {
    if (!node || node.kind !== 'split') return false;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i] === target) {
        node.children[i] = replacement;
        return true;
      }
      if (walk(node.children[i])) return true;
    }
    return false;
  };
  return walk(tab.root);
}

/** 트리에서 leaf 를 떼어낸다. 형제 노드가 부모 자리를 물려받는다. */
function detachLeaf(tab, leaf) {
  if (tab.root === leaf) {
    tab.root = null;
    return;
  }
  const walk = (node, parent) => {
    if (!node || node.kind !== 'split') return false;
    const idx = node.children.indexOf(leaf);
    if (idx >= 0) {
      const sibling = node.children[1 - idx];
      if (parent === null) tab.root = sibling;
      else replaceNode(tab, node, sibling);
      // 남은 형제가 위 단계로 올라가므로, 그 자리의 비율은 다시 균등하게 맞춘다
      if (parent) parent.sizes = [0.5, 0.5];
      return true;
    }
    return node.children.some((c) => walk(c, node));
  };
  walk(tab.root, null);
}

/* ------------------------------- 페인(leaf) 생성 ------------------------------ */

/**
 * 터미널 1개짜리 페인을 만든다. SSH 접속까지 시작한다.
 * @param {object} tab      소속 서브탭
 * @param {object} connect  { hostId, credId, profile } 접속 파라미터
 */
function createLeaf(tab, connect, options) {
  const opts = options || {};
  const leaf = {
    kind: 'leaf',
    id: nextId('p'),
    tabId: tab.id,
    groupId: tab.groupId,
    sessionId: null,
    status: 'connecting', // connecting | ready | closed | error
    title: '',
    alert: false, // Claude Code 등이 사용자 응답을 기다리는 중인지
    tail: '', // 알림 감지를 위한 최근 출력 버퍼(ANSI 제거본)
    lastInputAt: 0, // 마지막으로 사용자가 키를 누른 시각
    spin: null, // 'busy' = Claude 가 생각하는 중
    wasThinking: false, // 직전 검사에서 Claude 가 작업 중이었는지
    lastOutputAt: 0,
    mode: 'terminal', // 'terminal' | 'web' | 'file'
    web: null, // 웹 브라우저 화면 (웹으로 전환할 때 만든다)
    file: null, // 파일 뷰어 (파일을 열 때 만든다)
    notes: null, // 메모장 (이 판을 메모로 전환할 때 만든다)
    explorer: null, // 파일 탐색기 (이 판을 파일로 전환할 때 만든다)
    connect
  };

  // 판 DOM: 얇은 헤더 한 줄 + 본문(터미널 또는 웹)
  const pane = document.createElement('div');
  pane.className = 'pane';

  const header = document.createElement('div');
  header.className = 'pane-header';
  pane.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pane-body';
  pane.appendChild(body);

  const termHost = document.createElement('div');
  termHost.className = 'pane-term';
  body.appendChild(termHost);

  const term = new Terminal({
    fontFamily: FONT_STACK,
    fontSize: state.fontSize,
    theme: THEME,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  try {
    // 이모지/한글 등 폭 계산을 유니코드 15 grapheme 기준으로 (깨짐 방지)
    term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
    term.unicode.activeVersion = '15-graphemes';
  } catch (e) {
    /* 애드온 실패해도 기본 동작은 유지 */
  }
  try {
    // 터미널 안의 링크 클릭 → 기본 브라우저로 연다
    term.loadAddon(
      new WebLinksAddon.WebLinksAddon((event, uri) => {
        api.util.openExternal(uri);
      })
    );
  } catch (e) {
    /* noop */
  }

  // OSC 6789: Claude Code 훅이 보내는 상태 신호(우리가 원격 settings.json 에 심는다).
  //   armux-status;busy → 작업 시작, ;idle → 완료, ;alert → 입력/권한 대기.
  // 화면 추측보다 정확하므로, 한 번이라도 신호가 오면 이 판은 훅 상태를 따른다.
  try {
    term.parser.registerOscHandler(6789, (data) => {
      const parts = String(data).split(';'); // "armux-status;<sig>"
      if (parts[0] !== 'armux-status') return true;
      const sig = parts[1];
      leaf.hooksActive = true;
      leaf.hookAt = Date.now();
      if (sig === 'busy') {
        clearAlert(leaf);
        leaf.hookBusy = true;
      } else if (sig === 'idle') {
        leaf.hookBusy = false;
        const cur = activeLeaf();
        const looking = cur && cur.id === leaf.id && document.hasFocus() && !state.notesOpen;
        if (!looking) raiseAlert(leaf); // 끝났는데 안 보고 있으면 알림
      } else if (sig === 'alert') {
        leaf.hookBusy = false;
        raiseAlert(leaf, true); // 입력/권한 대기 — 보고 있어도 표시
      }
      scheduleRender();
      return true;
    });
  } catch (e) {
    /* noop */
  }

  // OSC 9(iTerm2) / OSC 777(rxvt) : 표준 "터미널 알림" 시퀀스.
  // Claude Code 외의 도구(다른 AI 에이전트, notify-send 계열)가 완료를 알릴 때 쓰므로
  // 우리 훅과 별개로 받아서 똑같이 초록 느낌표를 띄운다. (cmux 도 같은 방식)
  try {
    term.parser.registerOscHandler(9, () => {
      raiseAlert(leaf); // 보고 있는 판이면 raiseAlert 가 알아서 무시한다
      scheduleRender();
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      if (String(data).startsWith('notify')) {
        raiseAlert(leaf);
        scheduleRender();
      }
      return true;
    });
  } catch (e) {
    /* noop */
  }

  // OSC 52: tmux·vim 등이 시스템 클립보드로 복사할 때 쓰는 시퀀스를 받아 실제로 클립보드에 쓴다.
  // (이게 없으면 tmux 복사가 tmux 자체 버퍼에만 들어가 앱 밖에서 붙여넣기가 안 된다)
  try {
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';');
      const payload = semi >= 0 ? data.slice(semi + 1) : data;
      if (payload === '?') return true; // 읽기 요청은 무시(보안)
      try {
        const text = decodeURIComponent(escape(atob(payload))); // base64 → UTF-8
        if (text) api.util.clipboardWrite(text);
      } catch (err) {
        /* 잘못된 페이로드는 무시 */
      }
      return true;
    });
  } catch (e) {
    /* noop */
  }

  term.open(termHost);

  // 터미널 커서 이동/삭제 단축키를 표준 시퀀스로 변환해 셸로 보낸다.
  // (mac 의 ⌘/⌥ 조합과 Alt+방향키를 iTerm/Terminal.app 과 같게 맞춘다)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (!leaf.sessionId || leaf.status !== 'ready') return true;
    const send = (seq) => {
      api.ssh.write(leaf.sessionId, seq);
      return false; // xterm 기본 처리 중단
    };
    const mac = isMacPlatform;
    const cmd = mac && e.metaKey && !e.ctrlKey && !e.altKey;
    const opt = e.altKey && !e.metaKey && !e.ctrlKey; // Option / Alt 단독

    // ⌘⌥ / Ctrl+Alt + 방향키는 분할 창 이동(위에서 처리)이므로 건드리지 않는다
    if (e.altKey && (mac ? e.metaKey : e.ctrlKey)) return true;

    if (opt && e.key === 'ArrowLeft') return send('\x1bb'); // 한 단어 뒤로
    if (opt && e.key === 'ArrowRight') return send('\x1bf'); // 한 단어 앞으로
    if (opt && (e.key === 'Backspace')) return send('\x1b\x7f'); // 한 단어 삭제

    if (cmd && e.key === 'ArrowLeft') return send('\x01'); // 줄 처음(Ctrl+A)
    if (cmd && e.key === 'ArrowRight') return send('\x05'); // 줄 끝(Ctrl+E)
    if (cmd && e.key === 'Backspace') return send('\x15'); // 줄 처음까지 삭제(Ctrl+U)

    return true;
  });

  // GPU 렌더러. 기본 DOM 렌더러보다 훨씬 가볍다(특히 macOS).
  // 컨텍스트를 잃으면 자동으로 기본 렌더러로 돌아간다.
  //
  // 단, 파일/웹 전용 판(orphan+silent)은 터미널을 화면에 그리지 않으므로 만들지
  // 않고, 살아 있는 WebGL 판 수도 제한한다 — 브라우저는 WebGL 컨텍스트를
  // ~16개까지만 허용해서 넘치면 GPU 프로세스가 불안정해져 앱이 통째로 죽을 수 있다.
  const isViewerOnly = opts.mode === 'orphan' && opts.silent;
  let webglLive = 0;
  for (const g of state.groups) for (const t of g.tabs) for (const lf of leavesOf(t.root)) if (lf._webgl) webglLive++;
  if (!isViewerOnly && webglLive < 12) {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        leaf._webgl = false;
        try {
          webgl.dispose();
        } catch (e2) {
          /* noop */
        }
      });
      term.loadAddon(webgl);
      leaf._webgl = true;
    } catch (e) {
      /* WebGL 을 못 쓰면 기본 렌더러로 그대로 간다 */
    }
  }

  leaf.el = pane;
  leaf.term = term;
  leaf.fit = fit;
  leaf.search = search;

  // 키 입력 → SSH 로 전달. 사용자가 직접 입력했다면 알림은 확인한 것으로 본다.
  term.onData((data) => {
    leaf.lastInputAt = Date.now();
    clearAlert(leaf);
    if (leaf.sessionId && leaf.status === 'ready') {
      api.ssh.write(leaf.sessionId, data);
    } else if (leaf.status === 'closed' || leaf.status === 'error') {
      if (data === '\r') reconnect(leaf); // 종료된 페인에서 Enter → 재접속
    }
  });

  // 셸이 보낸 타이틀(OSC 0/2)
  term.onTitleChange((title) => {
    if (!title) return;
    leaf.title = title;
    scheduleRender();
  });

  // 터미널 벨(^G) → 사용자 주의가 필요하다는 표준 신호.
  // 단, 방금 키를 누른 직후의 벨은 셸(readline)의 경고음이므로 알림으로 치지 않는다.
  term.onBell(() => {
    if (Date.now() - leaf.lastInputAt > 3000) raiseAlert(leaf);
  });

  // 드래그 선택 시 자동 복사
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) api.util.clipboardWrite(sel);
  });

  // 우클릭 붙여넣기
  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const text = await api.util.clipboardRead();
    if (text && leaf.sessionId && leaf.status === 'ready') api.ssh.write(leaf.sessionId, text);
  });

  // 페인 클릭 → 그 페인이 활성 페인이 되고 알림도 확인 처리
  pane.addEventListener('mousedown', () => focusLeaf(leaf));

  if (opts.mode === 'orphan' && opts.silent) {
    leaf.status = 'closed'; // 웹 전용 판: 터미널은 쓰지 않는다
  } else if (opts.mode === 'orphan') {
    // 복원했지만 저장된 접속 정보가 없는 경우: 접속하지 않고 안내만 남긴다
    leaf.status = 'closed';
    leaf.term.writeln('\x1b[90m● 지난번에 열려 있던 창입니다. 저장된 접속 정보가 없어 자동 접속하지 않았습니다.\x1b[0m');
    leaf.term.writeln('\x1b[90m  Enter 를 누르면 접속 창이 열립니다.\x1b[0m');
  } else if (opts.mode === 'later') {
    leaf.status = 'connecting'; // 접속은 호출한 쪽에서 순서대로 시작한다
  } else {
    startSession(leaf);
  }
  return leaf;
}

/** 실제 SSH 접속 시작 (페인/터미널은 이미 만들어진 상태) */
async function startSession(leaf) {
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const h = group.host;
  leaf.status = 'connecting';
  leaf.term.writeln(`\x1b[90m→ ${h.username}@${h.host}:${h.port} 접속 중…\x1b[0m`);
  render();

  try {
    const res = await api.ssh.connect({
      ...leaf.connect,
      size: { cols: leaf.term.cols, rows: leaf.term.rows }
    });
    leaf.sessionId = res.sessionId;
    sessionToLeaf.set(res.sessionId, leaf);

    group.host = { ...group.host, ...res.host };
    group.credId = res.credId || group.credId;
    group.connect = { hostId: res.host.id || null, credId: group.credId };
    leaf.connect = { ...group.connect };
    render();
  } catch (err) {
    leaf.status = 'error';
    leaf.term.writeln(`\r\n\x1b[31m✖ 접속 실패: ${String(err.message || err).replace(/^Error:\s*/, '')}\x1b[0m`);
    leaf.term.writeln('\x1b[90m  Enter 를 누르면 다시 시도합니다.\x1b[0m');
    render();
  }
}

/** 종료/실패한 페인을 같은 정보로 재접속 (정보가 없으면 접속 창을 연다) */
function reconnect(leaf) {
  const conn = leaf.connect || {};
  if (!conn.hostId && !conn.credId && !conn.profile) {
    const group = state.groups.find((g) => g.id === leaf.groupId);
    if (group) openConnectDialog({ group });
    return;
  }
  if (leaf.sessionId) sessionToLeaf.delete(leaf.sessionId);
  leaf.sessionId = null;
  leaf.term.reset();
  startSession(leaf);
}

/** 페인 정리 (세션 종료 + 터미널 파기) */
function disposeLeaf(leaf) {
  if (leaf.sessionId) {
    api.ssh.close(leaf.sessionId);
    sessionToLeaf.delete(leaf.sessionId);
  }
  try {
    leaf.term.dispose();
  } catch (e) {
    /* noop */
  }
  if (leaf.file) { try { leaf.file.dispose(); } catch (e) {} leaf.file = null; }
  if (leaf.web) { try { leaf.web.dispose(); } catch (e) {} leaf.web = null; }
  if (leaf.notes) { try { leaf.notes.dispose(); } catch (e) {} leaf.notes = null; }
  if (leaf.explorer) { try { leaf.explorer.dispose(); } catch (e) {} leaf.explorer = null; }
  leaf.el.remove();
}

/* ------------------------------ 판을 웹으로 전환 ------------------------------ */

/**
 * 판을 터미널 ↔ 웹 브라우저로 전환한다.
 * 터미널은 없애지 않고 감춰 두므로, 돌아오면 SSH 세션이 그대로 살아 있다.
 */
function setLeafMode(leaf, mode, url) {
  const body = leaf.el.querySelector('.pane-body');

  if (mode === 'web') {
    if (!leaf.web) {
      leaf.web = window.WebPane.create({
        url: url || null, // url 없으면 시작 화면(주소 입력 + 즐겨찾기)
        onTitle: (title) => {
          leaf.title = title || leaf.title;
          scheduleRender();
        },
        onUrl: () => saveSession()
      });
      body.appendChild(leaf.web.el);
    } else if (url) {
      leaf.web.go(url);
    }
    leaf.mode = 'web';
  } else if (mode === 'notes') {
    // 메모장을 이 판 안에 띄운다. 판마다 따로 만들어 서로 다른 메모를 볼 수 있다.
    if (!leaf.notes) {
      leaf.notes = window.Notes.create();
      body.appendChild(leaf.notes.el);
    } else {
      leaf.notes.refresh();
    }
    leaf.mode = 'notes';
  } else if (mode === 'explorer') {
    // 파일 탐색기를 이 판 안에 띄운다. 접속 정보가 있어야 SFTP 를 열 수 있다.
    const group = state.groups.find((g) => g.id === leaf.groupId);
    const conn = group && (group.connect || { hostId: group.host.id || null, credId: group.credId });
    if (!conn || (!conn.hostId && !conn.credId)) {
      el.statusLeft.textContent = '접속이 완료된 뒤에 파일 탐색기를 열 수 있습니다.';
      return;
    }
    if (!leaf.explorer) {
      leaf.explorer = window.Explorer.create({
        getConnect: () => group.connect || { hostId: group.host.id || null, credId: group.credId },
        hostLabel: group.host.name,
        getSftpId: () => leaf.explorer && leaf.explorer.sftpId,
        // 파일을 열면 지금까지처럼 새 서브탭에 뷰어를 띄운다(이 판의 SFTP 연결을 쓴다)
        onOpenFile: (entry) => openFileInPane(group, entry, () => leaf.explorer && leaf.explorer.sftpId)
      });
      body.appendChild(leaf.explorer.el);
    }
    leaf.mode = 'explorer';
  } else {
    leaf.mode = 'terminal';
  }

  // 터미널이 아닌 화면으로 옮기면 열려 있던 파일 뷰어는 정리
  if (leaf.mode !== 'terminal' && leaf.mode !== 'file' && leaf.file) {
    leaf.file.dispose();
    leaf.file = null;
  }
  applyPaneBody(leaf);

  renderPaneHeader(leaf);
  render();
  if (leaf.mode === 'web') leaf.web.focus();
  else if (leaf.mode === 'notes') leaf.notes.focus();
  else if (leaf.mode === 'explorer') {
    if (leaf.explorer.focus) leaf.explorer.focus();
  } else {
    fitLeaf(leaf);
    leaf.term.focus();
  }
  saveSession();
}

/* --------------------------- Claude Code 응답 대기 알림 -------------------------- */

// Claude Code 가 사용자 입력을 기다릴 때 화면에 남는 전형적인 문구들
const ALERT_PATTERNS = [
  /Do you want to [^\n]{0,80}\?/i,
  /Would you like [^\n]{0,80}\?/i,
  /❯\s*1\.\s/, // 선택지 목록 (❯ 1. Yes ...)
  /\b1\.\s*Yes\b/,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /\[Y\/n\]/i,
  /Press Enter to continue/i,
  /Continue\?\s*$/im,
  /waiting for (your )?(input|response|confirmation)/i,
  /Allow .{0,40}\?/i
];

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

/*
 * 탭에 붙는 표시는 세 가지뿐이다.
 *   1) Claude 가 생각하는 중            → 스피너   (화면에 "esc to interrupt" 가 보임)
 *   2) Claude 가 생각을 끝낸 직후        → 초록 느낌표 (그 창을 보고 있지 않을 때)
 *   3) 그 밖의 모든 경우                 → 연결 상태 점
 * 일반 명령 실행이나 전체화면 앱은 따로 표시하지 않는다.
 */
// Claude Code 가 "작업 중"일 때만 화면 하단에 나타나는 문구들
/**
 * 한 줄이 Claude 의 "작업 중" 라이브 상태줄인지 판별한다.
 * 상태줄은 "esc to interrupt" 와 함께 항상 스피너 말줄임표(…)나 진행 표시(초·토큰),
 * 또는 "ctrl+t" 힌트를 같은 줄에 달고 있다.
 * 대화 본문에 그냥 "(esc to interrupt)" 라는 말이 들어 있어도 이런 동반 표시가 없어 걸러진다.
 */
// 훅 신호를 이 시간 안에 받았으면 훅 상태를 믿는다. 지나면 화면 감지로 되돌아간다.
const HOOK_TRUST_MS = 1800000; // 30분

const SPINNER_GLYPHS = '✻✽✢✳✶✷✸✹✺·∗✱✲●◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷';
function isClaudeWorkingLine(line) {
  if (!/esc to interrupt/i.test(line)) return false;
  // 라이브 상태줄은 줄 맨 앞에 스피너 글리프가 있다. 대화 본문은 글자/한글로 시작하므로 걸러진다.
  const first = line.trimStart()[0];
  return Boolean(first) && SPINNER_GLYPHS.includes(first);
}
const TMUX_STATUS_RE = /(^|\s)\d+:[^\s]{1,24}[*\-]|"[^"]{1,40}"\s+\d{1,2}:\d{2}/m;

/** 마지막 비어 있지 않은 줄 */
function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/\r/g, '').trimEnd();
    if (l.trim()) return l;
  }
  return '';
}

/**
 * 출력 스트림을 훑어 (1) 실행 중인지 (2) 사용자 응답을 기다리는지 판단한다.
 *
 * 주의: 셸 프롬프트에는 창 제목을 바꾸는 OSC 시퀀스(\x1b]0;…\x07)가 붙어 오는데,
 * 그 끝의 \x07 을 터미널 벨로 오해하면 안 된다. 그래서 ANSI/OSC 를 먼저 걷어낸 뒤
 * 남아 있는 \x07 만 진짜 벨로 본다.
 */
function feedAlertDetector(leaf, text) {
  const plain = text.replace(ANSI_RE, '');

  /* --- 실행 상태 --- */
  leaf.lastOutputAt = Date.now();

  /* --- 진짜 벨 --- */
  if (plain.includes('\x07')) {
    if (Date.now() - leaf.lastInputAt > 3000) raiseAlert(leaf);
  }

  /* --- 응답 대기 문구 --- */
  const body = plain.replace(/\x07/g, '');
  if (!body.trim()) return;

  leaf.tail = (leaf.tail + body).slice(-4000);
  const recent = leaf.tail.slice(-1200);
  if (ALERT_PATTERNS.some((re) => re.test(recent))) {
    raiseAlert(leaf);
    leaf.tail = ''; // 같은 문구로 계속 다시 울리지 않도록
  }
}

/** 알림 켜기. 지금 보고 있는 페인이면 굳이 표시하지 않는다. */
function raiseAlert(leaf, force) {
  if (leaf.alert) return;
  // 보통은 지금 보고 있는 판이면 표시하지 않는다.
  // 단 force(권한/입력 대기 알림)면 보고 있어도 표시한다.
  if (!force) {
    const cur = activeLeaf();
    if (cur && cur.id === leaf.id && document.hasFocus()) return;
  }
  leaf.alert = true;
  scheduleRender();
}

function clearAlert(leaf) {
  if (!leaf || !leaf.alert) return;
  leaf.alert = false;
  scheduleRender();
}

/** 탭 안의 모든 페인 알림 해제 (탭을 열어 확인한 경우) */
function clearAlertsInTab(tab) {
  let changed = false;
  for (const l of leavesOf(tab.root)) {
    if (l.alert) {
      l.alert = false;
      changed = true;
    }
  }
  if (changed) scheduleRender();
}

const tabHasAlert = (tab) => leavesOf(tab.root).some((l) => l.alert);
const groupHasAlert = (group) => group.tabs.some(tabHasAlert);

/** 지금 눈에 보이는 화면을 글자로 읽어 온다 (스크롤백이 아니라 현재 화면) */
function readScreenTail(leaf) {
  const buf = leaf.term.buffer.active;
  const start = buf.baseY;
  const end = Math.min(buf.length, start + leaf.term.rows);
  let text = '';
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) text += line.translateToString(true) + '\n';
  }
  return text;
}

/**
 * 화면에서 눈에 보이는 "마지막 비어 있지 않은 몇 줄"만 돌려준다.
 * Claude 의 라이브 상태줄은 항상 화면 맨 아래에 있으므로, 이 부분만 검사하면
 * 위쪽 대화 본문에 우연히 들어간 문구를 상태줄로 오인하지 않는다.
 */
function bottomNonEmptyLines(leaf, n = 3) {
  const buf = leaf.term.buffer.active;
  const end = Math.min(buf.length, buf.baseY + leaf.term.rows);
  const lines = [];
  for (let i = end - 1; i >= buf.baseY && lines.length < n; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const t = line.translateToString(true).replace(/\s+$/, '');
    if (t.trim()) lines.push(t);
  }
  return lines; // 아래에서 위 순서
}

/** tmux 안인지 (상태줄로 판단) */
function looksLikeTmux(leaf) {
  return TMUX_STATUS_RE.test(readScreenTail(leaf));
}

/**
 * 페인 스크롤. tmux 안에서는 터미널 스크롤백이 아니라 tmux 히스토리를 움직여야 한다.
 * (tmux 기본 prefix 인 Ctrl+B 를 사용한다)
 */
function scrollPane(leaf, dir) {
  const alt = leaf.term.buffer.active.type === 'alternate';
  if (alt && looksLikeTmux(leaf) && leaf.sessionId && leaf.status === 'ready') {
    // 복사 모드로 들어가 맨 위로 / 복사 모드를 나와 최신 출력으로
    sendTmuxCommand(leaf, dir === 'top' ? 'copy-mode ; send -X history-top' : 'copy-mode -q');
    return;
  }
  if (dir === 'top') leaf.term.scrollToTop();
  else leaf.term.scrollToBottom();
}

/**
 * tmux 명령 프롬프트(prefix + :)로 명령을 보낸다.
 * 한 번에 몰아서 보내면 tmux 가 prefix 처리 중 뒷부분을 흘리므로 조금씩 끊어서 보낸다.
 */
function sendTmuxCommand(leaf, cmdline) {
  const w = (data) => leaf.sessionId && api.ssh.write(leaf.sessionId, data);
  w('\x02'); // prefix (Ctrl+B)
  setTimeout(() => w(':'), 70);
  setTimeout(() => w(cmdline), 150);
  setTimeout(() => w('\r'), 240);
}

let activityTick = 0;

/** 모든 판을 살펴 Claude 작업 여부를 갱신한다 */
function evaluateActivity() {
  let changed = false;
  activityTick += 1;
  const curTab = activeTab();
  // 보이는 탭은 매번, 나머지는 다섯 번에 한 번만 (느려지지 않게)
  const scanBackground = activityTick % 5 === 0;

  for (const g of state.groups) {
    for (const t of g.tabs) {
      if (t !== curTab && !scanBackground) continue;
      for (const leaf of leavesOf(t.root)) {
        const now = Date.now();
        const live = leaf.mode === 'terminal' && leaf.status === 'ready';

        // 훅 신호를 최근에 받았다면 그 상태를 믿는다(가장 정확).
        // 다만 한참 소식이 없으면(다른 셸로 옮겨갔거나 훅 없는 Claude 를 새로 띄운 경우)
        // 다시 화면 감지로 돌아간다 — 예전에는 한 번 훅을 받으면 영원히 화면을
        // 안 봐서, 훅이 안 오는 상황에서 아이콘이 전혀 안 바뀌었다.
        const hookFresh = leaf.hooksActive && now - (leaf.hookAt || 0) < HOOK_TRUST_MS;

        // 화면 아래쪽의 "작업 중 상태줄" 감지.
        // 스피너 줄 아래에 입력 박스(3줄)·단축키 힌트·tmux 상태줄이 깔리므로
        // 아래에서 12줄까지 살핀다. 대화 본문에 "esc to interrupt" 라는 말이 있어도
        // 줄 맨 앞 스피너 글리프가 없어 걸러진다.
        const seen = live && bottomNonEmptyLines(leaf, 12).some(isClaudeWorkingLine);

        // 훅이 살아 있어도 화면에 스피너가 보이면 작업 중으로 본다.
        // (훅 설치 전에 이미 떠 있던 Claude 세션까지 함께 잡아 준다)
        const busyNow = hookFresh ? Boolean(leaf.hookBusy) || seen : seen;

        // 히스테리시스(시간 기반): 보이면 곧바로 thinking, 마지막으로 본 지 0.8초 안이면 유지.
        // → 다시 그리는 순간 한 프레임 놓쳐도 깜빡이지 않고,
        //   툴 실행으로 출력이 잠깐 멎어도 계속 작업 중으로 본다(성급한 초록 느낌표 방지).
        if (busyNow) leaf.thinkSeenAt = now;
        const thinking = busyNow || (leaf.wasThinking && now - (leaf.thinkSeenAt || 0) < 800);

        // 작업이 끝났는데 그 창을 보고 있지 않으면 알림(초록 느낌표).
        // 훅이 신선하면 Stop 훅이 이미 처리하므로 여기서는 화면 감지 몫만 담당한다.
        if (leaf.wasThinking && !thinking && live && !hookFresh) {
          const cur = activeLeaf();
          const looking = cur && cur.id === leaf.id && document.hasFocus() && !state.notesOpen;
          if (!looking) raiseAlert(leaf);
        }
        leaf.wasThinking = thinking;

        const kind = thinking && live ? 'busy' : null;
        if (leaf.spin !== kind) {
          leaf.spin = kind;
          changed = true;
        }
      }
    }
  }
  if (changed) scheduleRender();
}

setInterval(evaluateActivity, 250);

/** 탭 안에 Claude 가 작업 중인 판이 있는지 */
const tabSpin = (tab) => (leavesOf(tab.root).some((l) => l.spin === 'busy') ? 'busy' : null);
const groupSpin = (group) => (group.tabs.some((t) => tabSpin(t)) ? 'busy' : null);

/* --------------------------------- 탭 / 그룹 --------------------------------- */

/** 빈 서브탭 껍데기(컨테이너)를 만든다. 내용(페인)은 호출한 쪽에서 채운다. */
function makeTabShell(group, insertAfterIndex) {
  const tab = {
    id: nextId('t'),
    groupId: group.id,
    root: null,
    activeLeafId: null,
    container: null,
    panesWrap: null,
    customTitle: null // 사용자가 지정한 서브탭 이름
  };

  const container = document.createElement('div');
  container.className = 'tab-panes';
  const panesWrap = document.createElement('div');
  panesWrap.className = 'panes-wrap';
  container.appendChild(panesWrap);
  el.stage.appendChild(container);
  tab.container = container;
  tab.panesWrap = panesWrap;

  if (insertAfterIndex === undefined || insertAfterIndex < 0) group.tabs.push(tab);
  else group.tabs.splice(insertAfterIndex + 1, 0, tab);
  group.activeTabId = tab.id;
  group.explorerSelected = false;
  state.activeGroupId = group.id;
  return tab;
}

/** 서브탭(가로 줄) 하나를 만든다. 안에 새 세션 페인 1개로 시작. */
function createTab(group, connect) {
  const tab = makeTabShell(group);
  const leaf = createLeaf(tab, connect);
  tab.root = leaf;
  tab.activeLeafId = leaf.id;

  layoutTab(tab);
  render();
  focusLeaf(leaf);
  return tab;
}

/**
 * 분할 창(페인) 하나를 떼어내 새 서브탭으로 옮긴다.
 * 세션은 그대로 살아 있고 화면 위치만 바뀐다.
 */
function popOutLeaf(leaf) {
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const tab = group && group.tabs.find((t) => t.id === leaf.tabId);
  if (!group || !tab) return;
  if (leavesOf(tab.root).length === 1) {
    el.statusLeft.textContent = '이미 이 서브탭에 하나뿐인 창입니다.';
    return;
  }

  detachLeaf(tab, leaf);
  const rest = firstLeaf(tab.root);
  tab.activeLeafId = rest ? rest.id : null;
  layoutTab(tab);

  const newTab = makeTabShell(group, group.tabs.indexOf(tab));
  leaf.tabId = newTab.id;
  newTab.root = leaf;
  newTab.activeLeafId = leaf.id;
  newTab.panesWrap.appendChild(leaf.el); // 터미널을 새 탭 컨테이너로 옮긴다
  layoutTab(newTab);

  render();
  focusLeaf(leaf);
}

/** 새 메인탭(그룹)을 만들고 첫 세션을 연다 */
function createGroup(hostInfo, connect) {
  const group = {
    id: nextId('g'),
    host: {
      id: hostInfo.id || null,
      name: hostInfo.name || `${hostInfo.username}@${hostInfo.host}`,
      host: hostInfo.host,
      port: Number(hostInfo.port) || 22,
      username: hostInfo.username
    },
    credId: null,
    connect: null,
    tabs: [],
    activeTabId: null,
    explorer: null, // SFTP 탐색기 인스턴스 (그룹=호스트 당 하나)
    explorerPinned: loadPinPref(), // true 면 왼쪽에 고정 패널로 항상 표시
    explorerSelected: false // 고정하지 않았을 때, 탐색기 탭이 선택된 상태인지
  };
  state.groups.push(group);
  state.activeGroupId = group.id;
  createTab(group, connect);
  return group;
}

/** 웹페이지만 있는 메인탭을 만든다 (SSH 접속 없이) */
function createWebGroup(url) {
  const group = {
    id: nextId('g'),
    host: { id: null, name: hostLabelForUrl(url), host: url, port: 0, username: 'web' },
    credId: null,
    connect: null,
    isWeb: true,
    tabs: [],
    activeTabId: null,
    explorer: null,
    explorerPinned: false,
    explorerSelected: false
  };
  state.groups.push(group);
  state.activeGroupId = group.id;
  createWebTab(group, url);
  return group;
}

/** 웹페이지 판 하나짜리 서브탭 */
function createWebTab(group, url) {
  const tab = makeTabShell(group);
  const leaf = createLeaf(tab, {}, { mode: 'orphan', silent: true });
  tab.root = leaf;
  tab.activeLeafId = leaf.id;
  layoutTab(tab);
  setLeafMode(leaf, 'web', url);
  render();
  return tab;
}

/** 주소에서 탭 이름으로 쓸 호스트 부분만 */
function hostLabelForUrl(url) {
  try {
    return new URL(url).hostname || '웹페이지';
  } catch (e) {
    return '웹페이지';
  }
}

/** 기존 그룹에 서브탭 추가 (같은 호스트로 새 셸) */
function addSubTab(group) {
  const connect = group.connect || { hostId: group.host.id || null, credId: group.credId };
  if (!connect.hostId && !connect.credId) {
    openConnectDialog({ group }); // 자격증명이 없으면 다시 물어본다
    return;
  }
  createTab(group, connect);
}

/** 서브탭 닫기 전에 확인 (메인탭과 동일하게) */
async function confirmCloseTab(group, tab) {
  const panes = leavesOf(tab.root).length;
  const ok = await api.util.confirm(
    '이 서브탭을 닫을까요?',
    `${group.host.name} · ${panes > 1 ? `분할 창 ${panes}개가 함께 종료됩니다.` : '연결이 종료됩니다.'}`
  );
  if (!ok) return;
  closeTab(group, tab);
}

function closeTab(group, tab) {
  for (const l of leavesOf(tab.root)) disposeLeaf(l);
  tab.container.remove();

  const idx = group.tabs.indexOf(tab);
  group.tabs.splice(idx, 1);

  if (group.tabs.length === 0) {
    closeGroup(group);
    return;
  }
  if (group.activeTabId === tab.id) {
    group.activeTabId = group.tabs[Math.min(idx, group.tabs.length - 1)].id;
  }
  render();
  fitTab(activeTab());
}

function closeGroup(group) {
  for (const t of [...group.tabs]) {
    for (const l of leavesOf(t.root)) disposeLeaf(l);
    t.container.remove();
  }
  if (group.explorer) {
    group.explorer.dispose();
    group.explorer = null;
  }
  const idx = state.groups.indexOf(group);
  state.groups.splice(idx, 1);
  if (state.activeGroupId === group.id) {
    const next = state.groups[Math.min(idx, state.groups.length - 1)];
    state.activeGroupId = next ? next.id : null;
  }
  render();
  fitTab(activeTab());
}

/** 메인탭 닫기 — 항상 한 번 물어본다 */
async function confirmCloseGroup(group) {
  const paneCount = group.tabs.reduce((n, t) => n + leavesOf(t.root).length, 0);
  const ok = await api.util.confirm(
    `"${group.host.name}" 탭을 닫을까요?`,
    paneCount > 1
      ? `서브탭 ${group.tabs.length}개 / 분할 창 ${paneCount}개가 함께 종료됩니다.`
      : `${group.host.username}@${group.host.host}:${group.host.port} 연결이 종료됩니다.`
  );
  if (!ok) return;
  closeGroup(group);
}

/* ---------------------------------- 분할 ----------------------------------- */

/**
 * 현재 페인을 둘로 나눈다.
 * @param {'row'|'col'} dir  row = 좌우 분할(세로선), col = 상하 분할(가로선)
 */
function splitActive(dir) {
  const tab = activeTab();
  const leaf = activeLeaf();
  if (!tab || !leaf) return;

  const group = state.groups.find((g) => g.id === tab.groupId);
  const connect = leaf.connect || group.connect || { hostId: group.host.id || null, credId: group.credId };
  if (!connect.hostId && !connect.credId) {
    openConnectDialog({ group });
    return;
  }

  const newLeaf = createLeaf(tab, connect);
  const split = {
    kind: 'split',
    id: nextId('s'),
    dir,
    children: [leaf, newLeaf],
    sizes: [0.5, 0.5]
  };
  replaceNode(tab, leaf, split);
  tab.activeLeafId = newLeaf.id;

  layoutTab(tab);
  render();
  focusLeaf(newLeaf);
}

/** 페인 하나 닫기. 항상 확인하고, 마지막 페인이면 탭 자체를 닫는다. */
async function closeLeaf(leaf) {
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const tab = group && group.tabs.find((t) => t.id === leaf.tabId);
  if (!tab) return;

  if (leavesOf(tab.root).length === 1) {
    confirmCloseTab(group, tab); // 마지막 창이면 탭이 닫히므로 탭 기준으로 물어본다
    return;
  }

  const ok = await api.util.confirm(
    '이 분할 창을 닫을까요?',
    `${group.host.username}@${group.host.host} · 이 창의 셸 세션이 종료됩니다.`
  );
  if (!ok) return;

  detachLeaf(tab, leaf);
  disposeLeaf(leaf);
  const next = firstLeaf(tab.root);
  tab.activeLeafId = next ? next.id : null;
  layoutTab(tab);
  render();
  if (next) focusLeaf(next);
}

/** 활성 페인 지정 + 알림 해제 + 포커스 */
function focusLeaf(leaf) {
  if (!leaf) return;
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const tab = group && group.tabs.find((t) => t.id === leaf.tabId);
  if (!group || !tab) return;
  state.activeGroupId = group.id;
  group.activeTabId = tab.id;
  tab.activeLeafId = leaf.id;
  clearAlert(leaf);
  render();
  fitTab(tab);
  leaf.term.focus();
}

/** 방향키로 이웃 페인으로 이동 (화면 좌표 기준으로 가장 가까운 페인 선택) */
function focusNeighbor(direction) {
  const tab = activeTab();
  const cur = activeLeaf();
  if (!tab || !cur) return;
  const leaves = leavesOf(tab.root);
  if (leaves.length < 2) return;

  const base = cur.el.getBoundingClientRect();
  const cx = base.left + base.width / 2;
  const cy = base.top + base.height / 2;

  let best = null;
  let bestDist = Infinity;
  for (const l of leaves) {
    if (l === cur) continue;
    const r = l.el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const okDir =
      (direction === 'left' && x < cx) ||
      (direction === 'right' && x > cx) ||
      (direction === 'up' && y < cy) ||
      (direction === 'down' && y > cy);
    if (!okDir) continue;
    const dist = Math.abs(x - cx) + Math.abs(y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = l;
    }
  }
  if (best) focusLeaf(best);
}

/* ------------------------------ 분할 레이아웃 그리기 ----------------------------- */

/** 트리를 실제 DOM 으로 조립한다 (leaf.el 은 재사용) */
function layoutTab(tab) {
  tab.panesWrap.innerHTML = '';
  if (!tab.root) return;
  const rootEl = buildNode(tab, tab.root);
  // 분할이 사라져 루트로 승격된 노드는 예전 비율(inline flex)이 남아 있을 수 있다.
  // 루트는 언제나 화면을 꽉 채워야 하므로 여기서 초기화한다.
  rootEl.style.flex = '1 1 0';
  tab.panesWrap.appendChild(rootEl);
  requestAnimationFrame(() => fitTab(tab));
}

/* ------------------------------- 파일 탐색기 탭 ------------------------------- */

/*
 * 탐색기는 "그룹(호스트)마다 하나 있는 특별한 서브탭" 이다.
 *   - 고정 안 함: 서브탭바의 📁 탭을 고르면 터미널 대신 탐색기가 보인다.
 *   - 왼쪽 고정: 창 왼쪽에 패널로 붙어 터미널과 나란히 항상 보인다.
 */

const PIN_KEY = 'explorerPinned';
const DOCK_KEY = 'explorerDockWidth';
const loadPinPref = () => localStorage.getItem(PIN_KEY) === '1';
let dockWidth = Number(localStorage.getItem(DOCK_KEY)) || 320;

/** 그룹의 탐색기 인스턴스를 준비한다 (접속 정보가 있어야 만들 수 있다) */
function ensureExplorer(group) {
  if (group.explorer) return group.explorer;
  const connect = group.connect || { hostId: group.host.id || null, credId: group.credId };
  if (!connect.hostId && !connect.credId) {
    el.statusLeft.textContent = '접속이 완료된 뒤에 파일 탐색기를 열 수 있습니다.';
    return null;
  }
  group.explorer = window.Explorer.create({
    // 재연결 때마다 최신 자격증명을 쓰도록 함수로 넘긴다
    getConnect: () => group.connect || { hostId: group.host.id || null, credId: group.credId },
    hostLabel: group.host.name,
    getSftpId: () => group.explorer && group.explorer.sftpId,
    onOpenFile: (entry) => openFileInPane(group, entry)
  });
  return group.explorer;
}

/**
 * 탐색기에서 파일을 열 때: 새 서브탭을 만들어 그 안에 파일 뷰어를 띄운다.
 * (터미널 창은 그대로 두고, 파일은 별도 탭으로 열린다. 닫으면 그 탭이 사라진다.)
 */
async function openFileInPane(group, entry, getSftpId) {
  const tab = makeTabShell(group);
  tab.customTitle = entry.name; // 서브탭 제목을 파일명으로
  const leaf = createLeaf(tab, {}, { mode: 'orphan', silent: true }); // 셸 없이 파일 전용 판
  tab.root = leaf;
  tab.activeLeafId = leaf.id;
  layoutTab(tab);

  leaf.mode = 'file';
  leaf.file = window.FileViewer.create({
    // 파일을 연 탐색기의 SFTP 연결을 쓴다(판 안 탐색기면 그 판의 것, 아니면 그룹 것)
    sftpId: () => (getSftpId ? getSftpId() : group.explorer && group.explorer.sftpId),
    sessionId: () => anyReadySession(group), // 원격 실행(parquet/ipynb)용 셸 세션은 그룹에서 빌려온다
    path: entry.path,
    name: entry.name,
    onClose: () => closeFileTab(group, tab)
  });
  leaf.el.querySelector('.pane-body').appendChild(leaf.file.el);
  applyPaneBody(leaf);

  group.explorerSelected = false; // 전체화면 탐색기였다면 나온다
  state.notesOpen = false;
  render();
  leaf.file.focus();
}

/** 파일 전용 탭을 닫는다(그 탭 제거) */
async function closeFileTab(group, tab) {
  const leaf = firstLeaf(tab.root);
  if (leaf && leaf.file && leaf.file.isDirty && leaf.file.isDirty()) {
    const ok = await api.util.confirm('저장하지 않은 변경이 있습니다. 그래도 닫을까요?', '', '닫기');
    if (!ok) return;
  }
  closeTab(group, tab); // 확인 없이 바로 닫음(파일 탭은 셸 세션이 없다)
}

/** 판 본문에서 터미널/웹/파일 중 무엇을 보일지 반영 */
function applyPaneBody(leaf) {
  const termHost = leaf.el.querySelector('.pane-term');
  if (termHost) termHost.classList.toggle('hidden', leaf.mode !== 'terminal');
  if (leaf.web) leaf.web.el.classList.toggle('hidden', leaf.mode !== 'web');
  if (leaf.file) leaf.file.el.classList.toggle('hidden', leaf.mode !== 'file');
  if (leaf.notes) leaf.notes.el.classList.toggle('hidden', leaf.mode !== 'notes');
  if (leaf.explorer) leaf.explorer.el.classList.toggle('hidden', leaf.mode !== 'explorer');
}

/** 📁 탭 선택 (고정 상태면 왼쪽 패널에 포커스만 준다) */
function selectExplorer(group) {
  if (!ensureExplorer(group)) return;
  state.activeGroupId = group.id;
  if (!group.explorerPinned) group.explorerSelected = true;
  render();
  group.explorer.focus();
}

/** 왼쪽 고정 ↔ 해제 */
function toggleExplorerPin(group) {
  if (!ensureExplorer(group)) return;
  group.explorerPinned = !group.explorerPinned;
  localStorage.setItem(PIN_KEY, group.explorerPinned ? '1' : '0');
  // 고정하면 전체화면 탐색기 상태는 해제한다(왼쪽에 항상 보이므로)
  if (group.explorerPinned) group.explorerSelected = false;
  render();
  fitTab(activeTab());
}

/** Ctrl+` : 탐색기 켜고 끄기 (왼쪽에 고정한 경우엔 탐색기 ↔ 터미널 포커스 전환) */
function toggleExplorerView(group) {
  if (group.explorerPinned) {
    if (!group.explorer) return;
    const l = activeLeaf();
    const focusedInDock = document.activeElement && el.dock.contains(document.activeElement);
    if (focusedInDock && l) l.term.focus();
    else group.explorer.focus();
    return;
  }
  if (group.explorerSelected) leaveExplorer(group);
  else selectExplorer(group);
}

/** 터미널 탭으로 돌아가기 */
function leaveExplorer(group) {
  group.explorerSelected = false;
  render();
  const l = activeLeaf();
  if (l) l.term.focus();
}

/** 왼쪽 고정 패널(dock) 표시 갱신 */
function renderDock() {
  const group = activeGroup();
  const pinned = Boolean(group && group.explorerPinned && group.explorer);

  el.dock.classList.toggle('hidden', !pinned);
  el.dockDivider.classList.toggle('hidden', !pinned);
  if (!pinned) return;

  el.dock.style.width = `${dockWidth}px`;
  if (group.explorer.el.parentElement !== el.dock) el.dock.appendChild(group.explorer.el);
  group.explorer.el.classList.remove('hidden');
}

// 고정 패널 폭 조절
el.dockDivider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = dockWidth;
  document.body.classList.add('resizing-col');
  const shield = document.createElement('div'); // webview 가 이벤트를 삼키지 않도록 덮개
  shield.className = 'drag-shield col';
  document.body.appendChild(shield);
  const onMove = (ev) => {
    dockWidth = Math.max(200, Math.min(window.innerWidth - 320, startW + (ev.clientX - startX)));
    el.dock.style.width = `${dockWidth}px`;
  };
  const onUp = () => {
    shield.removeEventListener('mousemove', onMove);
    shield.removeEventListener('mouseup', onUp);
    window.removeEventListener('mouseup', onUp);
    shield.remove();
    document.body.classList.remove('resizing-col');
    localStorage.setItem(DOCK_KEY, String(dockWidth));
    fitTab(activeTab());
    saveSession();
  };
  shield.addEventListener('mousemove', onMove);
  shield.addEventListener('mouseup', onUp);
  window.addEventListener('mouseup', onUp);
});

function buildNode(tab, node) {
  if (node.kind === 'leaf') return node.el;

  const box = document.createElement('div');
  box.className = `split split-${node.dir}`;

  const a = buildNode(tab, node.children[0]);
  const b = buildNode(tab, node.children[1]);
  a.style.flex = `${node.sizes[0]} 1 0`;
  b.style.flex = `${node.sizes[1]} 1 0`;

  const divider = document.createElement('div');
  divider.className = `divider divider-${node.dir}`;
  divider.addEventListener('mousedown', (e) => startDividerDrag(e, tab, node, box, a, b));

  box.append(a, divider, b);
  return box;
}

/** 분할선 드래그로 비율 조절 */
function startDividerDrag(e, tab, node, box, a, b) {
  e.preventDefault();
  const horizontal = node.dir === 'row'; // 좌우 분할이면 x축으로 움직인다
  const rect = box.getBoundingClientRect();
  const total = horizontal ? rect.width : rect.height;
  document.body.classList.add(horizontal ? 'resizing-col' : 'resizing-row');

  // 드래그 동안 전체 화면을 투명 덮개로 덮는다.
  // 안 그러면 마우스가 웹 판(<webview>) 위로 올라갈 때 webview 가 이벤트를 삼켜서
  // mousemove 가 끊기고 크기 조절이 멈춘다.
  const shield = document.createElement('div');
  shield.className = 'drag-shield ' + (horizontal ? 'col' : 'row');
  document.body.appendChild(shield);

  const onMove = (ev) => {
    const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
    let ratio = pos / total;
    ratio = Math.max(0.1, Math.min(0.9, ratio)); // 너무 작아지지 않게 제한
    node.sizes = [ratio, 1 - ratio];
    a.style.flex = `${node.sizes[0]} 1 0`;
    b.style.flex = `${node.sizes[1]} 1 0`;
  };
  const onUp = () => {
    shield.removeEventListener('mousemove', onMove);
    shield.removeEventListener('mouseup', onUp);
    window.removeEventListener('mouseup', onUp);
    shield.remove();
    document.body.classList.remove('resizing-col', 'resizing-row');
    fitTab(tab);
    saveSession();
  };
  // 덮개 위에서 이벤트를 받으므로 webview 로 새지 않는다
  shield.addEventListener('mousemove', onMove);
  shield.addEventListener('mouseup', onUp);
  window.addEventListener('mouseup', onUp); // 혹시 덮개 밖에서 떼는 경우 대비
}

/* ---------------------------------- 탭 활성화 --------------------------------- */

function selectGroup(groupId) {
  if (state.activeGroupId === groupId && !state.notesOpen) return;
  state.notesOpen = false;
  state.activeGroupId = groupId;
  const t = activeTab();
  if (t) clearAlertsInTab(t); // 열어서 확인했으므로 알림 해제
  render();
  fitTab(t);
  const l = activeLeaf();
  if (l) l.term.focus();
}

function selectTab(group, tabId) {
  state.notesOpen = false;
  group.activeTabId = tabId;
  group.explorerSelected = false; // 터미널 탭을 골랐으므로 전체화면 탐색기는 해제
  state.activeGroupId = group.id;
  const t = activeTab();
  if (t) clearAlertsInTab(t);
  render();
  fitTab(t);
  const l = activeLeaf();
  if (l) l.term.focus();
}

/** Ctrl+Shift+숫자 : n번째 메인탭 */
function selectGroupByIndex(i) {
  const g = state.groups[i];
  if (!g) return;
  state.notesOpen = false;
  g.explorerSelected = false; // 탭 이동 단축키를 쓰면 폴더뷰는 닫고 터미널로
  selectGroup(g.id);
}

/** Ctrl+숫자 : 현재 그룹의 n번째 서브탭 */
function selectTabByIndex(i) {
  const g = activeGroup();
  if (!g) return;
  const t = g.tabs[i];
  if (!t) return;
  state.notesOpen = false;
  g.explorerSelected = false;
  selectTab(g, t.id);
}

/* --------------------------------- 앱 메뉴 줄 -------------------------------- */

/*
 * 제목 줄을 없애고 메뉴를 앱이 직접 그린다.
 * (윈도우/리눅스는 최소화·최대화·닫기만 OS 오버레이로 남는다)
 */
const menuButtons = document.getElementById('menu-buttons');
const menuDropdown = document.getElementById('menu-dropdown');

const MOD = api.platform === 'darwin' ? '⌘' : 'Ctrl';
const APP_MENUS = [
  {
    label: '탭',
    items: [
      ['새 SSH 탭', `${MOD}+N`, () => openConnectDialog({})],
      ['웹페이지 열기', '', () => openConnectDialog({ mode: 'web' })],
      ['현재 그룹에 서브탭 추가', `${MOD}+T`, () => {
        const g = activeGroup();
        if (g) addSubTab(g);
        else openConnectDialog({});
      }],
      ['-'],
      ['좌우로 분할', api.platform === 'darwin' ? '⌘D' : 'Ctrl+Shift+D', () => splitActive('row')],
      ['위아래로 분할', api.platform === 'darwin' ? '⌘⇧D' : 'Ctrl+Shift+E', () => splitActive('col')],
      ['-'],
      ['현재 창 닫기', `${MOD}+W`, () => {
        const l = activeLeaf();
        if (l) closeLeaf(l);
      }]
    ]
  },
  {
    label: '편집',
    items: [
      ['복사', api.platform === 'darwin' ? '⌘C' : 'Ctrl+C', () => {
        const l = activeLeaf();
        if (l && l.term.hasSelection()) api.util.clipboardWrite(l.term.getSelection());
      }],
      ['붙여넣기', api.platform === 'darwin' ? '⌘V' : 'Ctrl+V', async () => {
        const l = activeLeaf();
        if (!l || l.status !== 'ready') return;
        const text = await api.util.clipboardRead();
        if (text) api.ssh.write(l.sessionId, text);
      }],
      ['-'],
      ['찾기', `${MOD}+F`, () => openFind()]
    ]
  },
  {
    label: '보기',
    items: [
      ['파일 탐색기', isMacPlatform ? '⌘`' : 'Ctrl+`', () => {
        const g = activeGroup();
        if (g) toggleExplorerView(g);
      }],
      ['메모장', isMacPlatform ? '⌘⌃`' : 'Ctrl+Alt+`', () => toggleNotes()],
      ['-'],
      ['글자 크게', `${MOD}+ +`, () => setFontSize(state.fontSize + 1)],
      ['글자 작게', `${MOD}+ -`, () => setFontSize(state.fontSize - 1)],
      ['글자 크기 초기화', `${MOD}+0`, () => setFontSize(13)],
      ['-'],
      ['전체 화면', 'F11', () => api.win.toggleFullScreen()],
      ['개발자 도구', '', () => api.win.toggleDevTools()]
    ]
  },
  {
    label: '정보',
    items: [
      ['버전', '', () => openAbout()],
      ['업데이트', '', () => openUpdate()]
    ]
  },
  {
    label: '도움',
    items: [
      ['tmux 사용법', '', () => openHelp('tmux')],
      ['단축키 모음', '', () => openHelp('shortcuts')]
    ]
  }
];

// 보여 줄 순서: 정보 · 탭 · 편집 · 보기 · 도움
const MENU_ORDER = ['정보', '탭', '편집', '보기', '도움'];
APP_MENUS.sort((a, b) => MENU_ORDER.indexOf(a.label) - MENU_ORDER.indexOf(b.label));

let openMenuIndex = -1;

function renderMenuBar() {
  menuButtons.innerHTML = '';
  if (isMacPlatform) return; // mac 은 시스템 메뉴 막대를 쓴다
  APP_MENUS.forEach((menu, i) => {
    const b = document.createElement('button');
    b.className = 'menu-btn';
    b.textContent = menu.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAppMenu(i === openMenuIndex ? -1 : i, b);
    });
    // 메뉴가 열려 있을 때는 마우스만 올려도 그 메뉴로 바뀐다 (일반 메뉴 막대처럼)
    b.addEventListener('mouseenter', () => {
      if (openMenuIndex >= 0 && openMenuIndex !== i) toggleAppMenu(i, b);
    });
    menuButtons.appendChild(b);
  });
}

function toggleAppMenu(index, button) {
  openMenuIndex = index;
  for (const [i, b] of [...menuButtons.children].entries()) b.classList.toggle('active', i === index);

  if (index < 0) {
    menuDropdown.classList.add('hidden');
    return;
  }

  menuDropdown.innerHTML = '';
  for (const item of APP_MENUS[index].items) {
    if (item[0] === '-') {
      const hr = document.createElement('div');
      hr.className = 'ex-menu-sep';
      menuDropdown.appendChild(hr);
      continue;
    }
    const [label, accel, fn] = item;
    const b = document.createElement('button');
    const name = document.createElement('span');
    name.textContent = label;
    const key = document.createElement('span');
    key.className = 'menu-accel';
    key.textContent = accel || '';
    b.append(name, key);
    b.addEventListener('click', () => {
      toggleAppMenu(-1);
      fn();
    });
    menuDropdown.appendChild(b);
  }

  const r = button.getBoundingClientRect();
  menuDropdown.classList.remove('hidden');
  menuDropdown.style.left = `${Math.round(r.left)}px`;
  menuDropdown.style.top = `${Math.round(r.bottom + 2)}px`;
  menuDropdown.style.right = 'auto';
}

document.addEventListener('click', () => toggleAppMenu(-1));
window.addEventListener('blur', () => toggleAppMenu(-1));
renderMenuBar();

/* ---------------------------------- 시계 ----------------------------------- */

/*
 * 상단 오른쪽 시계.
 * 한 곳만 보여 주고, 클릭하면 KR / HK / US 중에서 고를 수 있다.
 */
const CLOCK_ZONES = [
  { id: 'KR', label: '🇰🇷 KR', name: '한국', tz: 'Asia/Seoul' },
  { id: 'HK', label: '🇭🇰 HK', name: '홍콩', tz: 'Asia/Hong_Kong' },
  { id: 'US', label: '🇺🇸 US', name: '미국 동부', tz: 'America/New_York' }
];
const CLOCK_KEY = 'clockZone';

let clockZone = CLOCK_ZONES.find((z) => z.id === localStorage.getItem(CLOCK_KEY)) || CLOCK_ZONES[0];
let clockFmt = null;

const clockBtn = document.createElement('button');
clockBtn.className = 'clock-item';
const clockZoneEl = document.createElement('span');
clockZoneEl.className = 'clock-zone';
const clockTimeEl = document.createElement('span');
clockTimeEl.className = 'clock-time';
clockBtn.append(clockZoneEl, clockTimeEl);
el.clock.appendChild(clockBtn);

function setClockZone(zone) {
  clockZone = zone;
  localStorage.setItem(CLOCK_KEY, zone.id);
  clockFmt = new Intl.DateTimeFormat('ko-KR', {
    timeZone: zone.tz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  clockZoneEl.textContent = zone.label;
  clockBtn.title = `${zone.name} (${zone.tz}) · 클릭하면 지역 변경`;
  renderClock();
}

function renderClock() {
  if (!clockFmt) return;
  // "08. 17. 18:05" → "08/17 18:05"
  const text = clockFmt.format(new Date()).replace(/\.\s*/g, '/').replace(/\/\s*(\d{2}:)/, ' $1').replace(/\/$/, '');
  if (clockTimeEl.textContent !== text) clockTimeEl.textContent = text;
}

clockBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const r = clockBtn.getBoundingClientRect();
  showContextMenu(
    Math.max(8, r.right - 150),
    r.bottom + 4,
    CLOCK_ZONES.map((z) => [`${z.label} · ${z.name}${z.id === clockZone.id ? ' ✓' : ''}`, () => setClockZone(z)])
  );
});

setClockZone(clockZone);
setInterval(renderClock, 500); // 분이 바뀌는 순간을 놓치지 않도록

/* --------------------------------- 메모장 ---------------------------------- */

let notesPad = null; // 메모장 인스턴스 (처음 열 때 생성)

function openNotes() {
  if (!notesPad) {
    notesPad = window.Notes.create();
    el.stage.appendChild(notesPad.el);
  }
  state.notesOpen = true;
  notesPad.refresh();
  render();
  notesPad.focus();
}

function closeNotes() {
  state.notesOpen = false;
  render();
  const l = activeLeaf();
  if (l) l.term.focus();
}

function toggleNotes() {
  if (state.notesOpen) closeNotes();
  else openNotes();
}

/* ----------------------------- 세션(탭 배치) 저장/복원 ---------------------------- */

/*
 * 앱을 끌 때의 탭 구성을 저장해 두었다가 다시 켤 때 그대로 되살린다.
 * 저장하는 것: 메인탭(호스트)·서브탭 순서, 서브탭 이름, 분할 구조와 비율,
 *              활성 탭, 탐색기 고정 여부, 고정 패널 폭.
 * 비밀번호 같은 접속 정보는 저장하지 않고, 저장된 호스트(hostId)로만 자동 재접속한다.
 */

function serializeNode(node) {
  if (!node) return null;
  if (node.kind === 'leaf') {
    if (node.mode === 'web') return { kind: 'leaf', mode: 'web', url: node.web ? node.web.url : null };
    // 메모·파일 탐색기 판도 다음 실행 때 그대로 되살린다
    if (node.mode === 'notes' || node.mode === 'explorer') return { kind: 'leaf', mode: node.mode };
    return { kind: 'leaf' };
  }
  return {
    kind: 'split',
    dir: node.dir,
    sizes: node.sizes.slice(),
    children: node.children.map(serializeNode)
  };
}

function sessionSnapshot() {
  return {
    v: 1,
    dockWidth,
    activeGroupIndex: state.groups.findIndex((g) => g.id === state.activeGroupId),
    groups: state.groups.map((g) => ({
      hostId: (g.connect && g.connect.hostId) || g.host.id || null,
      host: {
        name: g.host.name,
        host: g.host.host,
        port: g.host.port,
        username: g.host.username
      },
      explorerPinned: Boolean(g.explorerPinned),
      activeTabIndex: g.tabs.findIndex((t) => t.id === g.activeTabId),
      tabs: g.tabs.map((t) => ({
        customTitle: t.customTitle || null,
        layout: serializeNode(t.root)
      }))
    }))
  };
}

let saveTimer = null;
let lastSnapshotJson = '';
/** 변경이 잦으므로 모아서 저장하고, 내용이 그대로면 건너뛴다 */
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap = sessionSnapshot();
    const json = JSON.stringify(snap);
    if (json === lastSnapshotJson) return;
    lastSnapshotJson = json;
    api.session.save(snap);
  }, 1500);
}

// 창을 닫는 순간에도 마지막 상태를 한 번 더 남긴다
window.addEventListener('beforeunload', () => api.session.save(sessionSnapshot()));

/** 저장된 배치대로 탭을 되살린다 */
async function restoreSession() {
  let snap = null;
  try {
    snap = await api.session.load();
  } catch (e) {
    return;
  }
  if (!snap || !Array.isArray(snap.groups) || snap.groups.length === 0) return;

  if (snap.dockWidth) dockWidth = snap.dockWidth;

  // 한꺼번에 붙지 않도록 접속을 조금씩 나눠서 시작한다
  let order = 0;
  const schedule = (leaf) => {
    const wait = 120 * order++;
    setTimeout(() => startSession(leaf), wait);
  };

  for (const gs of snap.groups) {
   try {
    const group = {
      id: nextId('g'),
      host: { id: gs.hostId || null, ...gs.host },
      credId: null,
      // 저장된 호스트면 그 정보로 자동 접속, 아니면 접속하지 않고 남겨둔다
      connect: gs.hostId ? { hostId: gs.hostId, credId: null } : null,
      tabs: [],
      activeTabId: null,
      explorer: null,
      explorerPinned: Boolean(gs.explorerPinned),
      explorerSelected: false
    };
    state.groups.push(group);
    state.activeGroupId = group.id;

    for (const ts of gs.tabs || []) {
      const tab = makeTabShell(group);
      tab.customTitle = ts.customTitle || null;
      tab.root = rebuildLayout(tab, group, ts.layout, schedule);
      const first = firstLeaf(tab.root);
      tab.activeLeafId = first ? first.id : null;
      layoutTab(tab);
    }
    const at = group.tabs[gs.activeTabIndex];
    if (at) group.activeTabId = at.id;

    // 왼쪽 고정 상태였다면 탐색기 인스턴스를 미리 만들어 패널을 되살린다
    if (group.explorerPinned && group.connect) ensureExplorer(group);
   } catch (err) {
     console.error('세션 복원 실패:', err && err.stack ? err.stack : err);
   }
  }

  const ag = state.groups[snap.activeGroupIndex] || state.groups[0];
  if (ag) state.activeGroupId = ag.id;
  render();
  fitTab(activeTab());
  const l = activeLeaf();
  if (l) l.term.focus();
}

/** 저장된 분할 구조를 실제 페인 트리로 되살린다 */
function rebuildLayout(tab, group, node, schedule) {
  if (!node || node.kind === 'leaf') {
    const connect = group.connect;
    const leaf = createLeaf(tab, connect || {}, { mode: connect ? 'later' : 'orphan' });
    if (node && node.mode === 'web') {
      setLeafMode(leaf, 'web', node.url); // 웹 판으로 복원
    } else if (node && (node.mode === 'notes' || node.mode === 'explorer')) {
      // 셸도 함께 살려 두고(터미널로 돌아갈 수 있게) 화면만 메모/파일로 맞춘다
      if (connect) schedule(leaf);
      setTimeout(() => setLeafMode(leaf, node.mode), 500);
    } else if (connect) {
      schedule(leaf);
    }
    return leaf;
  }
  return {
    kind: 'split',
    id: nextId('s'),
    dir: node.dir === 'col' ? 'col' : 'row',
    sizes: Array.isArray(node.sizes) && node.sizes.length === 2 ? node.sizes : [0.5, 0.5],
    children: (node.children || []).map((c) => rebuildLayout(tab, group, c, schedule))
  };
}

/* --------------------------- Claude 계정 / 사용량 표시 --------------------------- */

/*
 * 접속한 서버에 Claude Code 가 로그인되어 있으면 하단바에 계정과 사용량을 보여준다.
 * 조회는 그 서버에서 실행되고(토큰은 서버 밖으로 나가지 않는다) 결과만 받아온다.
 */

/*
 * 사용량 조회 주기.
 * 평소에는 1분마다 갱신해 값을 최신으로 유지한다.
 * 다만 Anthropic 사용량 API 는 호출이 잦으면 rate_limit 을 돌려주므로,
 * 제한에 걸리면 10분을 쉬었다가 다시 부른다(쉬는 동안 부르면 제한만 갱신된다).
 */
const CLAUDE_POLL_MS = 60000; // 1분마다 갱신
const CLAUDE_BACKOFF_MS = 600000; // 제한에 걸리면 10분 뒤에 다시 호출
const CLAUDE_FORCE_FLOOR_MS = 15000; // 새로고침을 눌러도 15초 안에는 다시 안 부른다
let claudePollTimer = null;
/*
 * 제한은 "계정" 단위로 걸리므로 그룹마다 따로 세면 소용이 없다.
 * (탭을 여러 개 열면 각 그룹이 번갈아 호출해 제한을 계속 갱신한다)
 * 그래서 대기 시각과 마지막 호출 시각은 앱 전체에서 하나로 공유한다.
 */
const claudeGate = { backoffUntil: 0, lastCallAt: 0 };

/** 그룹의 살아 있는 세션 하나를 고른다 (조회용 exec 채널을 열 연결) */
function anyReadySession(group) {
  for (const t of group.tabs) {
    for (const l of leavesOf(t.root)) {
      if (l.sessionId && l.status === 'ready') return l.sessionId;
    }
  }
  return null;
}

async function refreshClaudeInfo(group, force) {
  if (!group) return;
  const sessionId = anyReadySession(group);
  if (!sessionId) return;
  const now = Date.now();
  // 제한 대기 중에는 새로고침(force)이라도 부르지 않는다. 부르면 제한만 계속 갱신된다.
  if (claudeGate.backoffUntil && now < claudeGate.backoffUntil) return;
  if (now - claudeGate.lastCallAt < CLAUDE_FORCE_FLOOR_MS) return; // 연타/동시 접속 방지
  if (!force && group.claudeFetchedAt && now - group.claudeFetchedAt < CLAUDE_POLL_MS) return;
  if (group.claudeFetching) return;

  group.claudeFetching = true;
  claudeGate.lastCallAt = now;
  try {
    const info = await api.claude.info(sessionId);
    // 사용량 조회가 한 번 실패해도 화면이 깜빡이지 않도록 직전 값을 유지한다
    const prev = group.claudeInfo;
    if (info && info.loggedIn && !info.session && prev && prev.session) {
      info.session = prev.session;
      info.week = prev.week;
      info.stale = true;
      info.staleAt = prev.staleAt || group.claudeFetchedAt || Date.now();
    }
    // 제한(또는 그 밖의 조회 실패)이면 10분 쉬었다가 다시 부른다. 성공하면 곧바로 해제.
    if (info && (info.rateLimited || info.usageFailed)) {
      claudeGate.backoffUntil = Date.now() + CLAUDE_BACKOFF_MS;
    } else {
      claudeGate.backoffUntil = 0;
    }
    group.claudeInfo = info;
    group.claudeFetchedAt = Date.now();
    if (activeGroup() === group) renderClaudeStatus();
  } catch (e) {
    // 조회 자체가 실패해도 이미 받아 둔 계정 정보는 지우지 않는다
    if (!group.claudeInfo) group.claudeInfo = { loggedIn: false };
  } finally {
    group.claudeFetching = false;
  }
}

/** 초기화까지 남은 시간을 HH:MM 으로 */
function untilReset(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalMin = Math.floor(ms / 60000);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** 0~100% 짜리 작은 막대 */
function usageBar(label, bucket, showReset) {
  const wrap = document.createElement('span');
  wrap.className = 'usage';

  const name = document.createElement('span');
  name.className = 'usage-label';
  name.textContent = label;

  const track = document.createElement('span');
  track.className = 'usage-track';
  const fill = document.createElement('span');
  fill.className = 'usage-fill';
  const pct = bucket ? bucket.pct : 0;
  fill.style.width = `${pct}%`;
  if (pct >= 90) fill.classList.add('danger');
  else if (pct >= 70) fill.classList.add('warn');
  track.appendChild(fill);

  const num = document.createElement('span');
  num.className = 'usage-pct';
  num.textContent = bucket ? `${pct}%` : '—';

  if (bucket && bucket.resetsAt) {
    const d = new Date(bucket.resetsAt);
    const p = (x) => String(x).padStart(2, '0');
    wrap.title = `${label} 사용량 ${pct}% · ${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())} 에 초기화`;
  }

  wrap.append(name, track, num);

  // 초기화까지 남은 시간
  const left = showReset ? untilReset(bucket && bucket.resetsAt) : null;
  if (left) {
    const reset = document.createElement('span');
    reset.className = 'usage-reset';
    reset.textContent = `↻ ${left}`;
    reset.title = `${label} 사용량이 ${left} 뒤에 초기화됩니다`;
    wrap.appendChild(reset);
  }
  return wrap;
}

function renderClaudeStatus() {
  const group = activeGroup();
  const info = group && group.claudeInfo;
  const box = el.statusClaude;

  if (!info || !info.loggedIn) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = '';
  box.title = '클릭하면 사용량을 지금 새로고침';
  box.onclick = () => {
    const g = activeGroup();
    if (g) refreshClaudeInfo(g, true);
  };

  const who = document.createElement('span');
  who.className = 'claude-who';
  who.textContent = `✳ ${info.email || info.name || 'Claude'}${info.plan ? ` (${info.plan})` : ''}`;
  who.title = `이 서버에 로그인된 Claude Code 계정${info.stale ? ' (사용량은 마지막으로 받아온 값)' : ''}`;
  box.appendChild(who);

  if (info.session || info.week) {
    box.appendChild(usageBar('세션', info.session, true));
    box.appendChild(usageBar('주간', info.week, false));
  } else {
    const note = document.createElement('span');
    note.className = 'usage-label';
    // 언제 다시 시도하는지까지 보여 준다("잠시" 만으로는 기다려야 할지 알 수 없다)
    const waitMin = claudeGate.backoffUntil
      ? Math.max(1, Math.ceil((claudeGate.backoffUntil - Date.now()) / 60000))
      : 0;
    if (info.rateLimited) {
      note.textContent = waitMin ? `사용량 조회 제한 (${waitMin}분 뒤 재시도)` : '사용량 조회 제한됨';
      note.title =
        'Anthropic 사용량 API 가 호출 제한을 걸었습니다.\n' +
        '계정 사용량이 아니라 조회 API 만 막힌 것이라 Claude 사용에는 영향이 없습니다.\n' +
        '대기가 끝나면 자동으로 다시 받아옵니다.';
    } else {
      note.textContent = '사용량 조회 불가';
      note.title = info.usageError
        ? `사용량을 받아오지 못했습니다: ${info.usageError}`
        : '사용량을 받아오지 못했습니다. 서버에서 api.anthropic.com 에 접속되는지 확인해 보세요.';
    }
    box.appendChild(note);
  }
}

/* ------------------------------ 탭 드래그 정렬 ------------------------------- */

/**
 * 탭을 끌어서 순서를 바꾼다. 메인탭 스트립과 서브탭 스트립이 같은 로직을 쓴다.
 * @param {HTMLElement} node  탭 DOM
 * @param {Array}  arr        순서를 바꿀 배열 (state.groups 또는 group.tabs)
 * @param {number} index      이 탭의 현재 위치
 * @param {string} kind       'group' | 'tab' — 다른 스트립으로는 못 끌게 구분용
 * @param {Function} after    정렬이 끝난 뒤 호출
 */
/**
 * 드래그로 순서 바꾸기. 서브탭(kind==='tab')은 가운데에 떨어뜨리면 "합치기"(onMerge)도 지원한다.
 * @param {Function} onMerge (fromIndex,toIndex) => void  (서브탭에서만 사용)
 */
function makeReorderable(node, arr, index, kind, after, onMerge) {
  node.draggable = true;
  const canMerge = kind === 'tab' && typeof onMerge === 'function';

  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(`armux/${kind}`, String(index));
    e.dataTransfer.setData('text/plain', String(index)); // 일부 환경에서 이게 없으면 드래그가 시작되지 않는다
    node.classList.add('dragging');
  });

  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    clearDropMarks(node.parentElement);
  });

  // 가운데 40% 구역이면 합치기, 양 끝이면 순서 바꾸기
  const zoneOf = (e) => {
    const r = node.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (canMerge && x > 0.3 && x < 0.7) return 'merge';
    return x > 0.5 ? 'after' : 'before';
  };

  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(`armux/${kind}`)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const z = zoneOf(e);
    node.classList.toggle('drop-before', z === 'before');
    node.classList.toggle('drop-after', z === 'after');
    node.classList.toggle('drop-merge', z === 'merge');
  });

  node.addEventListener('dragleave', () => {
    node.classList.remove('drop-before', 'drop-after', 'drop-merge');
  });

  node.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData(`armux/${kind}`);
    if (raw === '') return;
    e.preventDefault();
    e.stopPropagation();
    const from = Number(raw);
    const z = zoneOf(e);
    clearDropMarks(node.parentElement);
    if (Number.isNaN(from)) return;

    if (z === 'merge') {
      if (from !== index) onMerge(from, index); // 다른 서브탭을 이 서브탭 안으로 합친다
      return;
    }
    let to = index + (z === 'after' ? 1 : 0);
    if (from === to || from + 1 === to) return;
    if (from < to) to -= 1; // 앞에서 빼면 뒤 인덱스가 하나 당겨진다
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    after();
  });
}

/**
 * 서브탭 합치기: 소스 서브탭의 판들을 대상 서브탭 안으로 넣는다(좌우 분할로 결합).
 * 세션은 그대로 살아 있고 위치만 옮겨진다.
 */
function mergeSubTabs(group, fromIndex, toIndex) {
  const src = group.tabs[fromIndex];
  const dst = group.tabs[toIndex];
  if (!src || !dst || src === dst) return;

  // 대상 트리와 소스 트리를 좌우 분할로 묶는다
  dst.root = { kind: 'split', id: nextId('s'), dir: 'row', sizes: [0.5, 0.5], children: [dst.root, src.root] };

  // 소스의 모든 판을 대상 탭 소속으로 바꾸고 DOM 도 대상으로 옮긴다(layoutTab 이 leaf.el 을 재배치)
  for (const leaf of leavesOf(src.root)) leaf.tabId = dst.id;

  // 소스 탭 껍데기 제거 (판은 살려둔다 — dispose 하지 않음)
  const idx = group.tabs.indexOf(src);
  group.tabs.splice(idx, 1);
  src.container.remove();
  if (src.explorer) {
    /* 서브탭엔 탐색기 인스턴스가 없다 */
  }

  group.activeTabId = dst.id;
  layoutTab(dst);
  render();
  fitTab(dst);
  saveSession();
}

function clearDropMarks(container) {
  if (!container) return;
  for (const n of container.children) n.classList.remove('drop-before', 'drop-after');
}

/* ---------------------------------- 렌더링 ---------------------------------- */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  renderTabstrip();
  renderSubstrip();
  renderPanes();
  renderStatus();
  renderClaudeStatus();
  el.emptyState.classList.toggle('hidden', state.groups.length > 0);
  saveSession();
}

/** 초록 느낌표 배지 */
function alertBadge() {
  const b = document.createElement('span');
  b.className = 'alert-badge';
  b.textContent = '!';
  b.title = '응답을 기다리는 중입니다';
  return b;
}

function statusDot(status) {
  const dot = document.createElement('span');
  dot.className = 'dot ' + status;
  return dot;
}

/** Claude 가 생각하는 중임을 알리는 원형 스피너 */
function spinner() {
  const el2 = document.createElement('span');
  el2.className = 'spin-busy';
  el2.title = 'Claude 가 생각하는 중';
  return el2;
}

/**
 * 탭 앞에 붙는 표시 하나를 고른다.
 * 우선순위: 초록 느낌표(응답 대기) > Claude 작업 중 > 명령 실행 중 > 연결 상태 점
 */
function statusMark(status, spin, alerted) {
  if (alerted) return alertBadge();
  if (spin) return spinner();
  return statusDot(status);
}

/** 탭(서브탭) 전체 상태: 하나라도 connecting 이면 connecting, 전부 closed 면 closed … */
function tabStatus(tab) {
  const sts = leavesOf(tab.root).map((l) => l.status);
  if (sts.includes('connecting')) return 'connecting';
  if (sts.includes('ready')) return 'ready';
  if (sts.includes('error')) return 'error';
  return 'closed';
}

function renderTabstrip() {
  el.tabstrip.innerHTML = '';

  state.groups.forEach((group, gi) => {
    const active = group.id === state.activeGroupId;
    const cur = group.tabs.find((t) => t.id === group.activeTabId) || group.tabs[0];

    const node = document.createElement('div');
    node.className = 'tab' + (active ? ' active' : '');
    node.title =
      `${group.host.name} — ${group.host.username}@${group.host.host}:${group.host.port}\n` +
      `${gi < 9 ? `${api.platform === 'darwin' ? '⌘⌃' : 'Ctrl+Alt+'}${gi + 1} 로 이동 · ` : ''}끌어서 순서 변경 · 가운데 클릭: 닫기\n` +
      `탭 아래 + : 서브탭 추가 (Ctrl/⌘+T)`;

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = gi < 9 ? `${MAIN_TAB_MOD}${gi + 1}` : '';

    const label = document.createElement('span');
    label.className = 'label';
    const paneCount = group.tabs.reduce((n, t) => n + leavesOf(t.root).length, 0);
    label.textContent = group.host.name + (paneCount > 1 ? ` (${paneCount})` : '');

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmCloseGroup(group);
    });

    // 서브탭 중 하나라도 응답 대기면 메인탭도 초록 느낌표
    node.append(statusMark(cur ? tabStatus(cur) : 'closed', groupSpin(group), groupHasAlert(group)), idx, label);
    node.appendChild(close);

    // 끌어서 메인탭 순서 바꾸기
    makeReorderable(node, state.groups, gi, 'group', () => {
      render();
      fitTab(activeTab());
    });

    node.addEventListener('click', () => selectGroup(group.id));
    node.addEventListener('auxclick', (e) => {
      if (e.button === 1) confirmCloseGroup(group);
    });
    el.tabstrip.appendChild(node);
  });

  // 새 탭(+) 버튼은 마지막 탭 바로 오른쪽에 붙인다
  el.tabstrip.appendChild(el.newGroupBtn);
}

function renderSubstrip() {
  const group = activeGroup();
  el.substrip.innerHTML = '';
  if (!group) {
    el.substrip.classList.add('hidden');
    return;
  }
  el.substrip.classList.remove('hidden');

  // 맨 왼쪽: 항상 존재하는 "파일 탐색기" 서브탭 (📌 로 왼쪽 고정 전환)
  const exTab = document.createElement('div');
  exTab.className =
    'subtab subtab-explorer' +
    (group.explorerSelected && !group.explorerPinned ? ' active' : '') +
    (group.explorerPinned ? ' pinned' : '');
  exTab.title =
    (group.explorerPinned
      ? '왼쪽에 고정된 파일 탐색기 (📌 를 눌러 고정 해제)'
      : '파일 탐색기 (SFTP) · 📌 를 누르면 왼쪽에 고정') +
    `\n${api.platform === 'darwin' ? '⌘' : 'Ctrl'}+\` 로 켜고 끄기`;

  const exIcon = document.createElement('span');
  exIcon.className = 'label';
  exIcon.textContent = '📁 파일';

  const pin = document.createElement('span');
  pin.className = 'pin' + (group.explorerPinned ? ' on' : '');
  pin.textContent = '📌';
  pin.title = group.explorerPinned ? '왼쪽 고정 해제' : '왼쪽에 고정';
  pin.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExplorerPin(group);
  });

  exTab.append(exIcon, pin);
  exTab.addEventListener('click', () => {
    if (group.explorerPinned) selectExplorer(group);
    else if (group.explorerSelected) leaveExplorer(group); // 다시 누르면 터미널로
    else selectExplorer(group);
  });
  exTab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      [group.explorerPinned ? '왼쪽 고정 해제' : '왼쪽에 고정', () => toggleExplorerPin(group)],
      ['새로고침', () => group.explorer && group.explorer.refresh()]
    ]);
  });
  el.substrip.appendChild(exTab);

  group.tabs.forEach((tab, ti) => {
    const node = document.createElement('div');
    node.className = 'subtab' + (tab.id === group.activeTabId ? ' active' : '');
    node.title =
      `${tabTitle(group, tab)}\n` +
      `${ti < 9 ? `${api.platform === 'darwin' ? '⌘' : 'Ctrl+'}${ti + 1} 로 이동 · ` : ''}우클릭: 이름 변경 · 끌어서 순서 변경\n` +
      `분할: ${api.platform === 'darwin' ? '⌘D / ⌘⇧D' : 'Ctrl+Shift+D / Ctrl+Shift+E'} · 닫기: Ctrl/⌘+W`;

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = ti < 9 ? `${ti + 1}` : '';

    const label = document.createElement('span');
    label.className = 'label';
    const leaves = leavesOf(tab.root);
    label.textContent = tabTitle(group, tab);
    if (leaves.length > 1) label.textContent += ` ⧉${leaves.length}`; // 분할 개수

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmCloseTab(group, tab);
    });

    node.append(statusMark(tabStatus(tab), tabSpin(tab), tabHasAlert(tab)), idx, label);
    node.appendChild(close);

    // 끌어서 서브탭 순서 바꾸기
    makeReorderable(
      node,
      group.tabs,
      ti,
      'tab',
      () => {
        render();
        fitTab(activeTab());
      },
      (from, to) => mergeSubTabs(group, from, to) // 가운데로 드롭하면 합치기
    );

    node.addEventListener('click', () => selectTab(group, tab.id));
    node.addEventListener('auxclick', (e) => {
      if (e.button === 1) confirmCloseTab(group, tab);
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectTab(group, tab.id);
      // render() 로 노드가 새로 그려지므로 같은 위치의 탭 노드를 다시 찾아서 넘긴다
      const fresh = el.substrip.querySelectorAll('.subtab')[ti];
      showContextMenu(e.clientX, e.clientY, [
        ['이름 변경', () => startRenameTab(group, tab, fresh || node)],
        ['기본 이름으로 되돌리기', () => {
          tab.customTitle = null;
          render();
        }],
        ['-'],
        ['서브탭 추가', () => addSubTab(group)],
        ['서브탭 닫기', () => confirmCloseTab(group, tab), 'danger']
      ]);
    });
    el.substrip.appendChild(node);
  });

  const add = document.createElement('button');
  add.className = 'subtab-add';
  add.textContent = '+';
  add.title = '서브탭 추가 (Ctrl/⌘+T)';
  add.addEventListener('click', () => addSubTab(group));
  el.substrip.appendChild(add);
}

function renderPanes() {
  const curTab = activeTab();
  const curLeaf = activeLeaf();
  const curGroup = activeGroup();

  // 메모장 / 전체화면 탐색기를 볼 때는 터미널 탭을 감춘다
  if (notesPad) notesPad.el.classList.toggle('hidden', !state.notesOpen);
  el.notesTab.classList.toggle('active', Boolean(state.notesOpen));
  const exFull =
    !state.notesOpen && Boolean(curGroup && curGroup.explorerSelected && !curGroup.explorerPinned && curGroup.explorer);
  for (const g of state.groups) {
    if (!g.explorer) continue;
    const showFull = g === curGroup && exFull;
    if (showFull) {
      if (g.explorer.el.parentElement !== el.stage) el.stage.appendChild(g.explorer.el);
      g.explorer.el.classList.remove('hidden');
    } else if (!(g === curGroup && g.explorerPinned)) {
      g.explorer.el.classList.add('hidden');
    }
  }
  if (state.notesOpen) {
    el.dock.classList.add('hidden');
    el.dockDivider.classList.add('hidden');
  } else {
    renderDock();
  }

  for (const g of state.groups) {
    for (const t of g.tabs) {
      const on = curTab && t.id === curTab.id && !exFull && !state.notesOpen;
      t.container.classList.toggle('active', Boolean(on));
      for (const l of leavesOf(t.root)) {
        const isActive = Boolean(curLeaf && l.id === curLeaf.id);
        l.el.classList.toggle('focused', isActive);
        // 분할이 하나뿐이면 포커스 테두리를 굳이 그리지 않는다
        l.el.classList.toggle('solo', leavesOf(t.root).length === 1);
        applyPaneBody(l);
        renderPaneHeader(l);
      }
    }
  }
}

/**
 * 판 위쪽 얇은 헤더 한 줄.
 * 왼쪽은 잡아끌 수 있는 손잡이 + 이름, 오른쪽은 도구 버튼들.
 * 헤더를 다른 판 위로 끌어다 놓으면 두 판의 자리가 바뀐다.
 */
/**
 * 판 헤더 버튼 아이콘.
 * 선 두께를 굵게 잡아 22px 버튼 안에서도 형태가 또렷하게 보이도록 했다.
 *   popout  — 상자에서 화살표가 밖으로 (새 서브탭으로 꺼내기)
 *   split-v — 상자를 세로선으로 나눠 오른쪽을 채움 (좌우 분할)
 *   split-h — 상자를 가로선으로 나눠 아래쪽을 채움 (위아래 분할)
 *   swap    — 서로 반대 방향 화살표 (다른 화면으로 전환)
 *   close   — X
 */
function paneIcon(name) {
  const open =
    '<svg class="pt-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">';
  const box = '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4"/>';
  const paths = {
    popout:
      '<path d="M12.5 8.6V12a1.6 1.6 0 0 1-1.6 1.6H4A1.6 1.6 0 0 1 2.4 12V5.1A1.6 1.6 0 0 1 4 3.5h3.4"/>' +
      '<path d="M10 2.6h3.6v3.6"/><path d="M13.6 2.6 8.6 7.6"/>',
    'split-v':
      box + '<rect x="8" y="3.2" width="5.8" height="9.6" rx="1.4" fill="currentColor" opacity=".3" stroke="none"/>' +
      '<path d="M8 3.2v9.6"/>',
    'split-h':
      box + '<rect x="2.2" y="8" width="11.6" height="4.8" rx="1.4" fill="currentColor" opacity=".3" stroke="none"/>' +
      '<path d="M2.2 8h11.6"/>',
    swap: '<path d="M2.6 5.6h9.2"/><path d="M9.6 3.2l2.4 2.4-2.4 2.4"/>' +
      '<path d="M13.4 10.4H4.2"/><path d="M6.4 8l-2.4 2.4L6.4 12.8"/>',
    close: '<path d="M4.2 4.2l7.6 7.6"/><path d="M11.8 4.2l-7.6 7.6"/>'
  };
  return open + (paths[name] || '') + '</svg>';
}

/**
 * 판 헤더의 "⇄ 전환" 드롭다운.
 * 이 판 하나만 웹페이지 · 메모 · 파일 탐색기로 바꾼다.
 * 터미널은 없애지 않고 감춰 두므로 돌아오면 SSH 세션이 그대로 살아 있다.
 */
function openPaneModeMenu(leaf, ev) {
  focusLeaf(leaf);
  const items = [];
  // 터미널이 아닐 때만 "터미널로 돌아가기" 를 맨 위에 둔다
  if (leaf.mode !== 'terminal') {
    items.push(['⌨  터미널', () => setLeafMode(leaf, 'terminal')]);
    items.push(['-']);
  }
  const row = (label, mode) => [
    `${leaf.mode === mode ? '✓ ' : '\u2003'}${label}`,
    () => {
      if (leaf.mode !== mode) setLeafMode(leaf, mode);
    }
  ];
  items.push(row('🌐  웹페이지', 'web'));
  items.push(row('📝  메모', 'notes'));
  items.push(row('📁  파일', 'explorer'));

  // 버튼 바로 아래에 펼친다
  const r = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
  if (r) showContextMenu(r.left, r.bottom + 2, items);
  else showContextMenu(ev ? ev.clientX : 0, ev ? ev.clientY : 0, items);
}

function renderPaneHeader(leaf) {
  const header = leaf.el.querySelector('.pane-header');
  if (!header) return;
  header.innerHTML = '';

  /* --- 왼쪽: 손잡이 · 상태 · 이름 --- */
  const grip = document.createElement('span');
  grip.className = 'pane-grip';
  grip.textContent = '⠿';
  grip.title = '끌어서 다른 판과 자리 바꾸기';

  const mark = statusMark(leaf.status, leaf.spin, leaf.alert);
  mark.classList.add('pane-mark');

  const title = document.createElement('span');
  title.className = 'pane-title';
  const group = state.groups.find((g) => g.id === leaf.groupId);
  title.textContent =
    leaf.mode === 'web'
      ? (leaf.web && leaf.web.title) || '웹페이지'
      : leaf.mode === 'notes'
        ? '메모'
        : leaf.mode === 'explorer'
          ? `파일 — ${group ? group.host.name : ''}`
          : leaf.title || (group ? group.host.name : '');
  title.title = title.textContent;

  header.append(grip, mark, title);

  /* --- 오른쪽: 도구 --- */
  const tools = document.createElement('span');
  tools.className = 'pane-tools';

  // 아이콘 + 글자를 함께 넣는다. 유니코드 글리프는 폰트마다 모양이 제각각이고
  // 작아서 구분이 안 되므로, 무엇을 하는 버튼인지 그림으로 알 수 있게 SVG 를 쓴다.
  const mk = (iconName, label, tip, fn, cls) => {
    const b = document.createElement('button');
    b.innerHTML = paneIcon(iconName);
    if (label) {
      const t = document.createElement('span');
      t.className = 'pt-label';
      t.textContent = label;
      b.appendChild(t);
    }
    b.title = tip;
    b.setAttribute('aria-label', tip);
    if (cls) b.className = cls;
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn(e);
    });
    return b;
  };

  tools.append(
    mk('popout', '', '이 판을 새 서브탭으로 열기', () => popOutLeaf(leaf)),
    mk('split-v', '', `좌우로 분할 (${isMacPlatform ? '⌘D' : 'Ctrl+Shift+D'})`, () => {
      focusLeaf(leaf);
      splitActive('row');
    }),
    mk('split-h', '', `위아래로 분할 (${isMacPlatform ? '⌘⇧D' : 'Ctrl+Shift+E'})`, () => {
      focusLeaf(leaf);
      splitActive('col');
    }),
    mk('swap', '전환', '이 판을 웹페이지 · 메모 · 파일로 전환', (ev) => openPaneModeMenu(leaf, ev), 'wide'),
    mk('close', '', `이 판 닫기 (${isMacPlatform ? '⌘W' : 'Ctrl+W'})`, () => closeLeaf(leaf), 'danger')
  );
  header.appendChild(tools);

  bindPaneDrag(leaf, header);
}

/* ------------------------------ 판 자리 바꾸기 ------------------------------ */

/** 트리에서 노드의 부모와 위치를 찾는다 */
function locateNode(node, target, parent = null, index = -1) {
  if (node === target) return { parent, index };
  if (node && node.kind === 'split') {
    for (let i = 0; i < node.children.length; i++) {
      const found = locateNode(node.children[i], target, node, i);
      if (found) return found;
    }
  }
  return null;
}

/** 같은 탭 안에서 두 판의 자리를 맞바꾼다 */
function swapLeaves(a, b) {
  if (!a || !b || a === b || a.tabId !== b.tabId) return;
  const group = state.groups.find((g) => g.id === a.groupId);
  const tab = group && group.tabs.find((t) => t.id === a.tabId);
  if (!tab) return;

  const la = locateNode(tab.root, a);
  const lb = locateNode(tab.root, b);
  if (!la || !lb) return;

  if (la.parent) la.parent.children[la.index] = b;
  else tab.root = b;
  if (lb.parent) lb.parent.children[lb.index] = a;
  else tab.root = a;

  layoutTab(tab);
  render();
  focusLeaf(a);
  saveSession();
}

let draggingLeafId = null;

/** 헤더를 끌어 다른 판과 자리를 바꾸는 동작 */
function bindPaneDrag(leaf, header) {
  header.draggable = true;

  header.addEventListener('dragstart', (e) => {
    draggingLeafId = leaf.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('armux/pane', leaf.id);
    e.dataTransfer.setData('text/plain', leaf.id);
    leaf.el.classList.add('pane-dragging');
  });

  header.addEventListener('dragend', () => {
    draggingLeafId = null;
    leaf.el.classList.remove('pane-dragging');
    for (const el2 of document.querySelectorAll('.pane.drop-target')) el2.classList.remove('drop-target');
  });

  // 이 판 전체가 드롭 대상이 된다
  const pane = leaf.el;
  if (pane.dataset.dropBound) return;
  pane.dataset.dropBound = '1';

  pane.addEventListener('dragover', (e) => {
    if (!draggingLeafId || draggingLeafId === leaf.id) return;
    if (!e.dataTransfer.types.includes('armux/pane')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    pane.classList.add('drop-target');
  });
  pane.addEventListener('dragleave', () => pane.classList.remove('drop-target'));
  pane.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes('armux/pane')) return;
    e.preventDefault();
    e.stopPropagation();
    pane.classList.remove('drop-target');
    const srcId = e.dataTransfer.getData('armux/pane');
    const tab = (state.groups.find((g) => g.id === leaf.groupId) || { tabs: [] }).tabs.find(
      (t) => t.id === leaf.tabId
    );
    const src = tab && findLeaf(tab.root, srcId);
    if (src) swapLeaves(src, leaf);
  });
}

function renderStatus() {
  const g = activeGroup();
  const t = activeTab();
  const l = activeLeaf();
  if (!g || !t || !l) {
    el.statusLeft.textContent = '준비됨';
    return;
  }
  const statusText = {
    connecting: '접속 중…',
    ready: '연결됨',
    closed: '연결 종료',
    error: '접속 실패'
  }[l.status];
  el.statusLeft.textContent = `${g.host.username}@${g.host.host}:${g.host.port} · ${statusText}`;
}


/* ------------------------------ 공용 컨텍스트 메뉴 ----------------------------- */

const ctxMenu = document.createElement('div');
ctxMenu.className = 'ex-menu hidden';
document.body.appendChild(ctxMenu);

/** items = [[라벨, 실행함수, 'danger'?] | ['-']] */
function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  for (const item of items) {
    if (item[0] === '-') {
      const hr = document.createElement('div');
      hr.className = 'ex-menu-sep';
      ctxMenu.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = item[0];
    if (item[2]) b.classList.add(item[2]);
    b.addEventListener('click', () => {
      hideContextMenu();
      item[1]();
    });
    ctxMenu.appendChild(b);
  }
  ctxMenu.classList.remove('hidden');
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 8)}px`;
}

function hideContextMenu() {
  ctxMenu.classList.add('hidden');
}
window.showContextMenu = showContextMenu; // 메모장 등 다른 모듈에서도 사용
document.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);

/* ------------------------------ 서브탭 이름 관리 ------------------------------ */

/** 서브탭에 보여줄 이름: 사용자가 정한 이름 > 현재 세션(셸)이 알려준 제목 > 호스트 이름 */
function tabTitle(group, tab) {
  if (tab.customTitle) return tab.customTitle;
  const leaves = leavesOf(tab.root);
  const head = leaves.find((l) => l.id === tab.activeLeafId) || leaves[0];
  return (head && head.title) || group.host.name;
}

/** 서브탭 라벨을 입력창으로 바꿔 그 자리에서 이름을 고친다 */
function startRenameTab(group, tab, node) {
  const label = node.querySelector('.label');
  if (!label) return;
  const input = document.createElement('input');
  input.className = 'subtab-rename';
  input.value = tabTitle(group, tab);
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    tab.customTitle = v || null; // 비우면 기본 이름(세션 제목)으로 돌아간다
    render();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ------------------------------- 크기 조정 처리 ------------------------------- */

/**
 * 페인 하나의 크기를 맞춘다.
 *
 * xterm 의 DOM 렌더러는 줄 높이를 정수 픽셀로 반올림해 그리는데, fit 애드온은 소수점
 * 셀 높이로 줄 수를 계산한다. 그래서 줄 수가 많아지면 반올림 오차가 쌓여 마지막 줄이
 * 컨테이너 아래로 삐져나가 상태바에 잘린다. 실제 그려진 줄 높이로 다시 확인해 한 줄 줄인다.
 */
function fitLeaf(leaf) {
  if (leaf.mode !== 'terminal') return; // 웹·파일·메모·탐색기 판은 크기 계산이 필요 없다
  try {
    leaf.fit.fit();
  } catch (e) {
    return;
  }

  /*
   * xterm 은 줄 높이를 정수 픽셀로 반올림해 그리는데 fit 은 소수점으로 계산한다.
   * 줄이 많아지면 오차가 쌓여 마지막 줄이 아래로 삐져나가 상태바에 잘린다.
   * 실제로 그려진 화면 높이(.xterm-screen)를 재서 넘치면 한 줄 줄인다.
   * (.xterm-rows 는 WebGL 렌더러에서 없으므로 쓰지 않는다)
   */
  const host = leaf.el.querySelector('.pane-term');
  const screen = leaf.el.querySelector('.xterm-screen');
  if (host && screen && leaf.term.rows > 1) {
    const cs = getComputedStyle(host);
    const avail = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    for (let i = 0; i < 2; i++) {
      const drawn = screen.getBoundingClientRect().height;
      if (drawn <= avail + 0.5 || leaf.term.rows <= 1) break;
      leaf.term.resize(leaf.term.cols, leaf.term.rows - 1);
    }
  }

  if (leaf.sessionId && leaf.status === 'ready') {
    api.ssh.resize(leaf.sessionId, leaf.term.cols, leaf.term.rows);
  }
}

/** 탭 안의 모든 페인 크기를 다시 맞춘다 */
function fitTab(tab) {
  if (!tab) return;
  for (const leaf of leavesOf(tab.root)) fitLeaf(leaf);
  renderStatus();
}

const ro = new ResizeObserver(() => fitTab(activeTab()));
ro.observe(el.terms);
window.addEventListener('resize', () => fitTab(activeTab()));

function setFontSize(size) {
  state.fontSize = Math.max(8, Math.min(28, size));
  localStorage.setItem('fontSize', String(state.fontSize));
  for (const g of state.groups) {
    for (const t of g.tabs) {
      for (const l of leavesOf(t.root)) l.term.options.fontSize = state.fontSize;
    }
  }
  fitTab(activeTab());
}

/* --------------------------------- IPC 수신 --------------------------------- */

api.ssh.onReady(({ id }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  leaf.status = 'ready';
  const grp = state.groups.find((g) => g.id === leaf.groupId);
  if (grp) setTimeout(() => refreshClaudeInfo(grp, true), 800);
  // Claude 상태 훅을 그 서버에 한 번 설치한다(정확한 스피너/알림용).
  // 이미 실행 중인 Claude 에는 다음 실행부터 적용된다.
  if (grp && !grp.hooksInstalled) {
    grp.hooksInstalled = true;
    setTimeout(() => {
      api.claude.installHooks(id).then((ok) => {
        if (!ok) {
          grp.hooksInstalled = false; // 실패하면 다음 세션에서 다시 시도
          console.warn('[armux] Claude 상태 훅 설치 실패 (node 미발견 또는 병합 실패) — 화면 감지 폴백 사용');
        }
      }).catch((e) => {
        grp.hooksInstalled = false; // 실패하면 다음 세션에서 다시 시도
        console.warn('[armux] Claude 상태 훅 설치 오류:', e && e.message);
      });
    }, 1200);
  }
  api.ssh.resize(id, leaf.term.cols, leaf.term.rows);
  render();
  const cur = activeLeaf();
  if (cur && cur.id === leaf.id) leaf.term.focus();
});

const utf8 = new TextDecoder('utf-8', { fatal: false });

api.ssh.onData(({ id, data }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  leaf.term.write(data);
  try {
    feedAlertDetector(leaf, utf8.decode(data, { stream: true }));
  } catch (e) {
    /* 감지 실패는 무시 */
  }
});

api.ssh.onExit(({ id }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  leaf.status = 'closed';
  leaf.term.writeln('\r\n\x1b[90m● 연결이 종료되었습니다. Enter 를 누르면 다시 접속합니다.\x1b[0m');
  sessionToLeaf.delete(id);
  leaf.sessionId = null;
  render();
});

api.ssh.onError(({ id, message }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  leaf.status = 'error';
  leaf.term.writeln(`\r\n\x1b[31m✖ ${message}\x1b[0m`);
  leaf.term.writeln('\x1b[90m  Enter 를 누르면 다시 시도합니다.\x1b[0m');
  sessionToLeaf.delete(id);
  leaf.sessionId = null;
  render();
});

/* ------------------------------- 메뉴/단축키 명령 ------------------------------ */

api.onMenu(async (cmd, arg) => {
  const g = activeGroup();
  const t = activeTab();
  const l = activeLeaf();
  switch (cmd) {
    case 'new-group':
      openConnectDialog({});
      break;
    case 'new-subtab':
      if (g) addSubTab(g);
      else openConnectDialog({});
      break;
    case 'split-vertical': // 좌우
      splitActive('row');
      break;
    case 'split-horizontal': // 상하
      splitActive('col');
      break;
    case 'close-tab':
      if (l) closeLeaf(l);
      else if (g && t) closeTab(g, t);
      break;
    // 입력칸(메모장·주소창·다이얼로그)에서는 브라우저 기본 편집 동작을,
    // 터미널에서는 xterm 선택/SSH 쓰기를 쓴다.
    case 'copy': {
      // 파일 뷰어 등에서 드래그로 고른 일반 텍스트 선택이 있으면 그것을 먼저 복사한다
      const domSel = String(window.getSelection ? window.getSelection() : '');
      if (isTextInput(document.activeElement)) document.execCommand('copy');
      else if (domSel) api.util.clipboardWrite(domSel);
      else if (l && l.mode !== 'web' && l.term.hasSelection()) api.util.clipboardWrite(l.term.getSelection());
      break;
    }
    case 'cut':
      if (isTextInput(document.activeElement)) document.execCommand('cut');
      break;
    case 'selectAll':
      if (isTextInput(document.activeElement)) document.activeElement.select();
      else if (l && l.mode === 'file') {
        // 파일 뷰(구문 강조 <pre>) 전체 선택
        const code = l.el && l.el.querySelector('.fv-code');
        if (code && window.getSelection) {
          const r = document.createRange();
          r.selectNodeContents(code);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
      } else if (l && l.mode !== 'web') l.term.selectAll();
      break;
    case 'paste': {
      if (isTextInput(document.activeElement)) {
        document.execCommand('paste');
        break;
      }
      if (!l || l.status !== 'ready' || l.mode === 'web') break;
      const text = await api.util.clipboardRead();
      if (text) api.ssh.write(l.sessionId, text);
      break;
    }
    case 'find':
      openFind();
      break;
    case 'font':
      setFontSize(arg === 0 ? 13 : state.fontSize + arg);
      break;
    case 'toggle-explorer': {
      if (state.notesOpen) closeNotes();
      const grp = activeGroup();
      if (grp) toggleExplorerView(grp);
      break;
    }
    case 'toggle-notes':
      toggleNotes();
      break;
    case 'help-tmux':
      openHelp('tmux');
      break;
    case 'help-shortcuts':
      openHelp('shortcuts');
      break;
    case 'about':
      openAbout();
      break;
    case 'update':
      openUpdate();
      break;
    default:
      break;
  }
});

// 탭/페인 단축키는 xterm 이 키를 먹기 전에 캡처 단계에서 처리한다
window.addEventListener(
  'keydown',
  (e) => {
    // 한글 등 IME 조합 중에는 절대 끼어들지 않는다 (조합이 깨진다)
    if (e.isComposing || e.keyCode === 229) return;
    const aboutOpen = !aboutBackdrop.classList.contains('hidden');
    const updOpen = !updateBackdrop.classList.contains('hidden');
    if (modalOpen() || helpOpen() || aboutOpen || updOpen) {
      if (e.key === 'Escape') {
        if (modalOpen()) closeDialog();
        else if (helpOpen()) closeHelp();
        else if (aboutOpen) closeAbout();
        else closeUpdate();
      }
      return;
    }

    // 서브탭: mac ⌘+숫자 / win Ctrl+숫자
    // 메인탭: mac ⌘+Control+숫자 / win Ctrl+Alt+숫자
    if (hasMod(e) && !e.shiftKey) {
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m && !(isMacPlatform && e.altKey)) {
        const toGroup = isMacPlatform ? e.ctrlKey : e.altKey; // mac ⌘⌃숫자 / win Ctrl+Alt+숫자
        e.preventDefault();
        e.stopPropagation();
        const n = Number(m[1]) - 1;
        if (toGroup) selectGroupByIndex(n);
        else selectTabByIndex(n);
        return;
      }
    }

    /*
     * 터미널 복사/붙여넣기.
     *  - Ctrl+C : 선택한 글자가 있으면 복사(그리고 선택 해제), 없으면 그대로 셸로 보내 SIGINT
     *  - Ctrl+V : 붙여넣기
     * 입력창(메모장·탐색기 경로 등) 안에서는 브라우저 기본 동작을 그대로 둔다.
     */
    const inTerminal = !isTextInput(e.target);
    if (inTerminal && hasMod(e) && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      const leaf = activeLeaf();
      if (key === 'c' && leaf && leaf.term.hasSelection()) {
        api.util.clipboardWrite(leaf.term.getSelection());
        leaf.term.clearSelection();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (key === 'v' && leaf && leaf.status === 'ready') {
        e.preventDefault();
        e.stopPropagation();
        api.util.clipboardRead().then((text) => text && api.ssh.write(leaf.sessionId, text));
        return;
      }
    }

    // 파일 탐색기: mac ⌘+`  / win Ctrl+`
    // 메모장:     mac ⌘+Control+` / win Ctrl+Alt+`
    if (hasMod(e) && e.code === 'Backquote') {
      const toNotes = isMacPlatform ? e.ctrlKey : e.altKey;
      e.preventDefault();
      e.stopPropagation();
      if (toNotes) {
        toggleNotes();
      } else {
        if (state.notesOpen) closeNotes();
        const g = activeGroup();
        if (g) toggleExplorerView(g);
      }
      return;
    }

    // 분할 / 창 닫기 / 새 탭 — 메뉴 가속기와 별개로 여기서도 확실히 처리한다
    const mod = hasMod(e);
    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      // 좌우 분할: mac ⌘D / 그 외 Ctrl+Shift+D
      if (key === 'd' && (api.platform === 'darwin' ? !e.shiftKey : e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        splitActive('row');
        return;
      }
      // 상하 분할: mac ⌘⇧D / 그 외 Ctrl+Shift+E
      if ((api.platform === 'darwin' && key === 'd' && e.shiftKey) || (api.platform !== 'darwin' && key === 'e' && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        splitActive('col');
        return;
      }
      // 새 서브탭
      if (key === 't' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const g = activeGroup();
        if (g) addSubTab(g);
        else openConnectDialog({});
        return;
      }
      // 새 메인탭(새 접속)
      if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        openConnectDialog({});
        return;
      }
      // 현재 분할 창 닫기
      if (key === 'w' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const l = activeLeaf();
        const g = activeGroup();
        if (g && g.explorerSelected && !g.explorerPinned) leaveExplorer(g);
        else if (l && l.mode === 'file') {
          const t = g && g.tabs.find((x) => x.id === l.tabId);
          if (t) closeFileTab(g, t);
        } else if (l) closeLeaf(l);
        return;
      }
    }

    // 분할 창 이동: ⌘⌥+방향키(mac) / Ctrl+Alt+방향키(win)
    // (Alt+방향키 단독은 터미널의 "단어 이동" 으로 넘겨야 하므로 여기서 잡지 않는다)
    if (e.altKey && hasMod(e)) {
      const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (dirs[e.key]) {
        e.preventDefault();
        e.stopPropagation();
        focusNeighbor(dirs[e.key]);
        return;
      }
    }

    if (e.key === 'Escape' && !el.findbar.classList.contains('hidden')) closeFind();
  },
  true
);

el.newGroupBtn.addEventListener('click', () => openConnectDialog({}));
el.notesTab.addEventListener('click', () => toggleNotes());

/* --------------------------------- 도움 메뉴 -------------------------------- */

const helpBackdrop = document.getElementById('help-backdrop');
const helpTitle = document.getElementById('help-title');
const helpBody = document.getElementById('help-body');
const helpOpen = () => !helpBackdrop.classList.contains('hidden');

function openHelp(key) {
  const content = (window.HELP_CONTENT || {})[key];
  if (!content) return;
  helpTitle.textContent = content.title;
  helpBody.innerHTML = content.html;
  helpBody.scrollTop = 0;
  helpBackdrop.classList.remove('hidden');
}

function closeHelp() {
  helpBackdrop.classList.add('hidden');
  const l = activeLeaf();
  if (l) l.term.focus();
}

document.getElementById('help-close').addEventListener('click', closeHelp);
helpBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === helpBackdrop) closeHelp();
});

/* ------------------------------ 정보 / 업데이트 ------------------------------- */

const aboutBackdrop = document.getElementById('about-backdrop');
const updateBackdrop = document.getElementById('update-backdrop');
const updateMsg = document.getElementById('update-message');
const updateDetail = document.getElementById('update-detail');
const updateBar = document.getElementById('update-bar');
const updateFill = document.getElementById('update-fill');
const updateAction = document.getElementById('update-action');

let appInfo = null;

async function openAbout() {
  appInfo = appInfo || (await api.app.info());
  document.getElementById('about-version').textContent = `v${appInfo.version}${
    appInfo.commit ? ` (${appInfo.commit})` : ''
  }`;
  document.getElementById('about-built').textContent = appInfo.builtAt
    ? new Date(appInfo.builtAt).toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' })
    : '알 수 없음';
  aboutBackdrop.classList.remove('hidden');
}

const closeAbout = () => aboutBackdrop.classList.add('hidden');

/** 업데이트 상태를 화면에 반영 */
function renderUpdateState(st) {
  const texts = {
    idle: '업데이트를 확인해 보세요.',
    checking: '새 버전을 확인하는 중…',
    none: `최신 버전입니다${appInfo ? ` (v${appInfo.version})` : ''}.`,
    available: `새 버전 v${st.version} 이(가) 있습니다.`,
    downloading: `새 버전을 내려받는 중… ${st.progress || 0}%`,
    ready: `v${st.version} 내려받기 완료. 지금 설치하면 앱이 다시 시작됩니다.`,
    error: '업데이트를 확인하지 못했습니다.',
    unsupported: '이 실행 방식에서는 자동 업데이트를 쓸 수 없습니다.'
  };
  updateMsg.textContent = texts[st.status] || '';
  updateDetail.textContent = st.error || '';

  const showBar = st.status === 'downloading' || st.status === 'ready';
  updateBar.classList.toggle('hidden', !showBar);
  updateFill.style.width = `${st.status === 'ready' ? 100 : st.progress || 0}%`;

  updateAction.classList.toggle('hidden', !(st.status === 'available' || st.status === 'ready'));
  updateAction.textContent = st.status === 'ready' ? '지금 설치하고 다시 시작' : '내려받기';
  updateAction.onclick = () => {
    if (st.status === 'ready') api.update.install();
    else api.update.download();
  };
}

async function openUpdate() {
  appInfo = appInfo || (await api.app.info());
  updateBackdrop.classList.remove('hidden');
  renderUpdateState({ status: 'checking' });
  renderUpdateState(await api.update.check());
}

const closeUpdate = () => updateBackdrop.classList.add('hidden');

api.update.onState((st) => {
  if (!updateBackdrop.classList.contains('hidden')) renderUpdateState(st);
});

document.getElementById('about-close').addEventListener('click', closeAbout);
document.getElementById('about-github').addEventListener('click', () => api.app.openExternal(appInfo.repoUrl));
document.getElementById('about-update').addEventListener('click', () => {
  closeAbout();
  openUpdate();
});
aboutBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === aboutBackdrop) closeAbout();
});

document.getElementById('update-close').addEventListener('click', closeUpdate);
document.getElementById('update-releases').addEventListener('click', () => api.update.openReleases());
document.getElementById('update-again').addEventListener('click', async () => renderUpdateState(await api.update.check()));
updateBackdrop.addEventListener('mousedown', (e) => {
  if (e.target === updateBackdrop) closeUpdate();
});

/* ---------------------------------- 검색바 ---------------------------------- */

function openFind() {
  if (!activeLeaf()) return;
  el.findbar.classList.remove('hidden');
  el.findInput.focus();
  el.findInput.select();
}
function closeFind() {
  el.findbar.classList.add('hidden');
  const l = activeLeaf();
  if (l) {
    l.search.clearDecorations();
    l.term.focus();
  }
}
function findNext(back) {
  const l = activeLeaf();
  if (!l) return;
  const q = el.findInput.value;
  if (!q) return;
  const opts = { decorations: { activeMatchBackground: '#f3f99d', matchBackground: '#3a4a5a' } };
  if (back) l.search.findPrevious(q, opts);
  else l.search.findNext(q, opts);
}
document.getElementById('find-next').addEventListener('click', () => findNext(false));
document.getElementById('find-prev').addEventListener('click', () => findNext(true));
document.getElementById('find-close').addEventListener('click', closeFind);
el.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findNext(e.shiftKey);
  if (e.key === 'Escape') closeFind();
  e.stopPropagation();
});

/* ------------------------------- 접속 다이얼로그 ------------------------------- */

const dlg = {
  backdrop: document.getElementById('modal-backdrop'),
  title: document.getElementById('modal-title'),
  formTitle: document.getElementById('form-title'),
  list: document.getElementById('host-list'),
  filter: document.getElementById('host-filter'),
  name: document.getElementById('f-name'),
  host: document.getElementById('f-host'),
  port: document.getElementById('f-port'),
  user: document.getElementById('f-user'),
  auth: document.getElementById('f-auth'),
  password: document.getElementById('f-password'),
  key: document.getElementById('f-key'),
  keyBrowse: document.getElementById('f-key-browse'),
  passphrase: document.getElementById('f-passphrase'),
  savePw: document.getElementById('f-save-pw'),
  error: document.getElementById('modal-error'),
  connectBtn: document.getElementById('modal-connect'),
  cancelBtn: document.getElementById('modal-cancel'),
  closeBtn: document.getElementById('modal-close'),
  deleteBtn: document.getElementById('host-delete'),
  registerBtn: document.getElementById('host-register'),
  modeSsh: document.getElementById('mode-ssh'),
  modeWeb: document.getElementById('mode-web'),
  webForm: document.getElementById('web-form'),
  webUrl: document.getElementById('web-url-input'),
  webChromeInfo: document.getElementById('web-chrome-info'),
  webFavList: document.getElementById('web-fav-list'),
  openWebBtn: document.getElementById('modal-open-web'),
  body: document.querySelector('#modal .modal-body'),
  saveBtn: document.getElementById('host-save'),
  newBtn: document.getElementById('host-new')
};

let dlgHosts = [];
let dlgSelectedId = null;
let dlgTargetGroup = null;
let canSavePassword = true;
let dlgMode = 'ssh'; // 'ssh' | 'web'

const modalOpen = () => !dlg.backdrop.classList.contains('hidden');

/** 다이얼로그를 SSH / 웹페이지 모드로 전환 */
async function setDialogMode(mode) {
  dlgMode = mode;
  dlg.modeSsh.classList.toggle('active', mode === 'ssh');
  dlg.modeWeb.classList.toggle('active', mode === 'web');
  dlg.body.classList.toggle('hidden', mode === 'web');
  dlg.webForm.classList.toggle('hidden', mode !== 'web');

  // 아래 버튼도 모드에 맞춰서
  for (const b of [dlg.connectBtn, dlg.registerBtn, dlg.saveBtn, dlg.deleteBtn]) {
    b.classList.toggle('hidden', mode === 'web' || (b === dlg.saveBtn && !dlgSelectedId) || (b === dlg.deleteBtn && !dlgSelectedId));
  }
  dlg.openWebBtn.classList.toggle('hidden', mode !== 'web');
  dlg.title.textContent = mode === 'web' ? '웹페이지 열기' : dlgTargetGroup ? `"${dlgTargetGroup.host.name}" 그룹에 서브탭 추가` : '새 SSH 접속';

  if (mode === 'web') {
    dlg.webUrl.focus();
    try {
      const info = await api.web.chromeInfo();
      dlg.webChromeInfo.textContent = `Chromium ${info.chromiumVersion} 엔진으로 표시됩니다.`;
    } catch (e) {
      dlg.webChromeInfo.textContent = '';
    }
    renderDialogFavorites();
  }
}

async function openConnectDialog({ group, mode }) {
  dlgTargetGroup = group || null;
  dlg.title.textContent = group ? `"${group.host.name}" 그룹에 서브탭 추가` : '새 SSH 접속';
  dlg.error.classList.add('hidden');
  dlg.backdrop.classList.remove('hidden');

  canSavePassword = await api.hosts.canSavePassword();
  dlg.savePw.disabled = !canSavePassword;
  dlg.savePw.parentElement.title = canSavePassword
    ? 'OS 키체인으로 암호화해 저장합니다.'
    : '이 환경에서는 안전한 암호화를 쓸 수 없어 비밀번호를 저장하지 않습니다.';

  await refreshHostList();
  if (dlgHosts.length > 0) selectHost(dlgHosts[0].id);
  else clearForm();
  await setDialogMode(mode || 'ssh');
  if (dlgMode === 'ssh') (dlgHosts.length ? dlg.connectBtn : dlg.host).focus();
}

function closeDialog() {
  dlg.backdrop.classList.add('hidden');
  dlg.password.value = '';
  dlg.passphrase.value = '';
  const l = activeLeaf();
  if (l) l.term.focus();
}

async function refreshHostList() {
  dlgHosts = await api.hosts.list();
  renderHostList();
}

function renderHostList() {
  const q = dlg.filter.value.trim().toLowerCase();
  const items = dlgHosts.filter((h) => !q || `${h.name} ${h.username}@${h.host}`.toLowerCase().includes(q));
  dlg.list.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = dlgHosts.length ? '검색 결과가 없습니다.' : '저장된 접속이 없습니다. 오른쪽에 정보를 넣고 "새로 등록" 을 누르세요.';
    dlg.list.appendChild(li);
    return;
  }
  for (const h of items) {
    const li = document.createElement('li');
    li.className = h.id === dlgSelectedId ? 'selected' : '';
    const name = document.createElement('b');
    name.className = 'h-name';
    name.textContent = h.name;
    const sub = document.createElement('span');
    sub.className = 'h-sub';
    sub.textContent = `${h.username}@${h.host}:${h.port} · ${
      { password: '비밀번호', key: '키', agent: 'agent' }[h.authType] || h.authType
    }${h.hasSavedPassword ? ' · 비밀번호 저장됨' : ''}`;
    li.append(name, sub);
    li.addEventListener('click', () => selectHost(h.id));
    li.addEventListener('dblclick', () => doConnect());
    dlg.list.appendChild(li);
  }
}

function selectHost(id) {
  dlgSelectedId = id;
  const h = dlgHosts.find((x) => x.id === id);
  if (h) {
    dlg.name.value = h.name;
    dlg.host.value = h.host;
    dlg.port.value = h.port;
    dlg.user.value = h.username;
    dlg.auth.value = h.authType;
    dlg.key.value = h.privateKeyPath || '';
    dlg.password.value = '';
    dlg.password.placeholder = h.hasSavedPassword ? '저장된 비밀번호 사용' : '';
    dlg.passphrase.value = '';
    dlg.savePw.checked = false;
    dlg.formTitle.textContent = `접속 정보 — ${h.name}`;
  }
  dlg.deleteBtn.classList.remove('hidden');
  dlg.saveBtn.classList.remove('hidden');
  updateAuthRows();
  renderHostList();
}

/** 폼을 비우고 "신규 등록" 상태로 만든다 */
function clearForm() {
  dlgSelectedId = null;
  dlg.name.value = '';
  dlg.host.value = '';
  dlg.port.value = '22';
  dlg.user.value = '';
  dlg.auth.value = 'password';
  dlg.password.value = '';
  dlg.password.placeholder = '';
  dlg.key.value = '';
  dlg.passphrase.value = '';
  dlg.savePw.checked = false;
  dlg.formTitle.textContent = '새 접속 정보';
  dlg.deleteBtn.classList.add('hidden');
  dlg.saveBtn.classList.add('hidden'); // 선택된 항목이 없으면 "저장"(덮어쓰기)은 숨긴다
  updateAuthRows();
  renderHostList();
  dlg.host.focus();
}

function updateAuthRows() {
  const isPw = dlg.auth.value === 'password';
  const isKey = dlg.auth.value === 'key';
  document.querySelectorAll('.row-password').forEach((n) => n.classList.toggle('hidden', !isPw));
  document.querySelectorAll('.row-key').forEach((n) => n.classList.toggle('hidden', !isKey));
}

/** 폼 → 프로필 객체 (검증 포함, 실패하면 null) */
function readForm() {
  const profile = {
    name: dlg.name.value.trim(),
    host: dlg.host.value.trim(),
    port: Number(dlg.port.value) || 22,
    username: dlg.user.value.trim(),
    authType: dlg.auth.value,
    password: dlg.auth.value === 'password' ? dlg.password.value : '',
    privateKeyPath: dlg.auth.value === 'key' ? dlg.key.value.trim() : '',
    passphrase: dlg.auth.value === 'key' ? dlg.passphrase.value : '',
    savePassword: dlg.savePw.checked && canSavePassword
  };
  if (!profile.host) {
    showDlgError('호스트를 입력하세요.');
    return null;
  }
  if (!profile.username) {
    showDlgError('사용자 이름을 입력하세요.');
    return null;
  }
  if (!profile.name) profile.name = `${profile.username}@${profile.host}`;
  dlg.error.classList.add('hidden');
  return profile;
}

/** 새 항목으로 등록 (기존 항목을 절대 건드리지 않는다) */
async function registerHost() {
  const profile = readForm();
  if (!profile) return;
  const saved = await api.hosts.save({ ...profile, id: null });
  await refreshHostList();
  selectHost(saved.id);
  flashDlgInfo(`"${saved.name}" 등록됨`);
}

/** 선택된 항목 덮어쓰기 */
async function saveHost() {
  if (!dlgSelectedId) return registerHost();
  const profile = readForm();
  if (!profile) return;
  const saved = await api.hosts.save({ ...profile, id: dlgSelectedId });
  await refreshHostList();
  selectHost(saved.id);
  flashDlgInfo(`"${saved.name}" 저장됨`);
}

function flashDlgInfo(msg) {
  dlg.error.textContent = msg;
  dlg.error.classList.remove('hidden', 'error');
  dlg.error.classList.add('info');
  setTimeout(() => {
    dlg.error.classList.add('hidden');
    dlg.error.classList.remove('info');
    dlg.error.classList.add('error');
  }, 1800);
}

function showDlgError(msg) {
  dlg.error.textContent = msg;
  dlg.error.classList.remove('hidden', 'info');
  dlg.error.classList.add('error');
}

dlg.auth.addEventListener('change', updateAuthRows);
dlg.filter.addEventListener('input', renderHostList);
dlg.keyBrowse.addEventListener('click', async () => {
  const p = await api.util.pickKeyFile();
  if (p) dlg.key.value = p;
});
dlg.modeSsh.addEventListener('click', () => setDialogMode('ssh'));
dlg.modeWeb.addEventListener('click', () => setDialogMode('web'));
dlg.webUrl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') openWebPage();
});
dlg.openWebBtn.addEventListener('click', () => openWebPage());
dlg.newBtn.addEventListener('click', clearForm);
dlg.registerBtn.addEventListener('click', registerHost);
dlg.saveBtn.addEventListener('click', saveHost);
dlg.closeBtn.addEventListener('click', closeDialog);
dlg.cancelBtn.addEventListener('click', closeDialog);
dlg.connectBtn.addEventListener('click', () => doConnect());
dlg.deleteBtn.addEventListener('click', async () => {
  if (!dlgSelectedId) return;
  const h = dlgHosts.find((x) => x.id === dlgSelectedId);
  const ok = await api.util.confirm(`"${h.name}" 접속 정보를 삭제할까요?`, `${h.username}@${h.host}:${h.port}`);
  if (!ok) return;
  await api.hosts.remove(dlgSelectedId);
  await refreshHostList();
  clearForm();
});

dlg.backdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialog();
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
    if (dlgMode === 'web') openWebPage();
    else doConnect();
  }
  e.stopPropagation();
});
dlg.backdrop.addEventListener('mousedown', (e) => {
  if (e.target === dlg.backdrop) closeDialog();
});

/** 웹페이지를 새 탭(또는 현재 그룹의 서브탭)으로 연다 */
function openWebPage() {
  const url = window.WebPane.toUrl(dlg.webUrl.value || 'https://www.google.com');
  closeDialog();
  if (dlgTargetGroup) {
    const tab = createWebTab(dlgTargetGroup, url);
    return tab;
  }
  return createWebGroup(url);
}

// 새 웹페이지 열기 다이얼로그에 즐겨찾기 목록을 그린다.
async function renderDialogFavorites() {
  if (!dlg.webFavList) return;
  const favs = await api.web.favList();
  dlg.webFavList.innerHTML = '';
  if (!favs.length) {
    const hint = document.createElement('div');
    hint.className = 'web-fav-empty';
    hint.textContent = '아직 즐겨찾기가 없습니다. 웹페이지를 연 뒤 상단 "★ 추가" 로 등록하세요.';
    dlg.webFavList.appendChild(hint);
    return;
  }
  for (const f of favs) {
    const card = document.createElement('div');
    card.className = 'web-fav';
    const name = document.createElement('div'); // 즐겨찾기 이름
    name.className = 'web-fav-name';
    name.textContent = f.name || f.url;
    const url = document.createElement('div'); // 즐겨찾기 주소
    url.className = 'web-fav-url';
    url.textContent = f.url;
    const del = document.createElement('button'); // 삭제 버튼
    del.className = 'web-fav-del';
    del.textContent = '✕';
    del.title = '즐겨찾기에서 삭제';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.web.favRemove(f.url);
      renderDialogFavorites();
    });
    card.append(name, url, del);
    // 카드를 누르면 해당 즐겨찾기로 새 웹 탭(또는 서브탭)을 연다.
    card.addEventListener('click', () => {
      const target = dlgTargetGroup;
      closeDialog();
      if (target) createWebTab(target, f.url);
      else createWebGroup(f.url);
    });
    dlg.webFavList.appendChild(card);
  }
}

/**
 * 폼 내용으로 접속.
 * 저장된 목록에 없는 새 서버라면 자동으로 등록해 둔다(다음에 목록에서 바로 고를 수 있게).
 */
async function doConnect() {
  const profile = readForm();
  if (!profile) return;

  let hostId = dlgSelectedId || null;
  if (!hostId) {
    // 호스트/포트/사용자가 같은 항목이 이미 있으면 그것을 쓰고, 없으면 새로 등록
    const same = dlgHosts.find(
      (h) => h.host === profile.host && Number(h.port) === Number(profile.port) && h.username === profile.username
    );
    if (same) {
      hostId = same.id;
    } else {
      try {
        const saved = await api.hosts.save({ ...profile, id: null });
        hostId = saved.id;
      } catch (e) {
        hostId = null; // 저장에 실패해도 접속은 계속한다
      }
    }
  }

  const connect = { hostId, profile };
  closeDialog();
  if (dlgTargetGroup) createTab(dlgTargetGroup, connect);
  else createGroup({ ...profile, id: hostId }, connect);
}

/* --------------------------------- 시작 동작 -------------------------------- */

// 접속한 서버들의 Claude 사용량을 주기적으로 갱신 (활성 그룹 위주)
claudePollTimer = setInterval(() => {
  const g = activeGroup();
  if (g) refreshClaudeInfo(g);
  renderClaudeStatus(); // 초기화까지 남은 시간을 갱신
}, 20000);

// 시작: 지난번 탭 구성이 있으면 되살리고, 없으면 빈 검은 화면.
render();
restoreSession();
