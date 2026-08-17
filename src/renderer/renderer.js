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
const MAIN_TAB_MOD = api.platform === 'darwin' ? '⌘⌥' : 'Alt';
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
    busy: false, // 명령이 돌아가는 중인지
    spin: null, // 표시할 스피너 종류: null | 'busy' | 'claude'
    wasThinking: false, // 직전 검사에서 Claude 가 작업 중이었는지
    lastOutputAt: 0,
    mode: 'terminal', // 'terminal' | 'web'
    web: null, // 웹 브라우저 화면 (웹으로 전환할 때 만든다)
    connect
  };

  // 페인 DOM + xterm 인스턴스
  const pane = document.createElement('div');
  pane.className = 'pane';
  const termHost = document.createElement('div');
  termHost.className = 'pane-term';
  pane.appendChild(termHost);

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
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  } catch (e) {
    /* noop */
  }
  term.open(termHost);

  // GPU 렌더러. 기본 DOM 렌더러보다 훨씬 가볍다(특히 macOS).
  // 컨텍스트를 잃으면 자동으로 기본 렌더러로 돌아간다.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch (e2) {
        /* noop */
      }
    });
    term.loadAddon(webgl);
  } catch (e) {
    /* WebGL 을 못 쓰면 기본 렌더러로 그대로 간다 */
  }

  leaf.el = pane;
  leaf.term = term;
  leaf.fit = fit;
  leaf.search = search;

  // 키 입력 → SSH 로 전달. 사용자가 직접 입력했다면 알림은 확인한 것으로 본다.
  term.onData((data) => {
    leaf.lastInputAt = Date.now();
    if (data.includes('\r')) {
      // 명령을 실행했다고 보고 스피너를 돌린다 (프롬프트가 돌아오면 멈춘다)
      leaf.busy = true;
      leaf.lastOutputAt = Date.now();
    }
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
  leaf.el.remove();
}

/* ------------------------------ 판을 웹으로 전환 ------------------------------ */

/**
 * 판을 터미널 ↔ 웹 브라우저로 전환한다.
 * 터미널은 없애지 않고 감춰 두므로, 돌아오면 SSH 세션이 그대로 살아 있다.
 */
function setLeafMode(leaf, mode, url) {
  if (mode === 'web') {
    if (!leaf.web) {
      leaf.web = window.WebPane.create({
        url: url || 'https://www.google.com',
        onTitle: (title) => {
          leaf.title = title || leaf.title;
          scheduleRender();
        },
        onUrl: () => saveSession()
      });
      leaf.el.appendChild(leaf.web.el);
    } else if (url) {
      leaf.web.go(url);
    }
    leaf.mode = 'web';
  } else {
    leaf.mode = 'terminal';
  }

  const termHost = leaf.el.querySelector('.pane-term');
  if (termHost) termHost.classList.toggle('hidden', leaf.mode === 'web');
  if (leaf.web) leaf.web.el.classList.toggle('hidden', leaf.mode !== 'web');

  renderPaneOverlay(leaf, true);
  render();
  if (leaf.mode === 'web') leaf.web.focus();
  else {
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
 * 무엇이 돌아가는 중인지는 "지금 화면에 무엇이 떠 있는가" 로 판단한다.
 * (출력 스트림만 보고 추측하면, Claude 처럼 프롬프트를 감추는 화면에서 영원히 실행 중으로 남는다)
 *
 *   1) 화면에 "esc to interrupt" 가 있다        → Claude 가 생각하는 중  (✳ 스피너)
 *   2) Claude 화면은 떠 있지만 위 표시가 없다    → 입력 대기. 아무 표시도 하지 않는다
 *   3) 대체 화면 버퍼(vim·htop 등 전체화면 앱)   → 프로그램 실행 중       (원형 스피너)
 *   4) 평범한 셸에서 Enter 후 프롬프트가 아직    → 명령 실행 중           (원형 스피너)
 *      돌아오지 않았다
 */
const PROMPT_RE = /[$#%>❯]\s*$/;
const CLAUDE_WORK_RE = /esc to interrupt/i; // Claude 가 작업 중일 때만 화면에 있는 문구
const CLAUDE_UI_RE = /esc to interrupt|\? for shortcuts|⏵⏵|╭─{3,}|╰─{3,}|bypass permissions/i;
const PROMPT_IDLE_MS = 250; // 출력이 이만큼 멎고 프롬프트면 명령이 끝난 것으로 본다
// tmux 상태줄 인식: 윈도우 목록("0:bash*") 이나 기본 status-right('"host" 18:43') 로 판단
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
function raiseAlert(leaf) {
  if (leaf.alert) return;
  const cur = activeLeaf();
  if (cur && cur.id === leaf.id && document.hasFocus()) return;
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

/** 모든 페인의 실행 상태를 다시 계산해 스피너 표시를 정한다 */
let activityTick = 0;

function evaluateActivity() {
  const now = Date.now();
  let changed = false;
  activityTick += 1;
  const curTab = activeTab();
  // 화면에 보이는 탭은 매번, 나머지는 다섯 번에 한 번만 살펴본다(느려지지 않게)
  const scanBackground = activityTick % 5 === 0;

  for (const g of state.groups) {
    for (const t of g.tabs) {
      if (t !== curTab && !scanBackground) continue;
      for (const leaf of leavesOf(t.root)) {
        if (leaf.mode === 'web') {
          if (leaf.spin || leaf.busy) {
            leaf.spin = null;
            leaf.busy = false;
            changed = true;
          }
          continue; // 웹 화면에는 실행 표시가 없다
        }
        if (leaf.status !== 'ready') {
          if (leaf.spin || leaf.busy) {
            leaf.spin = null;
            leaf.busy = false;
            changed = true;
          }
          continue;
        }

        const screen = readScreenTail(leaf);
        const lastLine = lastNonEmptyLine(screen);
        const thinking = CLAUDE_WORK_RE.test(screen); // Claude 작업 중
        const claudeOpen = CLAUDE_UI_RE.test(screen); // Claude 화면이 떠 있음
        const altScreen = leaf.term.buffer.active.type === 'alternate'; // vim/htop 등

        // 셸 명령 실행 여부: 프롬프트가 돌아오면 끝난 것
        if (claudeOpen || altScreen) {
          leaf.busy = false; // 셸 프롬프트 개념이 없는 화면
        } else if (leaf.busy && PROMPT_RE.test(lastLine) && now - leaf.lastOutputAt > PROMPT_IDLE_MS) {
          leaf.busy = false;
        }

        let kind = null;
        if (thinking) kind = 'claude';
        else if (altScreen || leaf.busy) kind = 'busy';

        // Claude 가 생각을 끝냈는데 그 창을 보고 있지 않다면 알림
        if (leaf.wasThinking && !thinking) {
          const cur = activeLeaf();
          const looking = cur && cur.id === leaf.id && document.hasFocus() && !state.notesOpen;
          if (!looking) raiseAlert(leaf);
        }
        leaf.wasThinking = thinking;

        if (leaf.spin !== kind) {
          leaf.spin = kind;
          changed = true;
        }
      }
    }
  }
  if (changed) scheduleRender();
}

setInterval(evaluateActivity, 400);

/** 탭 안에서 돌아가는 것이 있으면 그 종류를 알려준다 ('claude' 가 우선) */
function tabSpin(tab) {
  const kinds = leavesOf(tab.root).map((l) => l.spin);
  if (kinds.includes('claude')) return 'claude';
  if (kinds.includes('busy')) return 'busy';
  return null;
}

const groupSpin = (group) => {
  const kinds = group.tabs.map(tabSpin);
  if (kinds.includes('claude')) return 'claude';
  if (kinds.includes('busy')) return 'busy';
  return null;
};

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
    hostLabel: group.host.name
  });
  return group.explorer;
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
  const onMove = (ev) => {
    dockWidth = Math.max(200, Math.min(window.innerWidth - 320, startW + (ev.clientX - startX)));
    el.dock.style.width = `${dockWidth}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing-col');
    localStorage.setItem(DOCK_KEY, String(dockWidth));
    fitTab(activeTab());
    saveSession();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
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

  const onMove = (ev) => {
    const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
    let ratio = pos / total;
    ratio = Math.max(0.1, Math.min(0.9, ratio)); // 너무 작아지지 않게 제한
    node.sizes = [ratio, 1 - ratio];
    a.style.flex = `${node.sizes[0]} 1 0`;
    b.style.flex = `${node.sizes[1]} 1 0`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing-col', 'resizing-row');
    fitTab(tab);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
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
      ['파일 탐색기', 'Ctrl+`', () => {
        const g = activeGroup();
        if (g) toggleExplorerView(g);
      }],
      ['메모장', 'Ctrl+Alt+`', () => toggleNotes()],
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
    return node.mode === 'web' ? { kind: 'leaf', mode: 'web', url: node.web ? node.web.url : null } : { kind: 'leaf' };
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

const CLAUDE_POLL_MS = 300000; // 5분마다 갱신 (사용량 API 는 호출이 잦으면 제한된다)
const CLAUDE_BACKOFF_MS = 900000; // 제한에 걸리면 15분 쉬었다 다시
let claudePollTimer = null;

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
  if (group.claudeBackoffUntil && Date.now() < group.claudeBackoffUntil && !force) return;
  if (!force && group.claudeFetchedAt && Date.now() - group.claudeFetchedAt < CLAUDE_POLL_MS) return;
  if (group.claudeFetching) return;

  group.claudeFetching = true;
  try {
    const info = await api.claude.info(sessionId);
    // 사용량 조회가 한 번 실패해도 화면이 깜빡이지 않도록 직전 값을 유지한다
    const prev = group.claudeInfo;
    if (info && info.loggedIn && !info.session && prev && prev.session) {
      info.session = prev.session;
      info.week = prev.week;
      info.stale = true;
    }
    if (info && info.rateLimited) group.claudeBackoffUntil = Date.now() + CLAUDE_BACKOFF_MS;
    else group.claudeBackoffUntil = 0;
    group.claudeInfo = info;
    group.claudeFetchedAt = Date.now();
    if (activeGroup() === group) renderClaudeStatus();
  } catch (e) {
    group.claudeInfo = { loggedIn: false };
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
    note.textContent = info.rateLimited ? '사용량 조회 잠시 제한됨' : '사용량 조회 불가';
    note.title = info.rateLimited
      ? 'Anthropic 사용량 API 호출 제한에 걸렸습니다. 잠시 뒤 자동으로 다시 시도합니다.'
      : '';
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
function makeReorderable(node, arr, index, kind, after) {
  node.draggable = true;

  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(`armux/${kind}`, String(index));
    e.dataTransfer.setData('text/plain', String(index)); // 일부 환경에서 이게 없으면 드래그가 시작되지 않는다
    node.classList.add('dragging');
    hoverAdd.classList.add('hidden');
  });

  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    clearDropMarks(node.parentElement);
  });

  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(`armux/${kind}`)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = node.getBoundingClientRect();
    const after0 = e.clientX > r.left + r.width / 2; // 절반을 넘겼으면 오른쪽에 삽입
    node.classList.toggle('drop-before', !after0);
    node.classList.toggle('drop-after', after0);
  });

  node.addEventListener('dragleave', () => {
    node.classList.remove('drop-before', 'drop-after');
  });

  node.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData(`armux/${kind}`);
    if (raw === '') return;
    e.preventDefault();
    e.stopPropagation();
    const from = Number(raw);
    const r = node.getBoundingClientRect();
    let to = index + (e.clientX > r.left + r.width / 2 ? 1 : 0);
    clearDropMarks(node.parentElement);
    if (Number.isNaN(from) || from === to || from + 1 === to) return;
    if (from < to) to -= 1; // 앞에서 빼면 뒤 인덱스가 하나 당겨진다
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    after();
  });
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

/**
 * 실행 중 표시.
 *  - 'busy'   : 원형 스피너 (일반 명령이 돌아가는 중)
 *  - 'claude' : Claude 로고 모양(✳)이 도는 스피너
 */
function spinner(kind) {
  const el2 = document.createElement('span');
  if (kind === 'claude') {
    el2.className = 'spin-claude';
    el2.textContent = '✳';
    el2.title = 'Claude Code 작동 중';
  } else {
    el2.className = 'spin-busy';
    el2.title = '명령 실행 중';
  }
  return el2;
}

/**
 * 탭 앞에 붙는 표시 하나를 고른다.
 * 우선순위: 초록 느낌표(응답 대기) > Claude 작업 중 > 명령 실행 중 > 연결 상태 점
 */
function statusMark(status, spin, alerted) {
  if (alerted) return alertBadge();
  if (spin) return spinner(spin);
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
  if (hoverAddGroup && !state.groups.includes(hoverAddGroup)) {
    hoverAdd.classList.add('hidden');
    hoverAddGroup = null;
  }
  el.tabstrip.innerHTML = '';

  state.groups.forEach((group, gi) => {
    const active = group.id === state.activeGroupId;
    const cur = group.tabs.find((t) => t.id === group.activeTabId) || group.tabs[0];

    const node = document.createElement('div');
    node.className = 'tab' + (active ? ' active' : '');
    node.title =
      `${group.host.name} — ${group.host.username}@${group.host.host}:${group.host.port}\n` +
      `${gi < 9 ? `${api.platform === 'darwin' ? '⌘⌥' : 'Ctrl+Alt+'}${gi + 1} 로 이동 · ` : ''}끌어서 순서 변경 · 가운데 클릭: 닫기\n` +
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
    node.addEventListener('mouseenter', () => showHoverAdd(node, group));
    node.addEventListener('mouseleave', () => hideHoverAdd());
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
    makeReorderable(node, group.tabs, ti, 'tab', () => {
      render();
      fitTab(activeTab());
    });

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
        renderPaneOverlay(l);
      }
    }
  }
}

/** 페인 우상단의 도구 버튼 (두 줄) */
function renderPaneOverlay(leaf, rebuild) {
  let bar = leaf.el.querySelector('.pane-tools');
  if (bar && rebuild) {
    bar.remove();
    bar = null;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'pane-tools';

    const mk = (text, title, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      if (cls) b.className = cls;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };

    // 첫 줄: 새 탭으로 / 스크롤 / 분할 / 닫기
    const row1 = document.createElement('div');
    row1.className = 'pane-tools-row';
    row1.append(
      mk('⇱', '이 창을 새 서브탭으로 열기', () => popOutLeaf(leaf)),
      mk('⤒', '맨 위로 (tmux 안에서도 동작)', () => {
        focusLeaf(leaf);
        scrollPane(leaf, 'top');
      }),
      mk('⤓', '맨 아래로 (tmux 안에서도 동작)', () => {
        focusLeaf(leaf);
        scrollPane(leaf, 'bottom');
      }),
      mk('▯|▯', '좌우로 분할 (mac ⌘D / win Ctrl+Shift+D)', () => {
        focusLeaf(leaf);
        splitActive('row');
      }),
      mk('▤', '위아래로 분할 (mac ⌘⇧D / win Ctrl+Shift+E)', () => {
        focusLeaf(leaf);
        splitActive('col');
      }),
      mk('✕', '이 분할 창 닫기 (Ctrl/⌘+W)', () => closeLeaf(leaf))
    );

    // 둘째 줄: 터미널 ↔ 웹페이지 전환
    const row2 = document.createElement('div');
    row2.className = 'pane-tools-row';
    row2.append(
      mk(
        leaf.mode === 'web' ? '⌨ 터미널로 전환' : '🌐 웹페이지로 전환',
        leaf.mode === 'web' ? '이 판을 다시 터미널로 (SSH 세션은 그대로 살아 있습니다)' : '이 판에 웹 브라우저를 띄웁니다',
        () => setLeafMode(leaf, leaf.mode === 'web' ? 'terminal' : 'web'),
        'wide'
      )
    );

    bar.append(row1, row2);
    leaf.el.appendChild(bar);
  }

  const badge = leaf.el.querySelector('.pane-alert');
  if (leaf.alert && !badge) {
    const b = alertBadge();
    b.classList.add('pane-alert');
    leaf.el.appendChild(b);
  } else if (!leaf.alert && badge) {
    badge.remove();
  }
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

/* ------------------------- 탭 호버 시 뜨는 서브탭 추가 버튼 ------------------------ */

const hoverAdd = document.createElement('button');
hoverAdd.id = 'hover-add';
hoverAdd.className = 'hidden';
hoverAdd.textContent = '+';
hoverAdd.title = '이 그룹에 서브탭 추가 (Shift+클릭: 다른 호스트로 접속)';
document.body.appendChild(hoverAdd);

let hoverAddGroup = null;
let hoverAddTimer = null;

function showHoverAdd(tabNode, group) {
  clearTimeout(hoverAddTimer);
  hoverAddGroup = group;
  const r = tabNode.getBoundingClientRect();
  hoverAdd.style.left = `${Math.round(r.left + r.width / 2 - 12)}px`;
  hoverAdd.style.top = `${Math.round(r.bottom + 3)}px`;
  hoverAdd.classList.remove('hidden');
}

function hideHoverAdd() {
  clearTimeout(hoverAddTimer);
  hoverAddTimer = setTimeout(() => {
    if (!hoverAdd.matches(':hover')) {
      hoverAdd.classList.add('hidden');
      hoverAddGroup = null;
    }
  }, 220);
}

hoverAdd.addEventListener('mouseenter', () => clearTimeout(hoverAddTimer));
hoverAdd.addEventListener('mouseleave', () => hideHoverAdd());
hoverAdd.addEventListener('click', (e) => {
  e.stopPropagation();
  const group = hoverAddGroup;
  hoverAdd.classList.add('hidden');
  if (!group) return;
  if (e.shiftKey) openConnectDialog({ group });
  else addSubTab(group);
});

/* ------------------------------- 크기 조정 처리 ------------------------------- */

/**
 * 페인 하나의 크기를 맞춘다.
 *
 * xterm 의 DOM 렌더러는 줄 높이를 정수 픽셀로 반올림해 그리는데, fit 애드온은 소수점
 * 셀 높이로 줄 수를 계산한다. 그래서 줄 수가 많아지면 반올림 오차가 쌓여 마지막 줄이
 * 컨테이너 아래로 삐져나가 상태바에 잘린다. 실제 그려진 줄 높이로 다시 확인해 한 줄 줄인다.
 */
function fitLeaf(leaf) {
  if (leaf.mode === 'web') return; // 웹 판은 크기 계산이 필요 없다
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
    case 'copy':
      if (isTextInput(document.activeElement)) document.execCommand('copy');
      else if (l && l.mode !== 'web' && l.term.hasSelection()) api.util.clipboardWrite(l.term.getSelection());
      break;
    case 'cut':
      if (isTextInput(document.activeElement)) document.execCommand('cut');
      break;
    case 'selectAll':
      if (isTextInput(document.activeElement)) document.activeElement.select();
      else if (l && l.mode !== 'web') l.term.selectAll();
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

    // ⌘/Ctrl + 숫자 = 서브탭, +Alt = 메인탭
    if (hasMod(e) && !e.shiftKey) {
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) {
        e.preventDefault();
        e.stopPropagation();
        const n = Number(m[1]) - 1;
        if (e.altKey) selectGroupByIndex(n);
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

    // ⌘/Ctrl + ` : 파일 탐색기, +Alt : 메모장
    if (hasMod(e) && e.code === 'Backquote') {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) {
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
        else if (l) closeLeaf(l);
        return;
      }
    }

    // Alt + 방향키 → 분할된 페인 사이 이동
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
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
  document.getElementById('about-engine').textContent = `Electron ${appInfo.electron} · Node ${appInfo.node}`;
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
      dlg.webChromeInfo.textContent = info.chromeSource
        ? `이 PC 의 크롬 북마크 ${info.count}개를 불러와 북마크 바에 보여 줍니다. (Chromium ${info.chromiumVersion})`
        : `이 PC 에서 크롬 북마크를 찾지 못했습니다. 앱에서 ☆ 로 북마크를 직접 추가할 수 있습니다. (Chromium ${info.chromiumVersion})`;
    } catch (e) {
      dlg.webChromeInfo.textContent = '';
    }
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
}, 30000);

// 시작: 지난번 탭 구성이 있으면 되살리고, 없으면 빈 검은 화면.
render();
restoreSession();
