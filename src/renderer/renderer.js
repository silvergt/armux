'use strict';

/* global Terminal, FitAddon, SearchAddon, UnicodeGraphemesAddon, WebglAddon */

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
  aiFab: document.getElementById('ai-fab'), // 하단바 오른쪽 끝의 AI 단추
  memoFab: document.getElementById('memo-fab'), // 그 왼쪽의 퀵메모 단추
  portFab: document.getElementById('port-fab'), // 그 왼쪽의 포트 전달 단추
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
/* --------------------- 끌어다 놓은 파일 · 붙여넣은 그림 --------------------- */

/*
 * Claude Code 는 서버에서 돌아가므로 내 PC 의 경로를 그대로 넣어 봐야 못 읽는다.
 * 그래서 파일을 서버로 올린 다음 "서버 경로" 를 프롬프트에 적어 준다.
 * (경로만 있으면 Claude Code 는 이미지도 읽는다)
 */

/** 이 판이 속한 그룹의 접속 정보 (SFTP 를 열 때 쓴다) */
function connectOf(leaf) {
  const g = state.groups.find((x) => x.id === leaf.groupId);
  if (!g) return null;
  return g.connect || { hostId: g.host.id || null, credId: g.credId };
}

/** 올린 경로들을 터미널에 적어 준다 (따옴표로 감싸 공백이 있어도 한 덩이가 되게) */
function typePathsIntoTerminal(leaf, files) {
  if (!files.length || !leaf.sessionId || leaf.status !== 'ready') return;
  const quoted = files.map((f) => (/[^\w./\-가-힣]/.test(f.remote) ? `'${f.remote.replace(/'/g, "'\\''")}'` : f.remote));
  api.ssh.write(leaf.sessionId, `${quoted.join(' ')} `);
  leaf.term.focus();
}

/** 내 PC 파일들을 서버로 올리고 경로를 적어 준다 */
async function dropFilesIntoTerminal(leaf, paths) {
  const connect = connectOf(leaf);
  if (!connect || !leaf.sessionId || leaf.status !== 'ready') return;
  el.statusLeft.textContent = `파일 ${paths.length}개를 서버로 올리는 중…`;
  const res = await api.drop.upload(leaf.sessionId, connect, paths);
  if (res.error || !res.files.length) {
    el.statusLeft.textContent = `올리지 못했습니다: ${res.error || '올릴 파일이 없습니다'}`;
    return;
  }
  typePathsIntoTerminal(leaf, res.files);
  el.statusLeft.textContent = `${res.files.map((f) => f.name).join(', ')} → ${res.dir} (한 시간 뒤 자동 삭제)`;
}

/** 클립보드 그림을 서버로 올리고 경로를 적어 준다. 그림이 없으면 false */
async function pasteImageIntoTerminal(leaf) {
  const connect = connectOf(leaf);
  if (!connect || !leaf.sessionId || leaf.status !== 'ready') return false;
  const res = await api.drop.pasteImage(leaf.sessionId, connect);
  if (!res.hasImage) return false;
  if (res.error || !res.files || !res.files.length) {
    el.statusLeft.textContent = `그림을 올리지 못했습니다: ${res.error || '알 수 없는 이유'}`;
    return true; // 그림이긴 했으므로 글자 붙여넣기로 넘기지 않는다
  }
  typePathsIntoTerminal(leaf, res.files);
  el.statusLeft.textContent = `스크린샷 → ${res.files[0].remote} (한 시간 뒤 자동 삭제)`;
  return true;
}

/** 드롭 이벤트에서 내 PC 파일 경로들을 뽑는다 */
function localPathsFrom(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  return files.map((f) => api.util.pathForFile(f)).filter(Boolean);
}

/** 이 드롭이 "OS 에서 끌어온 파일" 인가 (판 이동 드래그와 구분) */
const isFileDrop = (e) =>
  Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).includes('Files');

/* ------------------------------ 터미널 안의 링크 ------------------------------ */

/*
 * 여러 줄에 걸쳐 잘린 URL 도 하나로 이어서 연다.
 *
 * xterm 기본 애드온은 "터미널이 스스로 접은 줄"(isWrapped) 만 이어 붙인다.
 * 그런데 codex·gh 같은 TUI 는 긴 URL 을 자기가 직접 잘라서 여러 줄에 그리기
 * 때문에 각 줄이 서로 남남인 줄로 남는다. 그래서 링크를 클릭하면 첫 줄 조각만
 * 열려 "없는 주소" 가 됐다. 여기서는 그런 줄도 이어 붙인다:
 *   "글자가 맨 끝 칸까지 꽉 찬 줄" + "공백 없이 바로 이어지는 다음 줄" = 한 줄
 */

// xterm 기본 애드온과 같은 규칙 (끝의 문장부호는 링크에서 뺀다)
const TERM_URL_RE = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/g;
/*
 * 이어 붙일 수 있는 최대 줄 수 / 글자 수.
 * OAuth 링크는 토큰이 들어가면 수천 자가 되기도 한다(98칸으로 자르면 수십 줄).
 * 길이 때문에 링크가 잘리는 일이 없도록 넉넉히 두되, 마우스를 올릴 때마다 도는
 * 검사이므로 글자 수로 상한을 걸어 둔다.
 */
const MAX_JOIN_ROWS = 120;
const MAX_JOIN_CHARS = 12000;

/** 주소가 진짜 URL 인지 (애드온과 같은 검사) */
function isRealUrl(text) {
  try {
    const u = new URL(text);
    const origin = u.password && u.username
      ? `${u.protocol}//${u.username}:${u.password}@${u.host}`
      : u.username
        ? `${u.protocol}//${u.username}@${u.host}`
        : `${u.protocol}//${u.host}`;
    return text.toLocaleLowerCase().startsWith(origin.toLocaleLowerCase());
  } catch (e) {
    return false;
  }
}

// URL 에 쓰일 수 있는 글자
const URL_CHAR_RE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
// "기계가 자른 줄" 로 볼 최소 폭. 사람이 쓴 글이 우연히 여기에 걸리지 않을 만큼 길다.
const MIN_WRAP = 40;

/**
 * 버퍼 한 줄을 글자 단위로 편다.
 * 넓은 글자(한글 등)는 두 칸을 차지하므로 뒤칸(width 0)은 건너뛰고,
 * 글자마다 실제 칸 번호(col)를 같이 들고 다녀야 링크 위치가 어긋나지 않는다.
 */
function rowInfo(term, row) {
  const line = term.buffer.active.getLine(row);
  if (!line) return null;
  const cells = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    for (const ch of chars) cells.push({ ch, col: x });
  }
  let end = cells.length;
  while (end > 0 && cells[end - 1].ch === ' ') end--; // 오른쪽 공백은 버린다
  let first = 0;
  while (first < end && cells[first].ch === ' ') first++;
  const body = cells.slice(first, end);
  return {
    cells: cells.slice(0, end), // 앞쪽 공백은 칸 번호를 지키려고 남겨 둔다
    text: body.map((c) => c.ch).join(''),
    startCol: body.length ? body[0].col : -1,
    wrapped: Boolean(line.isWrapped)
  };
}

/** 이 줄이 "윗줄에서 잘려 넘어온 조각" 처럼 보이는가 */
function looksLikeContinuation(info) {
  if (!info || !info.text) return false;
  if (info.startCol !== 0) return false; // 이어지는 조각은 왼쪽 끝에서 시작한다
  if (/\s/.test(info.text)) return false; // 잘린 URL 조각에는 공백이 없다
  if (/^https?:\/\//i.test(info.text)) return false; // 새 URL 의 시작이면 남남이다
  return URL_CHAR_RE.test(info.text[0]);
}

/** 윗줄이 "여기서 잘렸다" 고 볼 만한가 (충분히 길고 URL 글자로 끝난다) */
function looksCut(info) {
  return Boolean(
    info && info.text.length >= MIN_WRAP && URL_CHAR_RE.test(info.text[info.text.length - 1])
  );
}

/** 마지막 조각(앞 줄보다 짧은 꼬리)이 URL 꼬리처럼 보이는가 */
function looksLikeUrlTail(text) {
  return /[%&=?]/.test(text) || (text.includes('/') && text.length >= 16);
}

/*
 * row 가 속한 "원래 한 줄" 을 글자 배열로 만든다 ({ch,row,col}).
 *
 * 두 가지 방식으로 잘린 줄을 모두 이어 붙인다.
 *   1) 터미널이 접은 줄(isWrapped) — xterm 이 알려 준다.
 *   2) 프로그램이 직접 자른 줄 — codex 같은 TUI 는 터미널 폭과 무관하게 자기
 *      폭(예: 98칸)으로 URL 을 잘라 여러 줄에 그린다. 이때 각 줄은 서로 남남인
 *      줄로 남아서, 예전에는 첫 줄만 링크로 잡혀 "없는 주소" 가 열렸다.
 *      → "같은 길이로 이어지는 줄" 을 기계가 자른 흔적으로 보고 이어 붙인다.
 *        폭이 정해지면 그 폭인 줄을 계속 잇고, 마지막에 그보다 짧은 꼬리 한 줄을
 *        더 붙인다. (첫 줄만 짧을 수 있어 폭은 뒤쪽 두 줄에서도 찾는다)
 */
function logicalRowGlyphs(term, row) {
  const buf = term.buffer.active;
  const info = (r) => (r >= 0 && r < buf.length ? rowInfo(term, r) : null);

  // 1) 위로 — 잘려 넘어온 조각이면 그 위로 거슬러 올라간다
  let top = row;
  let budget = MAX_JOIN_CHARS;
  for (let i = 0; i < MAX_JOIN_ROWS && top > 0 && budget > 0; i++) {
    const cur = info(top);
    const up = info(top - 1);
    if (!cur || !up) break;
    if (cur.wrapped) {
      budget -= cur.text.length;
      top--;
      continue;
    }
    if (looksLikeContinuation(cur) && looksCut(up)) {
      budget -= cur.text.length;
      top--;
      continue;
    }
    break;
  }

  // 2) 아래로 — 폭을 정해 가며 이어 붙인다
  const rows = [top];
  let width = null; // 기계가 자른 폭 (정해지면 그 폭인 줄만 잇는다)
  let cur = top;
  budget = MAX_JOIN_CHARS;
  for (let i = 0; i < MAX_JOIN_ROWS && budget > 0; i++) {
    const ci = info(cur);
    const ni = info(cur + 1);
    if (!ci || !ni) break;
    if (ni.wrapped) {
      rows.push(cur + 1);
      cur += 1;
      budget -= ni.text.length;
      continue;
    }
    if (!looksLikeContinuation(ni) || !looksCut(ci)) break;

    const Ln = ni.text.length;
    const Lc = ci.text.length;
    if (width === null) {
      const after = info(cur + 2);
      if (Lc === Ln && Ln >= MIN_WRAP) {
        width = Ln; // 같은 폭이 이어진다 = 기계가 자른 줄
      } else if (
        after && !after.wrapped && looksLikeContinuation(after) &&
        after.text.length === Ln && Ln >= MIN_WRAP
      ) {
        width = Ln; // 첫 줄만 짧은 경우(앞에 다른 글자가 있었다)
      } else if (Ln < Lc && looksLikeUrlTail(ni.text)) {
        rows.push(cur + 1); // 두 줄짜리 — 꼬리 하나만 더 붙이고 끝
        break;
      } else {
        break;
      }
    } else if (Ln !== width) {
      if (Ln < width && looksLikeUrlTail(ni.text)) rows.push(cur + 1); // 마지막 꼬리
      break;
    }
    rows.push(cur + 1);
    cur += 1;
    budget -= Ln;
  }

  const out = [];
  for (const r of rows) {
    const gi = info(r);
    if (!gi) continue;
    for (const c of gi.cells) out.push({ ch: c.ch, row: r, col: c.col });
  }
  return out;
}

/** xterm 의 링크 제공자 (registerLinkProvider 용) */
function makeUrlLinkProvider(term, onActivate) {
  return {
    provideLinks(y, callback) {
      const row = y - 1; // y 는 1부터 세는 버퍼 줄 번호
      const glyphs = logicalRowGlyphs(term, row);
      if (!glyphs.length) return callback(undefined);

      const text = glyphs.map((g) => g.ch).join('');
      const links = [];
      TERM_URL_RE.lastIndex = 0;
      let m;
      while ((m = TERM_URL_RE.exec(text))) {
        const a = m.index;
        const b = a + m[0].length - 1;
        if (b >= glyphs.length) break;
        // 지금 마우스가 있는 줄을 지나는 링크만 돌려준다
        if (glyphs[a].row > row || glyphs[b].row < row) continue;
        if (!isRealUrl(m[0])) continue;
        links.push({
          range: {
            start: { x: glyphs[a].col + 1, y: glyphs[a].row + 1 },
            end: { x: glyphs[b].col + 1, y: glyphs[b].row + 1 }
          },
          text: m[0],
          activate: (ev, uri) => onActivate(uri)
        });
      }
      callback(links.length ? links : undefined);
    }
  };
}

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
    wasThinking: false, // 직전 검사에서 Claude 가 작업 중이었는지 (완료 알림 판정용)
    lastOutputAt: 0,
    /*
     * 판 상태 관찰기(paneprobe)와 훅이 함께 쓰는 자리.
     *  probe     — 서버가 2초마다 알려 주는 "지금 어떤 창에서 무엇이 돌고 있는지"
     *  hookByPane— tmux pane 이름표(%3) 별 Claude 훅 상태. tmux 밖은 '#direct'
     *  paneWas   — 창별 직전 판정('busy'|'idle'). 완료 전이를 잡는 데 쓴다
     *  busy      — 이 판 어딘가에서 뭔가 돌고 있는지 (탭의 스피너)
     */
    probe: null,
    probeAt: 0, // 관찰기 소식을 마지막으로 받은 시각
    screenBusyAt: 0, // 화면에서 에이전트 작업 상태줄을 마지막으로 본 시각
    hookByPane: Object.create(null),
    paneWas: Object.create(null),
    busy: false,
    mode: 'terminal', // 'terminal' | 'web' | 'file'
    web: null, // 웹 브라우저 화면 (웹으로 전환할 때 만든다)
    file: null, // 파일 뷰어 (파일을 열 때 만든다)
    notes: null, // 메모장 (이 판을 메모로 전환할 때 만든다)
    aichat: null, // AI 채팅 (이 판을 AI 채팅으로 전환할 때 만든다)
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
    fontFamily: prefs.fontFamily || FONT_STACK,
    fontSize: state.fontSize,
    theme: THEME,
    cursorBlink: prefs.cursorBlink,
    cursorStyle: prefs.cursorStyle,
    scrollback: prefs.scrollback,
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
    // 터미널 안의 링크 클릭 → 기본 브라우저로 연다.
    // 기본 애드온 대신 직접 만든 제공자를 쓴다 (여러 줄로 잘린 URL 을 잇기 위해).
    term.registerLinkProvider(makeUrlLinkProvider(term, (uri) => api.util.openExternal(uri)));
  } catch (e) {
    /* noop */
  }

  // OSC 6789: Claude Code 훅이 보내는 상태 신호(우리가 원격 settings.json 에 심는다).
  //   armux-status;<busy|idle|alert>;<pane 이름표>
  // 폴링으로는 Claude 의 "생각 중" 과 "입력 대기" 가 똑같이 보이므로, 그 구간만은
  // 이 신호가 정한다. 뒤에 붙는 pane 이름표(%3)로 tmux 창별로 따로 기억한다.
  // 여기서는 기록만 하고, 판정은 evaluatePanes() 한 곳에서만 한다.
  try {
    term.parser.registerOscHandler(6789, (data) => {
      const parts = String(data).split(';'); // "armux-status;<sig>;<pane>"
      if (parts[0] !== 'armux-status') return true;
      const sig = parts[1];
      if (sig !== 'busy' && sig !== 'idle' && sig !== 'alert') return true;
      // 이름표가 없으면(tmux 밖이거나 옛 버전 notify.sh) 하나뿐인 창으로 본다
      const pane = (parts[2] || '').trim() || DIRECT_PANE;
      leaf.hooksActive = true;
      leaf.hookAt = Date.now();
      leaf.hookByPane[pane] = sig;
      // 새 턴이 시작됐으면 이전 알림은 해제한다
      if (sig === 'busy') clearAlert(leaf);
      /*
       * "완료" 신호는 그 자체로 소식이다. 시작을 못 봤더라도 알린다 —
       * Codex 는 시작 이벤트가 아예 없어서, 전이(작업중→대기)만 기다리면
       * 초록 느낌표가 영영 안 뜬다.
       */
      if (sig === 'idle') {
        const info = leaf.probe && (leaf.probe.panes || []).find((x) => x.id === pane);
        const cur = activeLeaf();
        const watching = cur && cur.id === leaf.id && document.hasFocus() && !state.notesOpen;
        if (info && info.visible === false) {
          raiseAlert(leaf, true, false); // 안 보이는 tmux 창에서 끝났다
        } else if (!watching) {
          raiseAlert(leaf);
        }
        leaf.paneWas[pane] = 'idle'; // evaluatePanes 가 같은 일로 또 알리지 않게
      }
      // 화면 추측 폴백(evaluateActivity)이 쓰는 값도 계속 맞춰 준다
      leaf.wasThinking = sig === 'busy';
      leaf.thinkSeenAt = sig === 'busy' ? Date.now() : 0;
      evaluatePanes(leaf); // 관찰기 다음 틱을 기다리지 않고 곧바로 반영
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

  /*
   * 한글 입력에 대해 여기서는 아무것도 하지 않는다 — 일부러 그렇게 둔다.
   *
   * 한때 조합이 끝날 때마다 xterm 의 "숨은 입력칸" 을 비웠는데, 그것이 오히려
   * 글자를 먹었다. xterm 은 조합이 끝나면 setTimeout(0) 뒤에 그 입력칸의 값을
   * 잘라내서 보내고, 조합 중에 다른 키가 오면 그 자리에서 잘라내 보낸다.
   * 그 사이에 값을 비워 버리면
   *   - 잘라낼 것이 없어 방금 친 글자가 통째로 사라지고,
   *   - 길이가 줄어든 것으로 보여 지우기(DEL)가 대신 나가기도 한다.
   * 빠르게 치거나 조합 직후 스페이스를 누를 때 자주 걸렸다.
   *
   * 원래 잡으려던 것("너너너", "츠츠츠")의 진짜 원인은 따로 있었다. 우리가
   * 가로챈 ⌥←/⌘← 같은 키에 preventDefault 를 안 걸어서 브라우저가 그 입력칸의
   * 캐럿을 옮겨 버린 것이다. 그건 아래 send() 에서 preventDefault 로 막았다.
   * 캐럿이 움직이지 않으면 입력칸은 xterm 이 알아서 관리한다 — 건드리지 않는다.
   */

  // 터미널 커서 이동/삭제 단축키를 표준 시퀀스로 변환해 셸로 보낸다.
  // (mac 의 ⌘/⌥ 조합과 Alt+방향키를 iTerm/Terminal.app 과 같게 맞춘다)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    /*
     * IME(한글 등) 조합 중에는 우리 단축키 변환에 끼어들지 않고 xterm 에 넘긴다.
     *
     * 여기서 false 를 돌려주면 xterm 의 _keyDown 이 통째로 건너뛰어진다. 그러면
     * xterm 이 방향키에 걸어 주던 preventDefault 도 안 걸리고, 브라우저가 기본
     * 동작으로 "숨은 입력칸" 의 캐럿을 옮겨 버린다. 한글은 조합이 끝날 때 그
     * 입력칸의 일부를 잘라내서 보내는 방식이라, 캐럿이 어긋나면 새로 친 글자가
     * 아니라 버퍼에 남아 있던 옛 글자가 계속 나간다("서서서", "크크크").
     * 영어는 키에서 바로 바이트를 만들어 보내므로 멀쩡하다.
     */
    if (e.isComposing || e.keyCode === 229) return true;
    if (!leaf.sessionId || leaf.status !== 'ready') return true;
    const send = (seq) => {
      /*
       * 우리가 직접 처리하는 키는 브라우저 기본 동작도 우리가 막아야 한다.
       * xterm 은 커스텀 핸들러가 false 를 돌려주면 그냥 리턴만 하고
       * preventDefault 를 하지 않는다. 이게 빠져 있어서 ⌥←/⌘← 로 커서를 옮기면
       * 숨은 입력칸의 캐럿까지 같이 움직여 위와 같은 한글 깨짐이 났다.
       */
      e.preventDefault();
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

    /*
     * 우리도 xterm 도 처리하지 않는 "조합키 + 이동키" 는 기본 동작만 막는다.
     *
     * 이게 없으면 브라우저가 xterm 의 숨은 입력칸 캐럿을 옮겨 버리고, 한글은
     * 조합이 끝날 때 그 캐럿 자리를 기준으로 잘라내 보내므로 엉뚱한 옛 글자가
     * 나간다("너너너"). 맥의 ⌘↑/⌘↓(문서 처음·끝으로)가 대표적인데, 우리 손도
     * xterm 손도 닿지 않아 그대로 캐럿이 움직이고 있었다.
     *
     * 여기서는 막기만 하고(return true) 처리는 xterm 에 그대로 맡긴다.
     */
    const NAV = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete'];
    if ((e.metaKey || e.ctrlKey || e.altKey) && NAV.includes(e.key)) e.preventDefault();

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
    checkActivitySoon(); // 입력하면 화면이 바뀔 수 있으니 상태를 다시 본다
    if (leaf.sessionId && leaf.status === 'ready') {
      watchTmuxCommand(leaf, data); // 어떤 tmux 세션에 붙는지 기억해 둔다
      api.ssh.write(leaf.sessionId, data);
    } else if (leaf.status === 'waiting') {
      // 자동으로 다시 붙는 중 — Enter 는 "지금 바로 해 봐" 다
      if (data === '\r') retryNow(leaf);
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

  // 로컬 터미널: SSH 없이 이 PC 의 셸을 PTY 로 띄운다
  if (leaf.connect && leaf.connect.local) {
    render();
    try {
      const res = await api.ssh.spawnLocal({ cols: leaf.term.cols, rows: leaf.term.rows });
      leaf.sessionId = res.sessionId;
      sessionToLeaf.set(res.sessionId, leaf);
      render();
    } catch (err) {
      leaf.status = 'error';
      leaf.term.writeln(`\r\n\x1b[31m✖ 로컬 터미널 실패: ${String(err.message || err).replace(/^Error:\s*/, '')}\x1b[0m`);
      render();
    }
    return;
  }

  // 자동 재시도 중에는 같은 줄을 30초마다 쌓지 않는다
  if (!leaf.retry) leaf.term.writeln(`\x1b[90m→ ${h.username}@${h.host}:${h.port} 접속 중…\x1b[0m`);
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
    const msg = String(err.message || err).replace(/^Error:\s*/, '');
    // 재시도 중이라면 실패했다는 사실만 짧게 (같은 줄이 쌓이지 않게)
    if (!leaf.retry) leaf.term.writeln(`\r\n\x1b[31m✖ 접속 실패: ${msg}\x1b[0m`);
    if (isFatalConnectError(msg) || !beginRetry(leaf, `접속 실패: ${msg}`)) {
      cancelRetry(leaf);
      leaf.status = 'error';
      leaf.term.writeln('\x1b[90m  Enter 를 누르면 다시 시도합니다.\x1b[0m');
    }
    render();
  }
}

/** 종료/실패한 페인을 같은 정보로 재접속 (정보가 없으면 접속 창을 연다) */
function reconnect(leaf) {
  const conn = leaf.connect || {};
  if (!conn.local && !conn.hostId && !conn.credId && !conn.profile) {
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
  leaf.disposed = true;
  cancelRetry(leaf); // 예약된 자동 재접속도 함께 없앤다
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
  if (leaf.aichat) { try { leaf.aichat.dispose(); } catch (e) {} leaf.aichat = null; }
  if (leaf.explorer) { try { leaf.explorer.dispose(); } catch (e) {} leaf.explorer = null; }
  leaf.el.remove();
}

/* ------------------------------ 판을 웹으로 전환 ------------------------------ */

/**
 * 판을 터미널 ↔ 웹 브라우저로 전환한다.
 * 터미널은 없애지 않고 감춰 두므로, 돌아오면 SSH 세션이 그대로 살아 있다.
 */
function setLeafMode(leaf, mode, url, webExtra) {
  const body = leaf.el.querySelector('.pane-body');

  if (mode === 'web') {
    if (!leaf.web) {
      leaf.web = window.WebPane.create({
        url: url || null, // url 없으면 시작 화면(주소 입력 + 즐겨찾기)
        urls: webExtra && webExtra.urls, // 세션 복원: 탭 여러 개
        active: webExtra && webExtra.active,
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
  } else if (mode === 'ai') {
    // AI 채팅을 이 판 안에 띄운다. 실행 세션은 그룹에서 살아 있는 것을 빌려 쓴다.
    const grp = state.groups.find((g) => g.id === leaf.groupId);
    if (!leaf.aichat) {
      leaf.aichat = window.AiChat.create({
        hostLabel: grp ? grp.host.name : '',
        // 판 안 채팅은 그 판이 속한 서버에 매인다 (판을 옮길 일이 없다)
        getTarget: () => {
          const sid = leaf.sessionId || (grp ? anyReadySession(grp) : null);
          return sid ? { sessionId: sid, key: grp ? grp.id : 'pane', label: grp ? grp.host.name : '' } : null;
        },
        // 이 서버에 실제로 깔려 있는 AI 만 고를 수 있게 한다 (없으면 목록에 띄우지 않는다)
        getTools: () => (grp ? grp.aiTools : null),
        // 같은 서브탭의 다른 판들을 첨부 후보로 (자기 자신은 뺀다)
        getContextSources: () =>
          paneContextSources(
            grp && grp.tabs.find((t) => t.id === leaf.tabId),
            grp ? grp.host.name : '',
            leaf
          )
      });
      body.appendChild(leaf.aichat.el);
    }
    leaf.mode = 'ai';
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
        // 이 탐색기 판의 바로 오른쪽에 파일을 연다
        onOpenFile: (entry) =>
          openFileInPane(group, entry, () => leaf.explorer && leaf.explorer.sftpId, leaf)
      });
      body.appendChild(leaf.explorer.el);
    }
    leaf.mode = 'explorer';
  } else {
    leaf.mode = 'terminal';
    /*
     * 고르기 화면에서 웹·메모 등을 골랐던 판은 셸이 없다.
     * 나중에 터미널로 바꾸면 그때 붙여 준다(빈 검은 화면이 아니라).
     */
    if (!leaf.sessionId && leaf.status !== 'connecting' && leaf.status !== 'waiting') {
      const c = leaf.connect || {};
      if (c.local || c.hostId || c.credId || c.profile) startSession(leaf);
    }
  }

  // 터미널이 아닌 화면으로 옮기면 열려 있던 파일 뷰어는 정리
  if (leaf.mode !== 'terminal' && leaf.mode !== 'file' && leaf.file) {
    leaf.file.dispose();
    leaf.file = null;
  }
  applyPaneBody(leaf);

  renderPaneHeader(leaf);
  render();
  if (leaf.mode === 'launcher') leaf.launcher.focus();
  else if (leaf.mode === 'web') leaf.web.focus();
  else if (leaf.mode === 'ai') leaf.aichat.focus();
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
 * 탭에 붙는 표시는 두 가지뿐이다. (이벤트 방식 — cmux 와 같은 구조)
 *   1) Claude 가 확인을 기다림  → 초록 느낌표 (작업 완료를 안 보고 있었거나, 입력/권한 대기)
 *   2) 그 밖의 모든 경우        → 연결 상태 점
 * "작업 중" 스피너는 일부러 두지 않는다. 원격 터미널 너머의 프로세스 상태를
 * 지속적으로 정확히 아는 방법이 없어(끝 신호 유실 시 영원히 도는 버그가 반복됨),
 * 순간 이벤트(완료/주의)만 표시하는 쪽이 훨씬 견고하다.
 */
// Claude Code 가 "작업 중"일 때만 화면 하단에 나타나는 문구들
/**
 * 한 줄이 Claude 의 "작업 중" 라이브 상태줄인지 판별한다.
 * 상태줄은 "esc to interrupt" 와 함께 항상 스피너 말줄임표(…)나 진행 표시(초·토큰),
 * 또는 "ctrl+t" 힌트를 같은 줄에 달고 있다.
 * 대화 본문에 그냥 "(esc to interrupt)" 라는 말이 들어 있어도 이런 동반 표시가 없어 걸러진다.
 */

const SPINNER_GLYPHS = '✻✽✢✳✶✷✸✹✺·∗✱✲●○◦•∙◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷';

/**
 * 에이전트가 "작업 중" 이라고 그려 놓은 라이브 상태줄인가.
 *
 *   Claude — "✻ … (esc to interrupt)"
 *   Codex  — "◦ Working (3s • esc to interrupt)"   앞 글리프가 프레임마다 바뀐다
 *
 * 대화 본문에 같은 문구가 있어도 줄 맨 앞이 글자면 걸러진다. Codex 는 글리프
 * 집합이 판마다 다를 수 있어 "Working (" 문구로도 받아 준다.
 */
function isAgentWorkingLine(line) {
  if (!/esc to interrupt/i.test(line)) return false;
  const t = line.trimStart();
  const first = t[0];
  if (first && SPINNER_GLYPHS.includes(first)) return true;
  return /^\S?\s*Working\s*\(/.test(t);
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
/* ---------------------------- 앱 밖 알림 · 절전 복구 ---------------------------- */

/*
 * 켬/끔 설정. 앱 안 초록 느낌표와 별개로, 창이 가려져 있을 때 OS 알림을
 * 보낼지 / 절전에서 깨면 자동으로 다시 붙을지 / 그때 tmux 에 다시 붙을지.
 */
const OPT_KEYS = ['notifyOs', 'autoReconnect', 'tmuxReattach'];
const opts = {
  notifyOs: localStorage.getItem('opt.notifyOs') !== '0',
  autoReconnect: localStorage.getItem('opt.autoReconnect') !== '0',
  tmuxReattach: localStorage.getItem('opt.tmuxReattach') !== '0'
};
function setOption(key, on) {
  if (!OPT_KEYS.includes(key)) return;
  opts[key] = Boolean(on);
  localStorage.setItem(`opt.${key}`, opts[key] ? '1' : '0');
  api.settings.sync(opts);
  if (!opts.notifyOs) api.notify.badge(0);
  else syncBadge();
}
api.settings.sync(opts); // 시작할 때 시스템 메뉴 체크 표시를 맞춘다

/* ---------------------------------- 설정 ---------------------------------- */
/*
 * 위의 opts 세 가지는 시스템 메뉴의 체크 표시와 묶여 있어 그대로 둔다.
 * 그 밖의 설정은 여기 prefs 에 모으고, 설정 창(정보 ▸ 설정)에서 바꾼다.
 */
const PREF_DEFAULTS = {
  cursorBlink: true,
  cursorStyle: 'block', // block | bar | underline
  scrollback: 10000,
  fontFamily: '', // 비우면 기본 글꼴
  swapTabKeys: false, // 메인탭 ↔ 서브탭 번호 단축키 바꾸기
  /*
   * 연결이 끊겼을 때 스스로 다시 붙을지. 기본은 끔.
   *
   * 켜면 판을 죽이지 않고 기다렸다가 연결이 돌아오면 알아서 다시 붙는다. 다만
   * 다시 붙는 것은 "새 셸" 이라, 하던 작업이 tmux 안이 아니었다면 이어지지 않는다.
   * 끄면 예전처럼 끊긴 자리에 그대로 두고 Enter 를 눌러야 다시 붙는다.
   *
   * 이것과 별개로, 잠깐 끊긴 정도(10분 이내)는 SSH keepalive 가 버텨 주므로
   * 애초에 끊기지 않고 하던 셸이 그대로 이어진다. 여기 설정과 무관하다.
   */
  reconnectOnDrop: false
};

const prefs = (() => {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('prefs') || '{}') || {};
  } catch (e) {
    /* 깨진 값이면 기본값으로 */
  }
  const out = { ...PREF_DEFAULTS };
  for (const k of Object.keys(PREF_DEFAULTS)) {
    if (saved[k] !== undefined && typeof saved[k] === typeof PREF_DEFAULTS[k]) out[k] = saved[k];
  }
  return out;
})();

function savePrefs() {
  localStorage.setItem('prefs', JSON.stringify(prefs));
}

function setPref(key, value) {
  if (!(key in PREF_DEFAULTS)) return;
  prefs[key] = value;
  savePrefs();
  if (key === 'swapTabKeys') renderSettings();
  else applyTermPrefs();
}

/** 커서·스크롤백·글꼴을 열려 있는 모든 터미널에 반영한다 */
function applyTermPrefs() {
  for (const g of state.groups) {
    for (const t of g.tabs) {
      for (const l of leavesOf(t.root)) {
        if (!l.term) continue;
        l.term.options.cursorBlink = prefs.cursorBlink;
        l.term.options.cursorStyle = prefs.cursorStyle;
        l.term.options.scrollback = prefs.scrollback;
        l.term.options.fontFamily = prefs.fontFamily || FONT_STACK;
      }
    }
  }
  fitTab(activeTab());
}

/* ------------------------------- 단축키 ------------------------------- */
/*
 * 단축키는 한곳에 모아 두고, 사용자가 바꾼 것은 keybinds 에 저장한다.
 *
 * 맥에서는 시스템 메뉴가 같은 키를 먼저 가져가므로, 바꾼 내용을 메인 프로세스에도
 * 보내 메뉴의 가속기를 다시 세워야 한다. 그렇지 않으면 예전 키가 계속 살아 있다.
 */
const KEY_ACTIONS = [
  { id: 'newGroup', label: '새 메인탭 (새 접속)', def: 'Mod+KeyN' },
  { id: 'newTab', label: '새 서브탭', def: 'Mod+KeyT' },
  { id: 'splitRow', label: '좌우로 분할', def: isMacPlatform ? 'Mod+KeyD' : 'Mod+Shift+KeyD' },
  { id: 'splitCol', label: '위아래로 분할', def: isMacPlatform ? 'Mod+Shift+KeyD' : 'Mod+Shift+KeyE' },
  { id: 'closePane', label: '현재 창 닫기', def: 'Mod+KeyW' },
  { id: 'find', label: '화면 내 검색', def: 'Mod+KeyF' },
  { id: 'explorer', label: '파일 탐색기', def: 'Mod+Backquote' },
  { id: 'notes', label: '메모장', def: isMacPlatform ? 'Mod+Ctrl+Backquote' : 'Mod+Alt+Backquote' },
  { id: 'ai', label: 'AI 채팅', def: 'Mod+KeyK' },
  { id: 'memo', label: '퀵메모', def: 'Mod+KeyM' }
];

let keybinds = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('keybinds') || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
})();

const keyDef = (id) => (KEY_ACTIONS.find((a) => a.id === id) || {}).def || '';
const keyOf = (id) => keybinds[id] || keyDef(id);

/** 키 이벤트를 'Mod+Shift+KeyD' 같은 문자열로 */
function accelFromEvent(e) {
  const parts = [];
  if (hasMod(e)) parts.push('Mod');
  if (isMacPlatform && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(e.code);
  return parts.join('+');
}

/** 사람이 읽는 표기 */
function accelLabel(accel) {
  if (!accel) return '';
  const mac = isMacPlatform;
  return accel
    .split('+')
    .map((p) => {
      if (p === 'Mod') return mac ? '⌘' : 'Ctrl';
      if (p === 'Ctrl') return mac ? '⌃' : 'Ctrl';
      if (p === 'Alt') return mac ? '⌥' : 'Alt';
      if (p === 'Shift') return mac ? '⇧' : 'Shift';
      if (p.startsWith('Key')) return p.slice(3);
      if (p.startsWith('Digit')) return p.slice(5);
      if (p === 'Backquote') return '`';
      if (p === 'Minus') return '-';
      if (p === 'Equal') return '=';
      return p;
    })
    .join(mac ? '' : '+');
}

/** 우리 표기 → Electron 메뉴 가속기 */
function toElectronAccel(accel) {
  const parts = accel.split('+');
  const key = parts.pop();
  const mods = parts
    .map((p) => (p === 'Mod' ? 'CmdOrCtrl' : p === 'Ctrl' ? 'Control' : p))
    .join('+');
  let k = key;
  if (k.startsWith('Key')) k = k.slice(3);
  else if (k.startsWith('Digit')) k = k.slice(5);
  else if (k === 'Backquote') k = '`';
  else if (k === 'Minus') k = '-';
  else if (k === 'Equal') k = '=';
  return mods ? `${mods}+${k}` : k;
}

/** 지금 눌린 키가 어떤 동작인지 (없으면 null) */
function actionForEvent(e) {
  const accel = accelFromEvent(e);
  for (const a of KEY_ACTIONS) if (keyOf(a.id) === accel) return a.id;
  return null;
}

function runAction(id) {
  const g = activeGroup();
  const l = activeLeaf();
  switch (id) {
    case 'newGroup':
      openConnectDialog({});
      break;
    case 'newTab':
      if (g) addSubTab(g);
      else openConnectDialog({});
      break;
    case 'splitRow':
      splitActive('row');
      break;
    case 'splitCol':
      splitActive('col');
      break;
    case 'closePane':
      if (g && g.explorerSelected && !g.explorerPinned) leaveExplorer(g);
      else if (l && l.mode === 'file') {
        const t = g && g.tabs.find((x) => x.id === l.tabId);
        if (t) closeFilePane(g, t, l);
      } else if (l) closeLeaf(l);
      break;
    case 'find':
      openFind();
      break;
    case 'explorer':
      if (state.notesOpen) closeNotes();
      if (g) toggleExplorerView(g);
      break;
    case 'notes':
      toggleNotes();
      break;
    case 'ai':
      toggleAiPop();
      break;
    case 'memo':
      toggleQuickMemo();
      break;
    default:
      break;
  }
}

/** 바뀐 단축키를 메인 프로세스에 알려 시스템 메뉴 가속기를 다시 세운다 */
function syncKeybinds() {
  const map = {};
  for (const a of KEY_ACTIONS) map[a.id] = toElectronAccel(keyOf(a.id));
  api.settings.keybinds(map);
}

function setKeybind(id, accel) {
  if (accel) keybinds[id] = accel;
  else delete keybinds[id];
  localStorage.setItem('keybinds', JSON.stringify(keybinds));
  syncKeybinds();
  renderSettings();
}


/** 지금 확인이 필요한 판의 개수를 독 배지/작업표시줄에 알린다 */
function syncBadge() {
  let n = 0;
  for (const g of state.groups) {
    for (const t of g.tabs) {
      for (const l of leavesOf(t.root)) if (l.alert) n++;
    }
  }
  api.notify.badge(opts.notifyOs ? n : 0);
}

/**
 * 창이 가려져 있을 때만 OS 알림을 띄운다.
 * 지금 그 판을 보고 있으면 화면의 느낌표로 충분하므로 보내지 않는다.
 */
function notifyOutside(leaf, needsInput) {
  if (!opts.notifyOs) return;
  const cur = activeLeaf();
  const looking = document.hasFocus() && cur && cur.id === leaf.id && !state.notesOpen;
  if (looking) return;

  const group = state.groups.find((g) => g.id === leaf.groupId);
  const where = `${group ? group.host.name : ''}${leaf.title ? ` · ${leaf.title}` : ''}`;
  api.notify.alert({
    leafId: leaf.id,
    title: needsInput ? '입력을 기다리고 있습니다' : '작업이 끝났습니다',
    body: where || 'Armux'
  });
}

/** 알림을 눌렀을 때 그 판으로 이동 */
api.notify.onJump(({ leafId }) => {
  for (const g of state.groups) {
    for (const t of g.tabs) {
      const leaf = leavesOf(t.root).find((l) => l.id === leafId);
      if (leaf) {
        state.activeGroupId = g.id;
        g.activeTabId = t.id;
        if (state.notesOpen) closeNotes();
        focusLeaf(leaf);
        return;
      }
    }
  }
});

/* --------------------------- 끊겨도 죽지 않고 스스로 다시 붙기 --------------------------- */
/*
 * 인터넷이 잠깐 끊겼다고 판을 죽이지 않는다.
 *
 * 먼저 알아 둘 것: SSH 는 TCP 위에서만 산다. 그 TCP 가 죽으면 서버 쪽 셸도
 * 같이 죽으므로, 끊긴 뒤에 "그 셸을 이어서" 쓰는 방법은 프로토콜에 없다.
 * 그래서 두 겹으로 막는다.
 *
 *  1) 잠깐 끊긴 것으로는 아예 죽지 않게 한다.
 *     막힌 동안 오가지 못한 것은 TCP 가 알아서 다시 보내므로, 연결을 살아 있는
 *     것으로 봐 주는 시간(sshconfig.js 의 keepalive)만 넉넉하면 인터넷이
 *     돌아왔을 때 하던 작업이 그대로 이어진다. 재접속이 아니라 진짜 같은 세션이다.
 *
 *  2) 그래도 끊어졌으면, Enter 를 기다리지 않고 스스로 다시 붙는다.
 *     붙고 나면 끊기기 전에 보고 있던 tmux 세션으로 돌려놓는다. 서버의 tmux 는
 *     살아 있으므로 화면과 돌아가던 명령이 그대로 돌아온다.
 *
 * 사용자가 exit 를 쳐서 끝난 것(clean)에는 다시 붙지 않는다 — 판을 닫을 수가
 * 없어진다.
 */
const RETRY_STEPS = [2000, 4000, 8000, 15000, 30000]; // 마지막 값으로 계속 간다
const RETRY_GIVEUP_MS = 30 * 60 * 1000; // 30분 동안 안 되면 그만둔다

/** 다시 해 봐야 똑같은 오류 (틀린 열쇠로 계속 두드리지 않는다) */
function isFatalConnectError(message, code) {
  const m = String(message || '');
  if (code === 'client-authentication') return true;
  return /authentication methods failed|Permission denied|host key|Host key/i.test(m);
}

/** 이 판을 자동으로 다시 붙일 수 있는가 (붙을 정보가 있는 SSH 판인가) */
function canRetry(leaf) {
  if (!prefs.reconnectOnDrop || leaf.disposed) return false;
  const c = leaf.connect || {};
  if (c.local) return false; // 로컬 셸이 끝난 것은 사용자가 끝낸 것이다
  return Boolean(c.hostId || c.credId || c.profile);
}

/**
 * 자동 재접속 시작(또는 다음 시도 예약).
 * @returns {boolean} 맡았으면 true — 부르는 쪽은 "끊김" 안내를 따로 쓰지 않는다
 */
function beginRetry(leaf, why) {
  if (!canRetry(leaf)) return false;

  if (!leaf.retry) {
    leaf.retry = { attempt: 0, since: Date.now(), timer: null };
    leaf.term.writeln(`\r\n\x1b[33m● ${why} — 연결이 돌아오면 자동으로 다시 붙습니다.\x1b[0m`);
  }
  if (leaf.retry.timer) return true; // 이미 예약되어 있다

  // 끊기기 전에 tmux 안이었다면 다시 붙을 때 그 세션으로 돌려놓는다
  leaf.reattachTmux = opts.tmuxReattach && Boolean(leaf.tmuxSession || leaf.wasTmux);
  leaf.status = 'waiting';
  scheduleRetry(leaf);
  return true;
}

function scheduleRetry(leaf) {
  const r = leaf.retry;
  if (!r) return;
  if (Date.now() - r.since > RETRY_GIVEUP_MS) return giveUpRetry(leaf);
  const wait = RETRY_STEPS[Math.min(r.attempt, RETRY_STEPS.length - 1)];
  r.attempt += 1;
  r.timer = setTimeout(() => runRetry(leaf), wait);
  leaf.term.writeln(`\x1b[90m  ${Math.round(wait / 1000)}초 뒤 다시 시도합니다. (Enter 를 누르면 지금 바로)\x1b[0m`);
}

function runRetry(leaf) {
  const r = leaf.retry;
  if (!r) return;
  r.timer = null;
  if (leaf.disposed || !canRetry(leaf)) return cancelRetry(leaf);
  /*
   * 인터넷 자체가 없는 동안에는 헛되이 두드리지 않는다.
   * (돌아오면 online 이벤트가 곧바로 깨운다 — 여기서는 짧게만 다시 본다)
   */
  if (navigator.onLine === false) {
    r.timer = setTimeout(() => runRetry(leaf), 3000);
    return;
  }
  startSession(leaf); // 성공하면 onReady 가, 실패하면 startSession 이 다음 시도를 잡는다
}

/** 지금 바로 한 번 더 (Enter, 또는 인터넷이 돌아왔을 때) */
function retryNow(leaf) {
  const r = leaf.retry;
  if (!r) return false;
  if (leaf.status === 'connecting') return false; // 이미 붙는 중이면 겹쳐서 붙지 않는다
  if (r.timer) {
    clearTimeout(r.timer);
    r.timer = null;
  }
  r.attempt = 0; // 사람이 눌렀거나 인터넷이 돌아왔으면 처음부터 짧게
  runRetry(leaf);
  return true;
}

function cancelRetry(leaf) {
  if (!leaf.retry) return;
  if (leaf.retry.timer) clearTimeout(leaf.retry.timer);
  leaf.retry = null;
}

function giveUpRetry(leaf) {
  cancelRetry(leaf);
  leaf.status = 'error';
  leaf.term.writeln('\x1b[90m● 자동 재접속을 그만둡니다. Enter 를 누르면 다시 시도합니다.\x1b[0m');
  render();
}

/** 기다리는 중인 판 모두 지금 다시 붙여 본다 */
function retryAllWaiting() {
  for (const g of state.groups) {
    for (const t of g.tabs) {
      for (const l of leavesOf(t.root)) {
        if (l.retry) retryNow(l);
      }
    }
  }
}

/*
 * 인터넷이 끊기고 붙는 것을 알려 준다.
 * 끊겼다고 세션을 건드리지는 않는다 — 대개는 그대로 살아남고, 진짜 끊어졌으면
 * 위의 재시도가 알아서 맡는다.
 */
window.addEventListener('offline', () => {
  el.statusLeft.textContent = '인터넷이 끊겼습니다 — 연결을 유지한 채 기다리는 중…';
});

/*
 * 절전에서 깨면 SSH 는 대개 끊겨 있다. 끊긴 판을 순서대로 다시 붙인다.
 * 한꺼번에 붙으면 서버가 동시 접속을 거절할 수 있어 조금씩 띄운다.
 */
let reconnectingAll = false;
function reconnectDeadPanes(reason) {
  if (!opts.autoReconnect || reconnectingAll) return;
  const dead = [];
  for (const g of state.groups) {
    for (const t of g.tabs) {
      for (const l of leavesOf(t.root)) {
        if (l.status !== 'closed' && l.status !== 'error') continue;
        const c = l.connect || {};
        if (!c.local && !c.hostId && !c.credId && !c.profile) continue; // 붙을 정보가 없다
        dead.push(l);
      }
    }
  }
  if (!dead.length) return;
  reconnectingAll = true;
  el.statusLeft.textContent = `${reason} — 끊긴 판 ${dead.length}개를 다시 붙이는 중…`;
  dead.forEach((leaf, i) => {
    setTimeout(() => {
      // 그 사이 사용자가 직접 붙였을 수도 있다
      if (leaf.status === 'closed' || leaf.status === 'error') {
        leaf.reattachTmux = opts.tmuxReattach && Boolean(leaf.tmuxSession || leaf.wasTmux);
        reconnect(leaf);
      }
      if (i === dead.length - 1) setTimeout(() => { reconnectingAll = false; }, 1500);
    }, i * 400);
  });
}

api.power.onResume(() => setTimeout(() => reconnectDeadPanes('절전에서 깨어남'), 1500));
window.addEventListener('online', () => {
  el.statusLeft.textContent = '인터넷이 돌아왔습니다.';
  retryAllWaiting(); // 기다리던 판은 곧바로 다시 붙여 본다
  setTimeout(() => reconnectDeadPanes('네트워크 복구'), 1500);
});

/**
 * @param {object} leaf
 * @param {boolean} force      보고 있는 판이어도 표시한다
 * @param {boolean} needsInput OS 알림 문구를 "입력 대기" 로 할지 "작업 끝남" 으로 할지
 *
 * force 가 필요한 경우가 두 가지다.
 *  1) 권한/입력 대기 — 보고 있어도 알려야 한다 (needsInput = true)
 *  2) tmux 의 안 보이는 창에서 끝났다 — 이 판을 보고 있어도 그 창은 못 봤다
 *     (needsInput = false. 문구는 "작업이 끝났습니다" 여야 한다)
 */
function raiseAlert(leaf, force, needsInput) {
  if (leaf.alert) return;
  // 보통은 지금 보고 있는 판이면 표시하지 않는다.
  if (!force) {
    const cur = activeLeaf();
    if (cur && cur.id === leaf.id && document.hasFocus()) return;
  }
  leaf.alert = true;
  notifyOutside(leaf, needsInput === undefined ? force : needsInput);
  syncBadge();
  scheduleRender();
}

function clearAlert(leaf) {
  if (!leaf || !leaf.alert) return;
  leaf.alert = false;
  syncBadge();
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
  if (changed) {
    syncBadge();
    scheduleRender();
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 판 상태 판정 — "이 창에서 지금 뭔가 돌고 있는가"
 *
 * 두 층을 합친다.
 *   아래층: 서버가 2초마다 알려 주는 관찰 결과(paneprobe) — tmux 의 모든 창에서
 *           무엇이 돌고 있는지, 어느 창이 보이는지
 *   위층 : Claude Code 훅(OSC 6789) — 폴링으로는 "생각 중" 과 "입력 대기" 가
 *           똑같이 `claude` 로만 보이므로 그 구간만 훅이 정한다
 * 위층이 이긴다.
 *
 * 판정 규칙
 *   1) 셸 이름이면            → 놀고 있음 (프롬프트가 떠 있다)
 *   2) 훅이 아는 창이면        → 훅이 정한다
 *   3) 전체화면 앱이면        → 판단하지 않는다 (vim·htop·중첩 ssh…)
 *   4) 인자 없는 REPL 이면    → 놀고 있음 (`python3` 혼자면 입력 대기)
 *   5) 그 밖에는              → 작업 중
 *
 * 모르는 것은 "작업 중" 이 아니라 "판단 안 함" 쪽으로 떨어뜨린다. 틀린 스피너보다
 * 틀린 완료 알림이 훨씬 나쁘기 때문이다(보러 갔는데 안 끝나 있다).
 * ────────────────────────────────────────────────────────────────────────── */

const DIRECT_PANE = '#direct'; // tmux 밖일 때 쓰는 가짜 pane 이름표

// 프롬프트를 띄우고 있는 셸 = 아무것도 안 돌고 있다 (로그인 셸은 '-bash' 로 나온다)
const CMD_SHELL = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'ash', 'login']);

// 상태를 훅이 알려 주는 것들. 이름만으로는 생각중/대기중을 가를 수 없다.
const CMD_AGENT = new Set(['claude', 'codex']);

// 오래 떠 있는 전체화면 앱·페이저. "돌고 있다" 고 표시해 봐야 의미가 없다.
const CMD_TUI = new Set([
  'vim', 'nvim', 'vi', 'emacs', 'nano', 'micro', 'helix', 'hx',
  'htop', 'top', 'btop', 'atop', 'glances', 'ncdu', 'iotop', 'nvtop',
  'less', 'more', 'most', 'pager', 'man', 'info', 'tig', 'lazygit', 'lazydocker',
  'ranger', 'mc', 'nnn', 'yazi',
  'ssh', 'mosh', 'telnet', 'tmux', 'screen', 'byobu',
  'ipython', 'ipython3', 'irb', 'psql', 'mysql', 'sqlite3', 'redis-cli', 'gdb', 'pdb', 'watch'
]);

/*
 * 화면에서 작업 상태줄을 본 뒤 이만큼은 "작업 중" 으로 본다. 한두 프레임 놓쳐도
 * 깜빡이지 않게 하려는 것이고, 시간이 지나면 저절로 풀리므로 갇히지 않는다.
 */
const SCREEN_BUSY_MS = 2500;

// 인자가 없으면 REPL(입력 대기)로 보는 것들. 인자가 있으면 스크립트 실행이다.
const CMD_REPL = new Set(['python', 'python2', 'python3', 'node', 'ruby', 'perl', 'php', 'lua', 'R', 'ghci', 'julia']);

/*
 * 다른 명령을 감싸 실행하는 것들. 이름만 보면 무엇을 하는지 알 수 없으므로
 * 뒤에 무엇이 오는지 본다. `sudo -i` 는 루트 셸(놀고 있음)이고
 * `sudo apt update` 는 실제 작업이다. 이걸 안 가르면 `sudo -i` 를 한 판은
 * 스피너가 영원히 켜져 있는다.
 */
const CMD_WRAP = new Set(['sudo', 'su', 'doas', 'nice', 'nohup', 'env', 'time', 'stdbuf', 'setsid']);

// -f 로 따라가는 것은 "작업" 이 아니라 "감시" 다 (tail -f 로 로그를 켜 두는 경우)
const CMD_FOLLOW = new Set(['tail', 'journalctl', 'multitail', 'docker', 'kubectl', 'dmesg']);
const FOLLOW_FLAGS = new Set(['-f', '-F', '--follow']);

// 실행할 거리가 실제로 붙어 있는가 (`python3 -u` 정도는 여전히 REPL 이다)
const BARE_FLAGS = new Set(['-i', '-u', '-q', '-B', '-E', '-s', '--']);

const baseName = (v) => String(v || '').split('/').pop();

const SHELL_FLAGS = new Set(['-i', '-s', '-l', '--login', '--shell']);

/** 래퍼(sudo 등) 뒤에 오는 것이 대화형 셸인가. `sudo su` 처럼 겹쳐 쓰는 경우도 따라간다. */
function wrapperIsShell(tok, depth = 0) {
  if (depth > 3) return false;
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    if (t.startsWith('-')) {
      if (SHELL_FLAGS.has(t)) return true; // 셸을 띄우는 대표 플래그들
      continue;
    }
    const b = baseName(t);
    if (CMD_SHELL.has(b)) return true;
    if (CMD_WRAP.has(b)) return wrapperIsShell(tok.slice(i), depth + 1); // sudo su, sudo -i su …
    return false; // 처음 나오는 진짜 명령이 셸이 아니면 실제 작업이다
  }
  return true; // 뒤에 아무것도 없으면 그냥 프롬프트(비밀번호 입력 등)
}

/**
 * 창 하나의 상태: 'busy' | 'idle' | 'alert'
 *
 * 관찰기는 세 가지를 준다.
 *   cmd   — tmux 가 말하는 포그라운드 명령 이름(프로세스 그룹 대표)
 *   argv  — 그 대표의 명령줄 전체
 *   chain — 대표부터 자식으로 내려간 이름들. 대표만으로는 모자란 경우가 있다.
 *             `git log`  → ['git', 'pager']        화면을 잡고 있는 건 페이저다
 *             `sudo -i`  → ['sudo','sudo','bash']  실제로는 루트 셸이다
 *             `sudo make`→ ['sudo','sudo','make']  이건 진짜 작업이다
 */
function classifyPane(leaf, pane) {
  const cmd = baseName(String(pane.cmd || '').replace(/^-/, '')); // 로그인 셸 '-bash' → 'bash'
  const tok = String(pane.argv || '').trim().split(/\s+/).filter(Boolean);
  const argv0 = baseName((tok[0] || '').replace(/^-/, ''));
  const chain = (Array.isArray(pane.chain) ? pane.chain : []).map((c) => baseName(String(c).replace(/^-/, '')));

  /*
   * sudo·nohup 처럼 감싸는 것들과, 그 아래 열린 셸을 걷어낸 "진짜 명령".
   *   ['sudo','sudo','bash']          → 남는 게 없다 → 마지막인 bash = 루트 프롬프트
   *   ['sudo','sudo','bash','sleep']  → sleep. 그 루트 셸 안에서 진짜로 돌고 있다
   *   ['make','sh']                   → make. 레시피 돌리려고 sh 를 띄운 것뿐이다
   *   ['claude','bash']               → claude. 에이전트가 도구를 부른 것뿐이다
   * 앞에서부터 처음 걸리는 것을 쓰므로, 중간에 셸이 끼어도 앞의 진짜 명령이 이긴다.
   * 사슬이 없으면(ps 폴백) 예전처럼 이름 두 개로만 본다.
   */
  const effective =
    chain.find((c) => !CMD_WRAP.has(c) && !CMD_SHELL.has(c)) ||
    chain[chain.length - 1] ||
    cmd ||
    argv0;
  const deepest = chain.length ? chain[chain.length - 1] : '';

  /*
   * 관찰기가 "이 터미널은 프롬프트만 떠 있다" 고 확실히 알려 준 경우.
   *
   * 그 터미널의 포그라운드 프로세스 그룹이 셸 자신인지로 판단한 것이라 이름을
   * 전혀 보지 않는다. 셸이 무엇이든(세션 녹화 래퍼가 감싸고 있어도) 통하고,
   * 래퍼가 새 pty 를 열었으면 그 안쪽까지 따라 들어가 본 결과다.
   */
  if (pane.idle) {
    delete leaf.hookByPane[pane.id];
    return 'idle';
  }

  /*
   * 셸 프롬프트가 떠 있다 = 아무것도 안 돌고 있다.
   * 이 창에 남아 있던 훅 상태는 낡은 것이므로 함께 지운다. Claude 가 Stop 훅을
   * 못 보내고 죽거나(크래시·kill) 그냥 종료해 버리면 'busy' 가 영영 남아서
   * 스피너가 안 꺼졌다. 프롬프트로 돌아왔다는 사실이 그보다 확실한 증거다.
   */
  if (CMD_SHELL.has(effective) || (!chain.length && argv0 && CMD_SHELL.has(argv0))) {
    delete leaf.hookByPane[pane.id];
    return 'idle';
  }

  const sig = leaf.hookByPane[pane.id];

  // 훅이 아는 창(Claude 계열)은 훅이 정한다. 이름이 무엇이든 상관없다 —
  // 신호가 온다는 사실 자체가 "여기는 에이전트" 라는 표시다.
  // (에이전트는 작업 중에 자식 셸을 띄우므로, 반드시 사슬 규칙보다 먼저 본다.)
  if (sig || CMD_AGENT.has(effective) || CMD_AGENT.has(cmd)) {
    if (sig === 'busy') return 'busy';
    if (sig === 'alert') return 'alert';
    /*
     * Codex 는 훅에 "시작" 이벤트가 없다 — 완료(agent-turn-complete)와
     * 승인 대기만 알려 준다. 그래서 "생각 중" 은 화면의 작업 상태줄로 본다.
     * 화면은 지금 보이는 창의 것이므로 안 보이는 tmux 창에는 쓸 수 없다.
     * 그쪽은 완료 신호만으로 초록 느낌표를 띄운다.
     */
    if (pane.visible !== false && leaf.screenBusyAt && Date.now() - leaf.screenBusyAt < SCREEN_BUSY_MS) {
      return 'busy';
    }
    return 'idle'; // 신호도 없고 화면도 조용하면 그냥 켜져만 있는 것이다
  }

  if (!cmd && !effective) return 'idle';
  /*
   * 사슬 맨 끝이 페이저·전체화면 앱이면 그것이 화면을 잡고 사람을 기다리는 중이다
   * (`git log` 의 pager). 끝이 셸인 경우는 여기서 보지 않는다 — `make` 가 레시피를
   * 돌리려고 `sh` 를 띄운 것까지 "놀고 있음" 으로 오해하면 안 되기 때문이다.
   */
  if (deepest && CMD_TUI.has(deepest)) return 'idle';
  if (CMD_TUI.has(effective) || CMD_TUI.has(cmd) || (argv0 && CMD_TUI.has(argv0))) return 'idle';
  // 사슬이 없을 때를 위한 예전 규칙 (인자만 보고 래퍼를 가른다)
  if (CMD_WRAP.has(effective)) return wrapperIsShell(tok) ? 'idle' : 'busy';
  if (CMD_FOLLOW.has(effective) && tok.some((t) => FOLLOW_FLAGS.has(t))) return 'idle';
  /*
   * 인자 없는 REPL. argv 의 실행 파일이 그 명령과 같을 때만 믿는다 — 파이프라인이면
   * argv 가 뒤쪽 명령을 가리켜서, 인자가 없어 보인다고 REPL 로 오해할 수 있다.
   * argv 를 아예 못 받아 온 서버에서는 낮추지 않는다. 확인되지 않은 것을
   * "놀고 있음" 으로 보면 완료 알림이 잘못 뜨기 때문이다.
   */
  if (CMD_REPL.has(effective) && argv0 === effective && !tok.slice(1).some((x) => !BARE_FLAGS.has(x))) {
    return 'idle';
  }
  return 'busy';
}

/**
 * 한 판의 모든 창을 보고 스피너/느낌표를 정한다.
 * 관찰기가 한 틱 돌 때마다, 그리고 훅 신호가 올 때마다 불린다.
 */
function evaluatePanes(leaf) {
  if (!leaf || leaf.mode !== 'terminal') return;

  const probe = leaf.probe;
  /*
   * 관찰기가 본 창 목록. "봤는데 아무것도 없었다"(빈 배열)와 "아직 못 봤다"(null)는
   * 다르게 다뤄야 한다.
   *   못 봤다   → 훅이 아는 창만으로 본다. 관찰기가 못 도는 환경에서도
   *               Claude 표시는 살아 있어야 하기 때문이다.
   *   봤는데 없다 → 그대로 "아무것도 없음". 여기서 훅 목록으로 넘어가면, 낡은
   *               훅 하나가 자기 자신을 계속 살려 내서 스피너가 안 꺼진다.
   *               (훅 기억은 지우지 않는다 — 창이 다시 보이면 살아나야 하므로)
   */
  const observed = probe ? probe.panes || [] : null;
  const panes =
    observed !== null
      ? observed
      : Object.keys(leaf.hookByPane).map((id) => ({ id, cmd: '', argv: '', visible: true }));

  const cur = activeLeaf();
  // 이 판을 실제로 사람이 보고 있는가 (창이 앞에 있고, 메모장에 가려져 있지 않고)
  const watchingLeaf = Boolean(cur && cur.id === leaf.id && document.hasFocus() && !state.notesOpen);

  let busy = false;
  for (const pane of panes) {
    const st = classifyPane(leaf, pane);
    if (st === 'busy') busy = true;
    const was = leaf.paneWas[pane.id];

    /*
     * 작업 중 → 놀고 있음 = 방금 끝났다.
     * 그 창을 눈으로 보고 있었다면 알리지 않는다. 눈앞에서 Ctrl+C 를 눌러도
     * 느낌표가 뜨면 성가시기만 하다. tmux 의 안 보이는 창에서 끝난 것만 알린다.
     */
    if (was === 'busy' && st === 'idle') {
      if (pane.visible === false) {
        // 안 보이는 tmux 창 — 이 판을 보고 있었더라도 사용자는 못 봤다
        raiseAlert(leaf, true, false);
      } else if (!watchingLeaf) {
        raiseAlert(leaf);
      }
    }
    // 권한/입력 대기는 보고 있어도 알린다
    if (st === 'alert' && was !== 'alert') raiseAlert(leaf, true, true);

    leaf.paneWas[pane.id] = st;
  }

  /*
   * 닫힌 tmux 창의 기억은 지운다 (남겨 두면 없는 창의 전이가 계속 걸린다).
   * 반드시 "실제로 관찰된 창 목록" 으로만 판단한다. 관찰 결과가 비었을 때
   * 쓰는 대체 목록(훅이 아는 창)으로 지우려 들면, 그 목록이 자기 자신을 살려
   * 두기 때문에 낡은 훅 상태가 영영 안 지워진다 — 스피너가 안 꺼진다.
   */
  if (observed && observed.length) {
    const alive = new Set(observed.map((p) => p.id));
    for (const id of Object.keys(leaf.paneWas)) if (!alive.has(id)) delete leaf.paneWas[id];
    for (const id of Object.keys(leaf.hookByPane)) {
      if (id !== DIRECT_PANE && !alive.has(id)) delete leaf.hookByPane[id];
    }
  }

  if (leaf.busy !== busy) {
    leaf.busy = busy;
    scheduleRender();
  }
}

/*
 * 관찰기가 조용해지면 표시를 내린다.
 *
 * 관찰기는 2초마다 소식을 보낸다. 그보다 한참 지나도 소식이 없으면 무언가
 * 잘못된 것이고(채널이 막혔거나 서버가 응답을 멈췄거나), 그때 마지막으로 받은
 * 값을 계속 믿으면 아무것도 안 하는 탭에 스피너가 영원히 돌아 있게 된다.
 * 모르면 표시하지 않는 쪽이 맞다. 소식이 돌아오면 다음 틱에 다시 켜진다.
 */
const PROBE_STALE_MS = 15000;

function dropStaleProbes() {
  const now = Date.now();
  for (const g of state.groups) {
    for (const t of g.tabs) {
      for (const leaf of leavesOf(t.root)) {
        if (!leaf.probe || !leaf.probeAt) continue;
        if (now - leaf.probeAt <= PROBE_STALE_MS) continue;
        leaf.probe = null;
        // 되살아났을 때 "방금 끝난 것" 으로 오해해 느낌표를 띄우지 않도록 함께 비운다
        leaf.paneWas = Object.create(null);
        if (leaf.busy) {
          leaf.busy = false;
          scheduleRender();
        }
      }
    }
  }
}

setInterval(dropStaleProbes, 5000);

/** 연결이 끊기면 관찰 결과는 버린다 (되살아난 뒤 옛 상태로 판정하지 않게) */
function resetPaneState(leaf) {
  if (!leaf) return;
  leaf.probe = null;
  leaf.probeAt = 0;
  leaf.hookByPane = Object.create(null);
  leaf.paneWas = Object.create(null);
  if (leaf.busy) {
    leaf.busy = false;
    scheduleRender();
  }
}

const tabBusy = (tab) => leavesOf(tab.root).some((l) => l.busy && l.status === 'ready');
const groupBusy = (group) => group.tabs.some(tabBusy);

const tabHasAlert = (tab) => leavesOf(tab.root).some((l) => l.alert);
const groupHasAlert = (group) =>
  group.tabs.some(tabHasAlert) || Boolean(group.aiUnread); // AI 답이 도착한 탭도 알린다

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

/*
 * AI 채팅에 붙일 수 있는 "이 서브탭의 판들" 목록.
 *
 * 판 안 채팅과 하단바 팝업이 같이 쓴다. 예전에는 두 벌로 복붙되어 있었고, 그
 * 사이에 팝업 쪽에만 "파일" 이 추가돼서 판 안 채팅에서는 열어 둔 파일을 붙일 수
 * 없었다. 한 곳에서 만들면 그런 어긋남이 생기지 않는다.
 *
 * @param {object} tab     훑을 서브탭
 * @param {string} hostName 터미널 이름이 없을 때 대신 쓸 서버 이름
 * @param {object} [exclude] 자기 자신(채팅 판)은 뺀다
 */
function paneContextSources(tab, hostName, exclude) {
  if (!tab) return [];
  const out = [];
  for (const l of leavesOf(tab.root)) {
    if (exclude && l === exclude) continue;
    if (l.mode === 'terminal' && l.status === 'ready') {
      out.push({
        label: `터미널 — ${l.title || hostName || ''}`,
        get: async () => (readScreenTail(l) || '').slice(-8000)
      });
    } else if (l.mode === 'web' && l.web) {
      out.push({
        label: `웹 — ${(l.web.title || l.web.url || '페이지').slice(0, 40)}`,
        get: async () => {
          const txt = await l.web.pageText();
          return txt ? `제목: ${l.web.title || ''}\n주소: ${l.web.url || ''}\n\n${txt}` : '';
        }
      });
    } else if (l.mode === 'file' && l.file && l.file.getText) {
      out.push({ label: `파일 — ${l.title || '열린 파일'}`, get: async () => l.file.getText() });
    }
  }
  return out;
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

/*
 * tmux 상태줄 왼쪽은 기본값이 "[세션이름] " 이라 거기서 세션 이름을 얻는다.
 * (status-left 를 바꿔 쓰는 사람도 있으므로 못 읽으면 이름 없이 tmux 안이라는
 *  사실만 기억한다 — 그때는 재접속 후 그냥 `tmux attach` 를 쓴다)
 */
const TMUX_SESSION_RE = /^\[([^\]]{1,40})\]/;

function rememberTmux(leaf) {
  const lines = bottomNonEmptyLines(leaf, 2);
  const inTmux = lines.some((l) => TMUX_STATUS_RE.test(l));
  if (!inTmux) return; // tmux 를 벗어난 것일 수도 있으니 기억을 지우지는 않는다
  leaf.wasTmux = true;
  if (leaf.tmuxSession) return; // 명령에서 이미 정확한 이름을 얻었으면 그것을 쓴다
  for (const l of lines) {
    const m = TMUX_SESSION_RE.exec(l.trim());
    /*
     * 닫는 대괄호까지 보일 때만 인정한다.
     * tmux 의 status-left-length 기본값이 10 이라 이름이 길면 "[octopus_bi" 처럼
     * 잘려서 나온다. 잘린 이름으로 붙으려 들면 엉뚱한 세션에 붙을 수 있다.
     */
    if (m) {
      leaf.tmuxSession = m[1];
      return;
    }
  }
}

/*
 * 사용자가 친 tmux 명령에서 세션 이름을 정확히 얻는다.
 * 화면의 상태줄은 잘려 나오기 때문에(위 참고) 이쪽이 훨씬 믿을 만하다.
 * 한 줄씩 모았다가 Enter 를 칠 때만 살펴본다.
 */
const TMUX_ATTACH_RE = /\btmux\s+(?:a|at|att|attach|attach-session)\b[^\n]*?-t\s+["']?([\w.@-]{1,40})/;
const TMUX_NEW_RE = /\btmux\s+new(?:-session)?\b[^\n]*?-s\s+["']?([\w.@-]{1,40})/;
const TMUX_SWITCH_RE = /\btmux\s+switch(?:-client)?\b[^\n]*?-t\s+["']?([\w.@-]{1,40})/;

function watchTmuxCommand(leaf, data) {
  if (typeof data !== 'string') return;
  if (data.includes('\r') || data.includes('\n')) {
    const line = (leaf.cmdBuf || '') + data;
    leaf.cmdBuf = '';
    for (const re of [TMUX_ATTACH_RE, TMUX_NEW_RE, TMUX_SWITCH_RE]) {
      const m = re.exec(line);
      if (m) {
        leaf.tmuxSession = m[1];
        leaf.wasTmux = true;
        return;
      }
    }
    return;
  }
  if (data === '\u007f') {
    leaf.cmdBuf = (leaf.cmdBuf || '').slice(0, -1); // 백스페이스
    return;
  }
  if (data.length > 200 || /[\u0000-\u001f]/.test(data)) return; // 붙여넣기·제어키는 무시
  leaf.cmdBuf = ((leaf.cmdBuf || '') + data).slice(-200);
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
/**
 * 모든 판을 살펴 "작업이 끝났는데 안 보고 있는" 순간을 잡아 알림을 올린다.
 * 화면에 아무것도 그리지 않는다(스피너 없음) — 알림 이벤트 감지 전용.
 * Stop 훅이 오는 경우엔 그쪽이 먼저 처리하지만, 훅이 없거나 유실된 세션
 * (ESC 중단, 훅 미설치 Claude 등)을 위해 화면 전환도 함께 본다.
 */
function evaluateActivity() {
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

        // 이 판이 tmux 안인지, 어떤 세션인지 기억해 둔다.
        // 절전에서 깨어나 다시 붙을 때 같은 세션으로 돌려놓기 위해서다.
        if (live) rememberTmux(leaf);

        /*
         * 훅이 한 번이라도 온 판은 훅만 믿는다.
         *
         * 훅이 "시작(busy)" 을 알려 주면 wasThinking 이 켜지는데, 그 직후에는
         * 아직 작업 상태줄이 그려지지 않아 아래 화면 검사가 "안 보인다" 로
         * 읽는다. 그러면 2.5초 뒤 "작업 중 → 끝남" 으로 잘못 판정해서, 일을
         * 시작하자마자 초록 느낌표가 떴다. 끝났다는 신호는 Stop 훅이 정확히
         * 주므로 화면 추측은 훅이 없는 판(훅 설치 전, 다른 도구)에만 쓴다.
         */
        /*
         * 에이전트의 작업 상태줄이 화면 아래 15줄 안에 보이는가.
         * 훅이 있는 판에서도 이 값은 계산한다 — Codex 는 훅에 "시작" 이벤트가
         * 없어서(완료·승인만 있다) 스피너를 띄우려면 화면을 봐야 하기 때문이다.
         * 시각을 함께 찍어 두므로 한두 프레임 놓쳐도 깜빡이지 않고, 시간이
         * 지나면 저절로 풀려서 갇히지도 않는다.
         */
        const seen = live && bottomNonEmptyLines(leaf, 15).some(isAgentWorkingLine);
        if (seen) leaf.screenBusyAt = now;

        if (leaf.hooksActive) continue;

        // 히스테리시스: 마지막으로 본 지 2.5초 안이면 아직 작업 중으로 본다.
        // (툴 전환 순간 상태줄이 한두 프레임 사라져도 완료로 오인하지 않게)
        if (seen) leaf.thinkSeenAt = now;
        const thinking = seen || (leaf.wasThinking && now - (leaf.thinkSeenAt || 0) < 2500);

        // 작업 중 → 끝남 전환: 그 창을 보고 있지 않으면 초록 느낌표
        if (leaf.wasThinking && !thinking && live) {
          const cur = activeLeaf();
          const looking = cur && cur.id === leaf.id && document.hasFocus() && !state.notesOpen;
          if (!looking) raiseAlert(leaf);
        }
        leaf.wasThinking = thinking;
      }
    }
  }
}

setInterval(evaluateActivity, 250);

/*
 * 화면이 바뀔 만한 일(창 전환·키 입력)이 생기면 곧바로 상태를 다시 본다.
 * 화면이 다시 그려지는 데 시간이 걸리므로 잠깐 뒤에도 한 번 더 확인한다.
 * (주기 검사만으로도 결국 맞춰지지만, 전환 직후 잠깐 옛 표시가 남는 것을 막는다)
 */
let activitySoonTimers = [];
function checkActivitySoon() {
  for (const t of activitySoonTimers) clearTimeout(t);
  activitySoonTimers = [80, 500, 1500].map((ms) => setTimeout(evaluateActivity, ms));
}



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
/**
 * 서브탭 하나 추가.
 * @param {boolean} chooser true 면 셸을 바로 붙이지 않고 "무엇을 열지" 부터 묻는다.
 */
function createTab(group, connect, chooser) {
  const tab = makeTabShell(group);
  const leaf = chooser
    ? createLeaf(tab, connect, { mode: 'orphan', silent: true })
    : createLeaf(tab, connect);
  tab.root = leaf;
  tab.activeLeafId = leaf.id;

  layoutTab(tab);
  render();
  if (chooser) showLauncher(leaf);
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
    explorerSelected: false, // 고정하지 않았을 때, 탐색기 탭이 선택된 상태인지
    // AI 팝업은 메인탭마다 따로 (대화도, 열려 있는지도)
    aiPop: null,
    aiOpen: false,
    aiUnread: false,
    aiBusy: false
  };
  state.groups.push(group);
  state.activeGroupId = group.id;
  createTab(group, connect);
  return group;
}

/** 로컬 터미널 메인탭을 만든다 (SSH 없이 이 PC 의 셸) */
function createLocalGroup() {
  const group = {
    id: nextId('g'),
    host: { id: null, name: '로컬 터미널', host: 'local', port: 0, username: 'local' },
    credId: null,
    connect: { local: true }, // 분할/서브탭 추가 때도 이 표시로 로컬 PTY 를 띄운다
    isLocal: true,
    tabs: [],
    activeTabId: null,
    explorer: null,
    explorerPinned: false, // SFTP 가 없으므로 탐색기는 쓰지 않는다
    explorerSelected: false,
    // AI 팝업은 메인탭마다 따로 (대화도, 열려 있는지도)
    aiPop: null,
    aiOpen: false,
    aiUnread: false,
    aiBusy: false
  };
  state.groups.push(group);
  state.activeGroupId = group.id;
  createTab(group, { local: true });
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
    explorerSelected: false,
    // AI 팝업은 메인탭마다 따로 (대화도, 열려 있는지도)
    aiPop: null,
    aiOpen: false,
    aiUnread: false,
    aiBusy: false
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
  createTab(group, connect, true); // 무엇을 열지 먼저 고른다
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
  if (group.aiPop) {
    group.aiPop.chat.dispose(); // 이 탭 전용 AI 팝업도 함께 정리
    group.aiPop.el.remove();
    group.aiPop = null;
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
  if (!connect.local && !connect.hostId && !connect.credId) {
    openConnectDialog({ group });
    return;
  }

  // 셸을 바로 붙이지 않는다. 무엇을 열지 고른 뒤에 그때 붙인다.
  const newLeaf = createLeaf(tab, connect, { mode: 'orphan', silent: true });
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
  showLauncher(newLeaf);
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

  // 아직 고르는 중이거나 붙은 셸이 없는 판은 없앨 것이 없으므로 묻지 않는다
  if (leaf.mode !== 'launcher' && leaf.sessionId) {
    const ok = await api.util.confirm(
      '이 분할 창을 닫을까요?',
      `${group.host.username}@${group.host.host} · 이 창의 셸 세션이 종료됩니다.`
    );
    if (!ok) return;
  }

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
  checkActivitySoon(); // 보이는 판이 바뀌었으니 상태 표시를 다시 맞춘다
  // 고르기 화면인 판은 목록이 방향키를 받아야 하므로 그쪽으로 포커스를 준다
  if (leaf.mode === 'launcher' && leaf.launcher) leaf.launcher.focus();
  else leaf.term.focus();
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
function ensureExplorer(group, quiet) {
  if (group.explorer) return group.explorer;
  if (group.isLocal) return null; // 로컬 터미널은 SFTP 가 없다
  const connect = group.connect || { hostId: group.host.id || null, credId: group.credId };
  if (!connect.hostId && !connect.credId) {
    // quiet 은 "사용자가 누른 게 아니라 미리 붙여 두는 중" 이라는 뜻이다
    if (!quiet) el.statusLeft.textContent = '접속이 완료된 뒤에 파일 탐색기를 열 수 있습니다.';
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
/**
 * 탐색기에서 파일을 열 때: 지금 보고 있는 서브탭 안에서, 기준이 되는 판의
 * 오른쪽에 판을 하나 더 만들어 그 안에 파일 뷰어를 띄운다.
 * (새 서브탭을 만들지 않으므로 터미널과 파일을 나란히 놓고 볼 수 있다)
 * @param {object} baseLeaf 이 판의 오른쪽에 연다. 없으면 지금 활성 판 옆에.
 */
async function openFileInPane(group, entry, getSftpId, baseLeaf) {
  const tab = group.tabs.find((t) => t.id === group.activeTabId) || group.tabs[0];
  if (!tab) return;
  const base = baseLeaf || findLeaf(tab.root, tab.activeLeafId) || firstLeaf(tab.root);
  if (!base) return;

  const leaf = createLeaf(tab, {}, { mode: 'orphan', silent: true }); // 셸 없이 파일 전용 판
  // 기준 판을 좌우로 쪼개고 오른쪽에 새 판을 넣는다
  const split = {
    kind: 'split',
    id: nextId('s'),
    dir: 'row',
    children: [base, leaf],
    sizes: [0.5, 0.5]
  };
  replaceNode(tab, base, split);
  tab.activeLeafId = leaf.id;
  layoutTab(tab);

  leaf.mode = 'file';
  leaf.title = entry.name; // 판 제목을 파일명으로
  leaf.file = window.FileViewer.create({
    // 파일을 연 탐색기의 SFTP 연결을 쓴다(판 안 탐색기면 그 판의 것, 아니면 그룹 것)
    sftpId: () => (getSftpId ? getSftpId() : group.explorer && group.explorer.sftpId),
    sessionId: () => anyReadySession(group), // 원격 실행(parquet/ipynb)용 셸 세션은 그룹에서 빌려온다
    path: entry.path,
    name: entry.name,
    onClose: () => closeFilePane(group, tab, leaf)
  });
  leaf.el.querySelector('.pane-body').appendChild(leaf.file.el);
  applyPaneBody(leaf);

  group.explorerSelected = false; // 전체화면 탐색기였다면 나온다
  state.notesOpen = false;
  render();
  fitTab(tab);
  leaf.file.focus();
  saveSession();
}

/** 파일 판 닫기. 저장하지 않은 변경이 있을 때만 물어본다. */
async function closeFilePane(group, tab, leaf) {
  if (leaf.file && leaf.file.isDirty && leaf.file.isDirty()) {
    const ok = await api.util.confirm('저장하지 않은 변경이 있습니다. 그래도 닫을까요?', '', '닫기');
    if (!ok) return;
  }
  // 이 판이 탭의 전부라면 탭을 닫고, 아니면 판만 떼어 낸다
  if (leavesOf(tab.root).length <= 1) {
    closeTab(group, tab);
    return;
  }
  detachLeaf(tab, leaf);
  disposeLeaf(leaf);
  const next = firstLeaf(tab.root);
  tab.activeLeafId = next ? next.id : null;
  layoutTab(tab);
  render();
  fitTab(tab);
  if (next) focusLeaf(next);
  saveSession();
}


/** 판 본문에서 터미널/웹/파일 중 무엇을 보일지 반영 */
function applyPaneBody(leaf) {
  const termHost = leaf.el.querySelector('.pane-term');
  if (termHost) termHost.classList.toggle('hidden', leaf.mode !== 'terminal');
  if (leaf.launcher) leaf.launcher.el.classList.toggle('hidden', leaf.mode !== 'launcher');
  if (leaf.web) leaf.web.el.classList.toggle('hidden', leaf.mode !== 'web');
  if (leaf.file) leaf.file.el.classList.toggle('hidden', leaf.mode !== 'file');
  if (leaf.notes) leaf.notes.el.classList.toggle('hidden', leaf.mode !== 'notes');
  if (leaf.aichat) leaf.aichat.el.classList.toggle('hidden', leaf.mode !== 'ai');
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

/* --------------------------------- 새 판 고르기 --------------------------------- */

/*
 * 판이나 서브탭을 새로 열면 곧바로 셸에 붙는 대신 "무엇을 열지" 를 먼저 묻는다.
 * 웹페이지나 메모만 보려던 경우에도 매번 셸이 하나씩 붙던 것을 없애기 위해서다.
 * 목록은 판 헤더의 "전환" 과 같고, 터미널이 맨 위이자 기본 선택이다.
 * 방향키·Enter·숫자키, 그리고 마우스 클릭으로 고를 수 있다.
 */
function launcherItems(group) {
  const items = [
    { key: 'terminal', icon: '⌨', label: '터미널', desc: group && group.isLocal ? '이 PC 의 셸' : '이 서버의 셸' },
    { key: 'web', icon: '🌐', label: '웹페이지', desc: '판 안에서 열리는 브라우저' },
    { key: 'ai', icon: '✳', label: 'AI 채팅', desc: 'Claude · Codex 에게 물어보기' },
    { key: 'notes', icon: '📝', label: '메모', desc: '간단한 기록' }
  ];
  // 로컬 터미널 그룹은 SFTP 가 없어 파일 탐색기를 쓸 수 없다
  if (!group || !group.isLocal) {
    items.push({ key: 'explorer', icon: '📁', label: '파일', desc: '원격 파일 탐색기 (SFTP)' });
  }
  return items;
}

/** 새로 만든 빈 판에 고르기 화면을 띄운다 */
function showLauncher(leaf) {
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const items = launcherItems(group);
  let sel = 0; // 터미널이 기본

  const body = leaf.el.querySelector('.pane-body');
  const root = document.createElement('div');
  root.className = 'launcher';
  root.tabIndex = 0; // 방향키를 받으려면 포커스를 가질 수 있어야 한다

  const head = document.createElement('div');
  head.className = 'launcher-head';
  head.textContent = '이 판에서 무엇을 열까요?';

  const list = document.createElement('div');
  list.className = 'launcher-list';

  const hint = document.createElement('div');
  hint.className = 'launcher-hint';
  hint.textContent = '↑↓ 로 고르고 Enter · 숫자키로 바로 선택 · Esc 로 닫기';

  const rows = items.map((item, i) => {
    const b = document.createElement('button');
    b.className = 'launcher-item';
    b.innerHTML = '';
    const num = document.createElement('span');
    num.className = 'launcher-num';
    num.textContent = String(i + 1);
    const icon = document.createElement('span');
    icon.className = 'launcher-icon';
    icon.textContent = item.icon;
    const text = document.createElement('span');
    text.className = 'launcher-text';
    const name = document.createElement('span');
    name.className = 'launcher-label';
    name.textContent = item.label;
    const desc = document.createElement('span');
    desc.className = 'launcher-desc';
    desc.textContent = item.desc;
    text.append(name, desc);
    b.append(num, icon, text);
    /*
     * mouseenter 가 아니라 mousemove 를 쓴다.
     * 마우스가 가만히 있는 자리에 이 화면이 뜨면 mouseenter 가 저절로 일어나
     * 기본 선택(터미널)이 엉뚱한 항목으로 바뀌어 버린다. mousemove 는 사람이
     * 실제로 마우스를 움직였을 때만 온다.
     */
    b.addEventListener('mousemove', () => {
      if (sel === i) return;
      sel = i;
      paint();
    });
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스를 뺏기지 않게
    b.addEventListener('click', () => choose(i));
    list.appendChild(b);
    return b;
  });

  const paint = () => rows.forEach((b, i) => b.classList.toggle('sel', i === sel));
  paint();

  root.append(head, list, hint);
  body.appendChild(root);
  leaf.launcher = { el: root, focus: () => root.focus() };
  leaf.mode = 'launcher';
  applyPaneBody(leaf);
  renderPaneHeader(leaf);

  function choose(i) {
    const item = items[i];
    if (!item) return;
    closeLauncher(leaf);
    if (item.key === 'terminal') {
      leaf.mode = 'terminal';
      applyPaneBody(leaf);
      renderPaneHeader(leaf);
      // 이 판은 셸 없이 만들어졌으므로 지금 붙인다
      if (!leaf.sessionId) startSession(leaf);
      else leaf.term.focus();
      render();
      fitLeaf(leaf);
    } else {
      setLeafMode(leaf, item.key);
    }
    saveSession();
  }

  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 앱 전역 단축키로 새지 않게
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      sel = (sel + 1) % items.length;
      paint();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      sel = (sel - 1 + items.length) % items.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelLauncher(leaf);
    } else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < items.length) {
        e.preventDefault();
        choose(i);
      }
    }
  });

  root.focus();
}

/** 고르기 화면만 걷어낸다 (판은 그대로 두고) */
function closeLauncher(leaf) {
  if (!leaf.launcher) return;
  leaf.launcher.el.remove();
  leaf.launcher = null;
}

/**
 * Esc — 고르지 않고 닫는다.
 * 방금 만든 빈 판이라 없앨 것이 없으므로 확인 없이 접는다.
 * 다만 이 판 하나뿐인 서브탭이 그룹의 마지막 서브탭이면, 닫을 곳이 없으므로
 * 그냥 고르기 화면을 유지한다.
 */
function cancelLauncher(leaf) {
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const tab = group && group.tabs.find((t) => t.id === leaf.tabId);
  if (!group || !tab) return;

  const alone = leavesOf(tab.root).length === 1;
  if (alone && group.tabs.length === 1) return; // 마지막 하나 — 닫을 수 없다

  closeLauncher(leaf);
  if (alone) {
    closeTab(group, tab); // 빈 서브탭이므로 확인 없이 (closeTab 은 묻지 않는 쪽)
    return;
  }
  detachLeaf(tab, leaf);
  disposeLeaf(leaf);
  const next = firstLeaf(tab.root);
  tab.activeLeafId = next ? next.id : null;
  layoutTab(tab);
  render();
  if (next) focusLeaf(next);
  saveSession();
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
  checkActivitySoon(); // 보이는 창이 바뀌었으니 상태 표시를 다시 맞춘다
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
  checkActivitySoon(); // 보이는 서브탭이 바뀌었으니 상태 표시를 다시 맞춘다
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
      ['현재 창 닫기', () => accelLabel(keyOf('closePane')), () => {
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
      ['찾기', () => accelLabel(keyOf('find')), () => openFind()]
    ]
  },
  {
    label: '보기',
    items: [
      ['파일 탐색기', () => accelLabel(keyOf('explorer')), () => {
        const g = activeGroup();
        if (g) toggleExplorerView(g);
      }],
      ['메모장', () => accelLabel(keyOf('notes')), () => toggleNotes()],
      ['-'],
      // 켬/끔 — 메뉴를 열 때마다 라벨을 다시 만들어 ✓ 를 보여 준다
      [() => `${opts.notifyOs ? '✓' : '  '} 작업 완료 시 알림`, '', () => setOption('notifyOs', !opts.notifyOs)],
      [() => `${opts.autoReconnect ? '✓' : '  '} 절전에서 깨면 자동 재접속`, '', () => setOption('autoReconnect', !opts.autoReconnect)],
      [() => `${prefs.reconnectOnDrop ? '✓' : '  '} 연결이 끊기면 자동으로 다시 붙기`, '', () => setPref('reconnectOnDrop', !prefs.reconnectOnDrop)],
      [() => `${opts.tmuxReattach ? '✓' : '  '} 재접속하면 tmux 다시 붙기`, '', () => setOption('tmuxReattach', !opts.tmuxReattach)],
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
      ['설정', '', () => openSettings()],
      ['-'],
      ['버전', '', () => openAbout()],
      ['업데이트', '', () => openUpdate()]
    ]
  },
  {
    label: '도움',
    items: [
      ['AI 채팅', () => accelLabel(keyOf('ai')), () => toggleAiPop()],
      ['퀵메모', () => accelLabel(keyOf('memo')), () => toggleQuickMemo()],
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
    // 라벨이 함수면 열 때마다 계산한다 (켬/끔 항목의 ✓ 표시용)
    name.textContent = typeof label === 'function' ? label() : label;
    const key = document.createElement('span');
    key.className = 'menu-accel';
    // 단축키도 함수면 열 때마다 계산한다 (설정에서 바꾼 키가 바로 보이게)
    key.textContent = (typeof accel === 'function' ? accel() : accel) || '';
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

/* -------------------------------- 뽀모도로 타이머 ------------------------------- */
/*
 * 서브탭 줄 오른쪽 끝(시계 바로 아래)의 작은 타이머.
 *   - 창을 누르면 시간을 분 단위로 직접 넣는다
 *   - ▶ 시작 / ■ 정지. 정지해도 남은 시간은 그대로 두고, 다시 맞추면 초기화된다
 *   - 남은 시간은 "끝나는 시각" 에서 거꾸로 계산한다. 창이 뒤로 밀리면 브라우저가
 *     setInterval 을 늦추는데, 남은 시간을 빼는 방식이면 그만큼 시간이 밀린다.
 */
const POMO_KEY = 'pomodoroMinutes';
const POMO_DEFAULT_MIN = 25;
const pomoEl = document.getElementById('pomodoro');
const pomoTimeEl = document.getElementById('pomo-time');
const pomoToggleEl = document.getElementById('pomo-toggle');
const pomoPop = document.getElementById('pomo-pop');
const pomoMinInput = document.getElementById('pomo-min');

let pomoMinutes = (() => {
  const v = Number(localStorage.getItem(POMO_KEY));
  return Number.isFinite(v) && v >= 1 && v <= 180 ? v : POMO_DEFAULT_MIN;
})();
let pomoLeftMs = pomoMinutes * 60000;
let pomoEndAt = 0; // 0 이면 멈춰 있다
let pomoDoneTimer = null;

const pomoFmt = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function renderPomo() {
  const ms = pomoEndAt ? pomoEndAt - Date.now() : pomoLeftMs;
  const text = pomoFmt(ms);
  if (pomoTimeEl.textContent !== text) pomoTimeEl.textContent = text;
  pomoEl.classList.toggle('running', Boolean(pomoEndAt));
  pomoToggleEl.textContent = pomoEndAt ? '■' : '▶';
  pomoToggleEl.title = pomoEndAt ? '정지' : '시작';
  pomoEl.title = `뽀모도로 ${pomoMinutes}분 — 눌러서 시간 설정`;
}

function pomoClearDone() {
  if (pomoDoneTimer) {
    clearTimeout(pomoDoneTimer);
    pomoDoneTimer = null;
  }
  pomoEl.classList.remove('done');
}

function pomoStart() {
  pomoClearDone();
  if (pomoLeftMs <= 0) pomoLeftMs = pomoMinutes * 60000; // 다 쓴 뒤 다시 누르면 처음부터
  pomoEndAt = Date.now() + pomoLeftMs;
  renderPomo();
}

function pomoStop() {
  if (!pomoEndAt) return;
  pomoLeftMs = Math.max(0, pomoEndAt - Date.now()); // 남은 시간은 그대로 둔다
  pomoEndAt = 0;
  renderPomo();
}

function pomoFinish() {
  pomoEndAt = 0;
  pomoLeftMs = 0;
  renderPomo();
  pomoEl.classList.add('done');
  api.notify.alert({ title: '뽀모도로 끝', body: `${pomoMinutes}분이 지났습니다.` });
  // 잠깐 깜빡인 뒤 다음 판을 위해 처음 시간으로 되돌린다
  pomoDoneTimer = setTimeout(() => {
    pomoClearDone();
    pomoLeftMs = pomoMinutes * 60000;
    renderPomo();
  }, 5000);
}

function setPomoMinutes(m) {
  pomoMinutes = Math.min(180, Math.max(1, Math.round(m) || POMO_DEFAULT_MIN));
  localStorage.setItem(POMO_KEY, String(pomoMinutes));
  pomoClearDone();
  pomoEndAt = 0; // 새로 맞추면 멈춘 상태에서 처음부터
  pomoLeftMs = pomoMinutes * 60000;
  renderPomo();
}

setInterval(() => {
  if (!pomoEndAt) return;
  if (Date.now() >= pomoEndAt) pomoFinish();
  else renderPomo();
}, 250);

pomoToggleEl.addEventListener('click', (e) => {
  e.stopPropagation(); // 이 단추는 시간 입력 팝업을 열지 않는다
  if (pomoEndAt) pomoStop();
  else pomoStart();
});

/* ----- 시간 입력 팝업 ----- */
function openPomoPop() {
  pomoMinInput.value = String(pomoMinutes);
  pomoPop.classList.remove('hidden'); // 크기를 재려면 먼저 보여야 한다
  const r = pomoEl.getBoundingClientRect();
  const left = Math.max(6, Math.min(r.right - pomoPop.offsetWidth, window.innerWidth - pomoPop.offsetWidth - 8));
  pomoPop.style.left = `${left}px`;
  pomoPop.style.top = `${r.bottom + 4}px`;
  pomoMinInput.focus();
  pomoMinInput.select();
}

function closePomoPop() {
  pomoPop.classList.add('hidden');
}

const pomoPopOpen = () => !pomoPop.classList.contains('hidden');

pomoEl.addEventListener('click', () => {
  if (pomoPopOpen()) closePomoPop();
  else openPomoPop();
});

document.getElementById('pomo-apply').addEventListener('click', () => {
  setPomoMinutes(Number(pomoMinInput.value));
  closePomoPop();
});
document.getElementById('pomo-cancel').addEventListener('click', closePomoPop);
for (const b of pomoPop.querySelectorAll('.pomo-presets button')) {
  b.addEventListener('click', () => {
    pomoMinInput.value = b.dataset.min;
    setPomoMinutes(Number(b.dataset.min));
    closePomoPop();
  });
}
pomoMinInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // 앱 단축키가 숫자 입력을 가로채지 않게
  if (e.key === 'Enter') {
    setPomoMinutes(Number(pomoMinInput.value));
    closePomoPop();
  } else if (e.key === 'Escape') {
    closePomoPop();
  }
});
// 바깥을 누르면 닫는다
document.addEventListener('mousedown', (e) => {
  if (!pomoPopOpen()) return;
  if (pomoPop.contains(e.target) || pomoEl.contains(e.target)) return;
  closePomoPop();
});

renderPomo();

/* -------------------------------- 설정 창 -------------------------------- */

const setEl = document.getElementById('settings');
let keyListening = null; // 지금 새 키를 기다리고 있는 동작 id

function openSettings() {
  renderSettings();
  setEl.classList.remove('hidden');
}

function closeSettings() {
  stopKeyListen();
  setEl.classList.add('hidden');
}

function stopKeyListen() {
  keyListening = null;
  for (const b of setEl.querySelectorAll('.set-key-btn.listening')) b.classList.remove('listening');
}

/** 설정 창의 모든 값을 지금 상태에 맞춘다 */
function renderSettings() {
  if (!setEl) return;
  const seg = (id, val) => {
    for (const b of setEl.querySelectorAll(`#${id} button`)) b.classList.toggle('on', b.dataset.v === val);
  };
  seg('set-cursor', prefs.cursorStyle);
  document.getElementById('set-font-size').textContent = String(state.fontSize);
  document.getElementById('set-font-family').value = prefs.fontFamily;
  document.getElementById('set-cursor-blink').checked = prefs.cursorBlink;
  document.getElementById('set-scrollback').value = String(prefs.scrollback);
  document.getElementById('set-notify').checked = opts.notifyOs;
  document.getElementById('set-reconnect').checked = opts.autoReconnect;
  document.getElementById('set-drop').checked = prefs.reconnectOnDrop;
  document.getElementById('set-tmux').checked = opts.tmuxReattach;
  document.getElementById('set-pomo').value = String(pomoMinutes);
  document.getElementById('set-swap-tabs').checked = prefs.swapTabKeys;

  // 지금 번호 단축키가 무엇을 가리키는지 말로 적어 준다
  const numMain = isMacPlatform ? '⌘⌃' : 'Ctrl+Alt+';
  const numSub = isMacPlatform ? '⌘' : 'Ctrl+';
  const a = prefs.swapTabKeys ? numMain : numSub;
  const b = prefs.swapTabKeys ? numSub : numMain;
  document.getElementById('set-swap-note').textContent =
    `지금: ${a}숫자 → 서브탭(가로 줄) · ${b}숫자 → 메인탭(세로 열)`;

  // 단축키 목록
  const list = document.getElementById('set-keylist');
  list.innerHTML = '';
  for (const act of KEY_ACTIONS) {
    const row = document.createElement('div');
    row.className = 'set-key' + (keybinds[act.id] ? ' custom' : '');

    const name = document.createElement('span');
    name.className = 'set-key-name';
    name.textContent = act.label;

    const btn = document.createElement('button');
    btn.className = 'set-key-btn' + (keybinds[act.id] ? ' changed' : '');
    btn.textContent = keyListening === act.id ? '키를 누르세요…' : accelLabel(keyOf(act.id));
    if (keyListening === act.id) btn.classList.add('listening');
    btn.title = '눌러서 새 단축키 지정';
    btn.addEventListener('click', () => {
      stopKeyListen();
      keyListening = act.id;
      renderSettings();
    });

    const undo = document.createElement('button');
    undo.className = 'set-key-undo';
    undo.textContent = '↺';
    undo.title = `기본값(${accelLabel(act.def)})으로`;
    undo.addEventListener('click', () => setKeybind(act.id, null));

    row.append(name, btn, undo);
    list.appendChild(row);
  }
}

/* ----- 새 단축키 받기 ----- */
window.addEventListener(
  'keydown',
  (e) => {
    if (!keyListening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopKeyListen();
      renderSettings();
      return;
    }
    // 수정키만 눌린 것은 아직 아니다
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    // 수정키 없이 글자 하나만 지정하면 터미널 입력을 먹어 버린다
    if (!hasMod(e) && !e.altKey) return;
    const accel = accelFromEvent(e);
    const id = keyListening;
    // 이미 다른 동작이 쓰고 있으면 그쪽을 비운다 (같은 키가 둘이면 헷갈린다)
    for (const other of KEY_ACTIONS) {
      if (other.id !== id && keyOf(other.id) === accel) delete keybinds[other.id];
    }
    stopKeyListen();
    setKeybind(id, accel === keyDef(id) ? null : accel);
  },
  true
);

/* ----- 창 조작 ----- */
if (setEl) {
  for (const t of setEl.querySelectorAll('.set-tab')) {
    t.addEventListener('click', () => {
      for (const x of setEl.querySelectorAll('.set-tab')) x.classList.toggle('active', x === t);
      for (const p of setEl.querySelectorAll('.set-pane')) p.classList.toggle('hidden', p.dataset.pane !== t.dataset.pane);
      stopKeyListen();
    });
  }
  for (const b of setEl.querySelectorAll('#set-cursor button')) {
    b.addEventListener('click', () => {
      setPref('cursorStyle', b.dataset.v);
      renderSettings();
    });
  }
  document.getElementById('set-font-plus').addEventListener('click', () => {
    setFontSize(state.fontSize + 1);
    renderSettings();
  });
  document.getElementById('set-font-minus').addEventListener('click', () => {
    setFontSize(state.fontSize - 1);
    renderSettings();
  });
  document.getElementById('set-font-family').addEventListener('change', (e) => setPref('fontFamily', e.target.value.trim()));
  document.getElementById('set-cursor-blink').addEventListener('change', (e) => setPref('cursorBlink', e.target.checked));
  document.getElementById('set-scrollback').addEventListener('change', (e) => {
    const v = Math.min(200000, Math.max(1000, Number(e.target.value) || 10000));
    setPref('scrollback', v);
    renderSettings();
  });
  document.getElementById('set-notify').addEventListener('change', (e) => setOption('notifyOs', e.target.checked));
  document.getElementById('set-reconnect').addEventListener('change', (e) => setOption('autoReconnect', e.target.checked));
  document.getElementById('set-drop').addEventListener('change', (e) => setPref('reconnectOnDrop', e.target.checked));
  document.getElementById('set-tmux').addEventListener('change', (e) => setOption('tmuxReattach', e.target.checked));
  document.getElementById('set-pomo').addEventListener('change', (e) => {
    setPomoMinutes(Number(e.target.value));
    renderSettings();
  });
  document.getElementById('set-swap-tabs').addEventListener('change', (e) => {
    setPref('swapTabKeys', e.target.checked);
    renderSettings();
  });
  document.getElementById('set-close').addEventListener('click', closeSettings);
  document.getElementById('set-done').addEventListener('click', closeSettings);
  document.getElementById('set-reset').addEventListener('click', () => {
    for (const k of Object.keys(PREF_DEFAULTS)) prefs[k] = PREF_DEFAULTS[k];
    savePrefs();
    keybinds = {};
    localStorage.setItem('keybinds', '{}');
    syncKeybinds();
    applyTermPrefs();
    setFontSize(13);
    renderSettings();
  });
  // 바깥(어두운 바탕)을 누르면 닫는다
  setEl.addEventListener('mousedown', (e) => {
    if (e.target === setEl) closeSettings();
  });
}

// 시작할 때 저장된 설정을 화면에 반영한다
syncKeybinds();


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
    if (node.mode === 'web') {
      const ti = node.web && node.web.tabsInfo ? node.web.tabsInfo : null;
      return {
        kind: 'leaf',
        mode: 'web',
        url: node.web ? node.web.url : null, // 예전 버전과의 호환용
        urls: ti ? ti.urls : undefined, // 웹 탭 전체
        at: ti ? ti.active : undefined
      };
    }
    // 메모·파일 탐색기 판도 다음 실행 때 그대로 되살린다
    if (node.mode === 'notes' || node.mode === 'explorer' || node.mode === 'ai') return { kind: 'leaf', mode: node.mode };
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
      isLocal: Boolean(g.isLocal), // 로컬 터미널 그룹
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
      isLocal: Boolean(gs.isLocal),
      // 로컬 터미널은 그대로 다시 띄우고, 저장된 호스트면 자동 접속,
      // 그 밖에는 접속하지 않고 남겨둔다
      connect: gs.isLocal ? { local: true } : gs.hostId ? { hostId: gs.hostId, credId: null } : null,
      tabs: [],
      activeTabId: null,
      explorer: null,
      explorerPinned: Boolean(gs.explorerPinned),
      explorerSelected: false,
      // AI 팝업은 메인탭마다 따로 (대화도, 열려 있는지도)
      aiPop: null,
      aiOpen: false,
      aiUnread: false,
      aiBusy: false
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
      setLeafMode(leaf, 'web', node.url, { urls: node.urls, active: node.at }); // 웹 판(탭 포함) 복원
    } else if (node && (node.mode === 'notes' || node.mode === 'explorer' || node.mode === 'ai')) {
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

/*
 * 아직 사용량이 안 뜬 서버는 더 자주 다시 확인한다.
 * 처음 조회할 때 셸이 덜 뜬 상태였거나, 그 서버만 잠깐 네트워크가 안 됐거나,
 * 그 사이에 claude 에 로그인했을 수 있기 때문이다.
 */
const CLAUDE_RETRY_MS = 300000; // 5분

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
  /*
   * 사용량이 이미 보이는 서버는 1분마다, 아직 못 받은 서버는 5분마다 다시 본다.
   * (못 받은 쪽을 1분마다 두드리면 안 되는 서버에 계속 exec 를 여는 셈이 된다)
   */
  const shown = Boolean(group.claudeInfo && group.claudeInfo.loggedIn);
  const every = shown ? CLAUDE_POLL_MS : CLAUDE_RETRY_MS;
  if (!force && group.claudeFetchedAt && now - group.claudeFetchedAt < every) return;
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
    /*
     * 전체 대기는 "호출 제한(rate limit)" 일 때만 건다.
     * 제한은 계정 단위라 어느 서버에서 부르든 같지만, 그 밖의 실패(그 서버에서
     * api.anthropic.com 이 안 된다든지)는 그 서버 사정이다. 예전에는 이것까지
     * 전체 대기를 걸어서, 밖으로 못 나가는 서버 하나가 10분마다 대기를 다시
     * 걸며 다른 모든 서버의 사용량 막대를 통째로 막고 있었다.
     */
    if (info && info.rateLimited) claudeGate.backoffUntil = Date.now() + CLAUDE_BACKOFF_MS;
    else if (info && info.loggedIn && !info.usageFailed) claudeGate.backoffUntil = 0;
    group.claudeInfo = info;
    group.claudeFetchedAt = Date.now();
    if (activeGroup() === group) renderClaudeStatus();
  } catch (e) {
    // 조회 자체가 실패해도 이미 받아 둔 계정 정보는 지우지 않는다
    if (!group.claudeInfo) group.claudeInfo = { loggedIn: false };
    group.claudeFetchedAt = Date.now(); // 다음 재확인 주기를 여기서부터 센다
  } finally {
    group.claudeFetching = false;
  }
}

/*
 * Codex(OpenAI) 사용량.
 * 조회는 그 서버의 `codex app-server` 에 물어보는 방식이라 Anthropic 쪽처럼
 * 호출 제한에 걸리지 않는다. 그래서 backoff 없이 같은 주기로만 갱신한다.
 */
const CODEX_POLL_MS = 60000;

async function refreshCodexInfo(group, force) {
  if (!group) return;
  const sessionId = anyReadySession(group);
  if (!sessionId) return;
  const now = Date.now();
  // 이미 보이는 서버는 1분마다, 아직 못 받은 서버는 5분마다 (조회가 원격에서
  // codex app-server 를 띄우는 일이라 자주 두드릴 일이 아니다)
  const every = group.codexInfo && group.codexInfo.loggedIn ? CODEX_POLL_MS : CLAUDE_RETRY_MS;
  if (!force && group.codexFetchedAt && now - group.codexFetchedAt < every) return;
  if (group.codexFetching) return;

  group.codexFetching = true;
  try {
    const info = await api.codex.info(sessionId);
    // 한 번 실패해도 화면이 깜빡이지 않도록 직전 값을 유지한다
    const prev = group.codexInfo;
    if (info && info.loggedIn && !info.session && !info.week && prev && (prev.session || prev.week)) {
      info.session = prev.session;
      info.week = prev.week;
      info.stale = true;
    }
    group.codexInfo = info;
    group.codexFetchedAt = Date.now();
    if (activeGroup() === group) renderClaudeStatus();
  } catch (e) {
    if (!group.codexInfo) group.codexInfo = { loggedIn: false };
    group.codexFetchedAt = Date.now(); // 다음 재확인 주기를 여기서부터 센다
  } finally {
    group.codexFetching = false;
  }
}

/** 이 서버에 어떤 AI CLI 가 있는지 (AI 채팅의 선택 목록에 쓴다) */
async function refreshAiTools(group) {
  if (!group || group.aiToolsAt) return; // 그룹당 한 번이면 충분하다
  const sessionId = anyReadySession(group);
  if (!sessionId) return;
  group.aiToolsAt = Date.now();
  try {
    group.aiTools = await api.ai.tools(sessionId);
  } catch (e) {
    group.aiToolsAt = 0; // 실패하면 다음에 다시
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

/**
 * 0~100% 짜리 작은 막대.
 * @param {string} tone 'claude'(주황 계열 기본) | 'codex'(초록) — 어느 서비스의 막대인지
 */
function usageBar(label, bucket, showReset, tone) {
  const wrap = document.createElement('span');
  wrap.className = `usage${tone ? ` usage-${tone}` : ''}`;

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

/** 한 서비스(claude/codex)의 계정 + 사용량 묶음을 만든다 */
function usageGroupEl(kind, info, onRefresh) {
  const wrap = document.createElement('span');
  wrap.className = `svc svc-${kind}`;
  wrap.onclick = onRefresh;

  // 표식(✳/◆)과 계정 이름을 따로 둔다. 창이 좁아지면 이름만 접고 표식은 남긴다.
  const who = document.createElement('span');
  who.className = 'claude-who';
  const glyph = document.createElement('span');
  glyph.className = 'svc-mark';
  glyph.textContent = kind === 'codex' ? '◆' : '✳';
  const label = document.createElement('span');
  label.className = 'svc-name';
  const fallback = kind === 'codex' ? 'Codex' : 'Claude';
  label.textContent = `${info.email || info.name || fallback}${info.plan ? ` (${info.plan})` : ''}`;
  who.append(glyph, label);
  who.title =
    `${kind === 'codex' ? 'Codex' : 'Claude Code'} — ${label.textContent}` +
    `${info.stale ? ' (사용량은 마지막으로 받아온 값)' : ''}`;
  wrap.appendChild(who);

  if (info.session || info.week) {
    // 두 서비스 모두 "짧은 주기 / 긴 주기" 두 칸으로 보여 준다
    if (info.session) wrap.appendChild(usageBar('세션', info.session, true, kind));
    if (info.week) wrap.appendChild(usageBar('주간', info.week, false, kind));
  } else {
    const note = document.createElement('span');
    note.className = 'usage-label';
    if (kind === 'claude') {
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
    } else {
      note.textContent = '사용량 조회 불가';
      note.title = 'codex app-server 에서 사용량을 받아오지 못했습니다.';
    }
    wrap.appendChild(note);
  }
  return wrap;
}

/** 하단바: 이 서버에 로그인된 AI 계정들의 사용량 */
function renderClaudeStatus() {
  const group = activeGroup();
  const claude = group && group.claudeInfo;
  const codex = group && group.codexInfo;
  const box = el.statusClaude;

  const hasClaude = Boolean(claude && claude.loggedIn);
  const hasCodex = Boolean(codex && codex.loggedIn);
  if (!hasClaude && !hasCodex) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = '';
  box.title = '클릭하면 사용량을 지금 새로고침';

  if (hasClaude) {
    box.appendChild(
      usageGroupEl('claude', claude, () => {
        const g = activeGroup();
        if (g) refreshClaudeInfo(g, true);
      })
    );
  }
  if (hasCodex) {
    box.appendChild(
      usageGroupEl('codex', codex, () => {
        const g = activeGroup();
        if (g) refreshCodexInfo(g, true);
      })
    );
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
  syncAiPops(); // 메인탭마다 팝업이 따로다 — 지금 탭 것만 보인다
  schedulePortFabSync(); // 포트 전달 개수도 지금 탭 기준으로
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
 * 탭 앞에 붙는 표시 하나를 고른다.
 * 우선순위: 초록 느낌표(확인 필요) > 연결 상태 점
 */
function busySpinner() {
  const b = document.createElement('span');
  b.className = 'spin';
  b.title = '이 탭에서 무언가 실행 중입니다';
  return b;
}

/**
 * 탭 앞에 붙는 표시 하나를 고른다.
 * 우선순위: 초록 느낌표(확인 필요) > 스피너(실행 중) > 연결 상태 점
 */
function statusMark(status, alerted, busy) {
  if (alerted) return alertBadge();
  if (busy && status === 'ready') return busySpinner();
  return statusDot(status);
}

/** 탭(서브탭) 전체 상태: 하나라도 connecting 이면 connecting, 전부 closed 면 closed … */
function tabStatus(tab) {
  const sts = leavesOf(tab.root).map((l) => l.status);
  if (sts.includes('connecting')) return 'connecting';
  if (sts.includes('waiting')) return 'waiting'; // 끊겨서 다시 붙는 중
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
    idx.textContent = gi < 9 ? `${gi + 1}` : ''; // 수정키는 툴팁에만, 배지는 숫자만

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
    node.append(
      statusMark(cur ? tabStatus(cur) : 'closed', groupHasAlert(group), groupBusy(group)),
      idx,
      label
    );
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
  // 로컬 터미널 그룹은 SFTP 가 없으므로 표시하지 않는다
  if (!group.isLocal) {
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
  }

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

    node.append(statusMark(tabStatus(tab), tabHasAlert(tab), tabBusy(tab)), idx, label);
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
/* --------------------------------- AI 질문 창 --------------------------------- */

/**
 * Ctrl/⌘+K — 지금 판의 화면(또는 선택한 글자)을 들고 독립 AI 질문 창을 연다.
 * 별도 윈도우라 터미널 화면을 전혀 가리지 않고, 다른 모니터로 옮기거나
 * 항상 위에 고정할 수 있다. 질문은 그 판의 SSH 연결로 원격 claude -p 를 돌린다.
 */
/* -------------------------------- 포트 전달 -------------------------------- */

/*
 * 서버에서 열린 포트를 내 PC 로 끌어온다 (VS Code 의 포트 전달과 같은 원리).
 *
 * 예전에는 서버에서 듣고 있는 포트를 훑어 목록으로 보여 줬는데, 작업자
 * 프로세스가 많은 서버에서는 수십 개가 쏟아져 정작 찾는 개발 서버가 묻혔다.
 * 어차피 몇 번을 띄웠는지는 본인이 안다. 그래서 번호를 직접 넣는 방식으로 바꿨다.
 */

/** render() 가 자주 불리므로 개수 세기는 몰아서 한 번만 한다 */
let portFabTimer = null;
function schedulePortFabSync() {
  if (portFabTimer) return;
  portFabTimer = setTimeout(() => {
    portFabTimer = null;
    syncPortFab();
  }, 200);
}

/** 전달 중인 것 개수를 단추에 보여 준다 */
async function syncPortFab() {
  const g = activeGroup();
  const sid = g ? anyReadySession(g) : null;
  let n = 0;
  if (sid) {
    try {
      n = (await api.ports.list(sid)).length;
    } catch (e) {
      n = 0;
    }
  }
  el.portFab.textContent = n ? `⇄ ${n}` : '⇄';
  el.portFab.classList.toggle('on', n > 0);
}

/** 전달된 주소를 웹 판에서 연다 (지금 판을 쪼개 오른쪽에) */
function openForwardedUrl(url) {
  const tab = activeTab();
  const base = activeLeaf();
  if (!tab || !base) {
    api.util.openExternal(url);
    return;
  }
  if (base.mode === 'web' && base.web) {
    base.web.newTab(url);
    return;
  }
  const leaf = createLeaf(tab, {}, { mode: 'orphan', silent: true }); // 셸 없이 웹 전용 판
  const split = {
    kind: 'split',
    id: nextId('s'),
    dir: 'row',
    children: [base, leaf],
    sizes: [0.5, 0.5]
  };
  replaceNode(tab, base, split);
  layoutTab(tab);
  setLeafMode(leaf, 'web', url);
  applyPaneBody(leaf);
  tab.activeLeafId = leaf.id;
  render();
  fitTab(tab);
  saveSession();
}

/**
 * ⇄ 단추 — 포트 번호를 넣어 전달하고, 전달 중인 것을 끊는 작은 창.
 * 열려 있는 동안 목록은 그때그때 다시 그린다.
 */
async function openPortDialog() {
  const g = activeGroup();
  const sid = g ? anyReadySession(g) : null;
  if (!sid) {
    el.statusLeft.textContent = '접속된 세션이 있어야 포트를 전달할 수 있습니다.';
    return;
  }

  const back = document.createElement('div');
  back.className = 'port-ask-back';
  const box = document.createElement('div');
  box.className = 'port-ask';

  const title = document.createElement('div');
  title.className = 'port-ask-title';
  title.textContent = `포트 전달 — ${g.host.name}`;
  const hint = document.createElement('div');
  hint.className = 'port-ask-hint';
  hint.textContent = '서버에서 띄운 포트 번호를 넣으면 이 PC 에서 열 수 있습니다.';

  const row = document.createElement('div');
  row.className = 'port-ask-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.placeholder = '예: 8332';
  input.spellcheck = false;
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary';
  addBtn.textContent = '전달';
  row.append(input, addBtn);

  const listTitle = document.createElement('div');
  listTitle.className = 'port-ask-subtitle';
  listTitle.textContent = '전달 중';
  const list = document.createElement('div');
  list.className = 'port-list';

  const foot = document.createElement('div');
  foot.className = 'port-ask-foot';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = '닫기';
  foot.appendChild(closeBtn);

  box.append(title, hint, row, listTitle, list, foot);
  back.appendChild(box);
  document.body.appendChild(back);
  input.focus();

  const close = () => {
    back.remove();
    const l = activeLeaf();
    if (l && l.mode === 'terminal' && l.term) l.term.focus();
  };

  /** 전달 중인 목록을 다시 그린다 */
  async function paint() {
    const items = await api.ports.list(sid).catch(() => []);
    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'port-empty';
      empty.textContent = '아직 없습니다.';
      list.appendChild(empty);
      return;
    }
    for (const f of items) {
      const item = document.createElement('div');
      item.className = 'port-item';
      const label = document.createElement('span');
      label.className = 'port-item-label';
      label.textContent = `${f.remotePort} → localhost:${f.localPort}`;
      const open = document.createElement('button');
      open.className = 'btn';
      open.textContent = '열기';
      open.addEventListener('click', () => {
        close();
        openForwardedUrl(f.url);
      });
      const stop = document.createElement('button');
      stop.className = 'btn btn-danger';
      stop.textContent = '끊기';
      stop.addEventListener('click', async () => {
        await api.ports.stop(f.id);
        syncPortFab();
        paint();
      });
      item.append(label, open, stop);
      list.appendChild(item);
    }
  }

  async function add() {
    const port = Number(String(input.value).trim());
    if (!(port >= 1 && port <= 65535)) {
      hint.textContent = '1 부터 65535 사이의 번호를 넣어 주세요.';
      hint.classList.add('bad');
      input.focus();
      return;
    }
    addBtn.disabled = true;
    const res = await api.ports.start(sid, port, '127.0.0.1');
    addBtn.disabled = false;
    if (res.error) {
      hint.textContent = `전달하지 못했습니다: ${res.error}`;
      hint.classList.add('bad');
      return;
    }
    hint.classList.remove('bad');
    hint.textContent =
      res.localPort === res.remotePort
        ? `${res.url} 에서 열 수 있습니다.`
        : `${res.url} 에서 열 수 있습니다 (${res.remotePort} 번은 이 PC 에서 쓰는 중이라 바꿨습니다).`;
    input.value = '';
    input.focus();
    syncPortFab();
    paint();
  }

  addBtn.addEventListener('click', add);
  closeBtn.addEventListener('click', close);
  back.addEventListener('click', (e) => {
    if (e.target === back) close();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) add();
    if (e.key === 'Escape') close();
  });

  paint();
}

el.portFab.addEventListener('mousedown', (e) => e.stopPropagation());
el.portFab.addEventListener('click', (e) => {
  e.stopPropagation();
  openPortDialog();
});

/* ------------------------------ 떠 있는 AI 채팅 ------------------------------ */

/*
 * Ctrl/⌘+K 로 여는 AI 채팅.
 *
 * 예전에는 판을 하나 더 만들어 끼워 넣었는데, 판에서 직접 연 AI 채팅과
 * 겉모습이 같아 구분이 되지 않았다(같아 보이는데 되는 게 달랐다).
 * 그래서 아예 판이 아니라 "하단바 오른쪽 AI 단추에서 올라오는 팝업" 으로 만든다.
 *   - 화면 배치(분할 트리)를 건드리지 않는다. 터미널 위에 겹쳐 뜬다.
 *   - 닫아도 없애지 않고 숨기기만 한다. 답을 기다리는 중이었다면 그대로 계속되고,
 *     다시 열면 이어진다.
 *   - 대화 상대는 "지금 보고 있는 서버" 다. 탭을 옮기면 그 서버로 물어본다.
 */
/*
 * 팝업은 메인탭(그룹)마다 따로 있다.
 * 탭마다 서버가 다르니 대화도, 열려 있는지 여부도 따로다.
 * 만든 팝업은 그 그룹에 붙여 두고(group.aiPop), 지금 보고 있는 그룹의 것만 화면에 둔다.
 */
/*
 * 팝업 크기.
 * 하단바 오른쪽 단추 위에 붙어 있으므로 왼쪽 위 방향으로 늘린다.
 * 크기와 "전체보기" 는 앱 전체에서 하나로 본다 — 탭마다 다르면 오히려 헷갈린다.
 */
const AIPOP_KEY = 'aiPopSize';
const AIPOP_MIN_W = 300;
const AIPOP_MIN_H = 240;
const aiPopSize = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(AIPOP_KEY) || '{}');
    return { w: Number(v.w) || 440, h: Number(v.h) || 560, max: Boolean(v.max) };
  } catch (e) {
    return { w: 440, h: 560, max: false };
  }
})();
const saveAiPopSize = () => localStorage.setItem(AIPOP_KEY, JSON.stringify(aiPopSize));

/** 지금 창 크기 안에 들어오도록 자른다 */
const aiPopMaxW = () => Math.max(AIPOP_MIN_W, window.innerWidth - 16);
const aiPopMaxH = () => Math.max(AIPOP_MIN_H, window.innerHeight - 60);

/** 크기 설정을 열려 있는 모든 팝업에 반영한다 */
function applyAiPopSize() {
  for (const g of state.groups) {
    if (!g.aiPop) continue;
    const box = g.aiPop.el;
    box.classList.toggle('maximized', aiPopSize.max);
    if (aiPopSize.max) {
      box.style.width = '';
      box.style.height = '';
    } else {
      box.style.width = `${Math.min(aiPopSize.w, aiPopMaxW())}px`;
      box.style.height = `${Math.min(aiPopSize.h, aiPopMaxH())}px`;
    }
  }
  applyQmPopSize(); // 퀵메모는 AI 팝업 왼쪽에 서므로 자리를 다시 잡는다
}

/** 전체보기 켜고 끄기. 지금 상태를 돌려준다 (단추 표시용) */
function toggleAiPopMax() {
  aiPopSize.max = !aiPopSize.max;
  saveAiPopSize();
  applyAiPopSize();
  window.AiChat.paintAllMaxButtons(aiPopSize.max);
  return aiPopSize.max;
}

/**
 * 가장자리를 끌어 크기를 바꾼다. (AI 채팅 팝업·퀵메모 팝업이 같이 쓴다)
 *
 * 마우스 이벤트 대신 포인터 이벤트 + 포인터 캡처를 쓴다.
 *   - 캡처를 잡으면 창 밖에서 손을 떼도 pointerup 이 반드시 이 요소로 온다.
 *     (mouseup 만 쓰면 창 밖에서 놓았을 때 놓친 채로 계속 끌린다 — 맥·윈도우 공통)
 *   - 판 안 브라우저(webview) 위를 지날 때 이벤트를 빼앗기지 않도록 투명한
 *     덮개도 함께 깔아 둔다. 앱의 다른 크기 조절과 같은 방식이다.
 */
function bindPopResize(box, cfg) {
  const grab = (handle, dirs, cursor) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 왼쪽 단추로만 (오른쪽 클릭은 메뉴)
      if (cfg.size.max) return; // 전체보기 중에는 크기를 바꾸지 않는다
      e.preventDefault();
      e.stopPropagation();

      const r = box.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = r.width;
      const startH = r.height;

      const shield = document.createElement('div');
      shield.className = 'drag-shield';
      shield.style.cursor = cursor;
      document.body.appendChild(shield);

      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 캡처를 못 잡아도 아래 덮개로 대부분 잡힌다 */
      }

      const onMove = (ev) => {
        // 오른쪽 아래에 고정된 창이라 왼쪽·위로 끌수록 커진다
        if (dirs.includes('w')) {
          cfg.size.w = Math.max(cfg.minW, Math.min(startW + (startX - ev.clientX), cfg.maxW()));
        }
        if (dirs.includes('n')) {
          cfg.size.h = Math.max(cfg.minH, Math.min(startH + (startY - ev.clientY), cfg.maxH()));
        }
        cfg.apply();
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* 이미 풀렸으면 그만 */
        }
        shield.remove();
        cfg.save();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp); // 창 전환 등으로 취소될 때
      // 포인터 이벤트를 못 쓰는 상황(합성 이벤트 등) 대비
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  };

  const mk = (cls, dirs, cursor) => {
    const h = document.createElement('div');
    h.className = `${cfg.gripCls} ${cls}`;
    box.appendChild(h);
    grab(h, dirs, cursor);
  };
  mk('g-left', 'w', 'ew-resize');
  mk('g-top', 'n', 'ns-resize');
  mk('g-corner', 'wn', 'nwse-resize');
}

const bindAiPopResize = (box) =>
  bindPopResize(box, {
    size: aiPopSize,
    minW: AIPOP_MIN_W,
    minH: AIPOP_MIN_H,
    maxW: aiPopMaxW,
    maxH: aiPopMaxH,
    apply: applyAiPopSize,
    save: saveAiPopSize,
    gripCls: 'ai-pop-grip'
  });

// 창 크기가 줄면 팝업도 화면 안으로 들어오게 다시 맞춘다
window.addEventListener('resize', () => {
  if (state.groups.some((g) => g.aiPop)) applyAiPopSize();
});

function ensureAiPop(group) {
  if (!group) return null;
  if (group.aiPop) return group.aiPop;

  const box = document.createElement('div');
  box.className = 'ai-pop hidden';

  const chat = window.AiChat.create({
    hostLabel: group.host.name,
    // 이 팝업은 이 그룹 전용이라 대화 상대가 바뀌지 않는다
    getTarget: () => {
      const sid = anyReadySession(group);
      return sid ? { sessionId: sid, key: group.id, label: group.host.name } : null;
    },
    getTools: () => group.aiTools,
    // 첨부 후보는 이 그룹에서 보고 있는 서브탭의 판들
    getContextSources: () =>
      paneContextSources(
        group.tabs.find((x) => x.id === group.activeTabId) || group.tabs[0],
        group.host.name
      ),
    // 접어 둔 사이에 무슨 일이 있었는지 알린다
    onBusy: (busy) => {
      group.aiBusy = busy;
      if (busy) group.aiUnread = false;
      syncAiFab();
    },
    onAnswer: () => {
      // 그 탭의 팝업이 접혀 있었으면 "볼 것이 있다" 고 표시해 둔다
      if (!group.aiOpen) group.aiUnread = true;
      syncAiFab();
      scheduleRender(); // 다른 탭이면 메인탭 배지로도 알린다
    },
    onClose: () => setAiPop(false, group),
    onToggleMax: () => toggleAiPopMax(),
    isMax: () => aiPopSize.max
  });

  box.appendChild(chat.el);
  bindAiPopResize(box);
  document.body.appendChild(box);
  group.aiPop = { el: box, chat };
  applyAiPopSize(); // 저장해 둔 크기(또는 전체보기)를 그대로 쓴다
  return group.aiPop;
}

const aiPopOpen = () => {
  const g = activeGroup();
  return Boolean(g && g.aiOpen && g.aiPop);
};

/** 하단바 AI 단추를 지금 보고 있는 탭의 상태에 맞춘다 */
function syncAiFab() {
  const g = activeGroup();
  el.aiFab.classList.toggle('on', Boolean(g && g.aiOpen));
  el.aiFab.classList.toggle('busy', Boolean(g && g.aiBusy));
  el.aiFab.classList.toggle('unread', Boolean(g && g.aiUnread && !g.aiOpen));
}

/**
 * 화면에는 "지금 보고 있는 탭" 의 팝업만 둔다.
 * 다른 탭의 팝업은 감춰만 두므로 하던 대화도, 기다리던 답도 그대로다.
 */
function syncAiPops() {
  for (const g of state.groups) {
    if (!g.aiPop) continue;
    const show = g === activeGroup() && g.aiOpen;
    g.aiPop.el.classList.toggle('hidden', !show);
  }
  syncAiFab();
  applyQmPopSize(); // AI 팝업이 열리고 닫히면 퀵메모가 설 자리도 달라진다
}

/** 팝업 열기/닫기. 닫아도 내용은 그대로 두고 감추기만 한다. */
function setAiPop(open, group) {
  const g = group || activeGroup();
  if (!g) return;
  const pop = ensureAiPop(g);
  if (!pop) return;
  g.aiOpen = Boolean(open);
  if (g.aiOpen) g.aiUnread = false;
  syncAiPops();
  if (g.aiOpen && g === activeGroup()) {
    pop.chat.focus();
  } else if (!g.aiOpen) {
    const l = activeLeaf();
    if (l && l.mode === 'terminal' && l.term) l.term.focus();
  }
}

/**
 * Ctrl/⌘+K (또는 하단바 AI 단추) — 지금 보고 있는 탭의 팝업을 여닫는다.
 * 열 때는 그 탭에서 보고 있던 판의 내용을 컨텍스트로 붙여 준다.
 */
async function toggleAiPop() {
  const group = activeGroup();
  if (!group) {
    el.statusLeft.textContent = '먼저 서버에 접속해 주세요.';
    return;
  }
  if (group.aiOpen) {
    setAiPop(false, group);
    return;
  }
  if (!anyReadySession(group)) {
    el.statusLeft.textContent = '접속된 세션이 있어야 AI 채팅을 쓸 수 있습니다.';
    return;
  }
  setAiPop(true, group);

  // 보고 있던 판의 내용을 첨부거리로 모은다 (없으면 그냥 빈 채로 연다)
  const leaf = activeLeaf();
  if (!leaf || leaf.mode === 'ai') return;
  let ctx = '';
  let label = '';
  if (leaf.mode === 'web' && leaf.web) {
    const txt = await leaf.web.pageText();
    ctx = txt ? `제목: ${leaf.web.title || ''}\n주소: ${leaf.web.url || ''}\n\n${txt}`.slice(0, 12000) : '';
    label = `웹 — ${(leaf.web.title || leaf.web.url || '페이지').slice(0, 30)}`;
  } else if (leaf.mode === 'file' && leaf.file && leaf.file.getText) {
    ctx = (leaf.file.getText() || '').slice(0, 12000);
    label = `파일 — ${leaf.title || '열린 파일'}`;
  } else if (leaf.mode === 'terminal') {
    // 드래그로 고른 글자가 있으면 그것만, 없으면 화면 내용
    const sel = leaf.term && leaf.term.hasSelection() ? leaf.term.getSelection() : '';
    ctx = (sel || readScreenTail(leaf) || '').slice(-8000);
    label = sel ? '선택한 글자' : `터미널 — ${leaf.title || group.host.name}`;
  }
  if (ctx && group.aiPop) group.aiPop.chat.attachContext(label, ctx);
}

/* ---------------------------------- 퀵메모 ---------------------------------- */
/*
 * Ctrl/⌘+M — 하단바 오른쪽 📝 단추에서 올라오는 작은 메모창.
 *
 * AI 채팅 팝업과 같은 짜임이다(판을 건드리지 않고 위에 겹쳐 뜨고, 닫아도 없애지
 * 않고 감춘다). 다만 메모는 서버와 상관이 없으므로 메인탭마다 나누지 않고 앱에
 * 하나만 둔다 — 어느 탭에서 열든 같은 메모가 이어진다.
 *
 * 내용은 메모장 탭과 같은 곳(<앱 데이터>/notes/*.md)에 저장한다.
 */
const QMPOP_KEY = 'qmPopSize';
const QMPOP_MIN_W = 260;
const QMPOP_MIN_H = 200;
const qmPopSize = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(QMPOP_KEY) || '{}');
    return { w: Number(v.w) || 360, h: Number(v.h) || 380, max: Boolean(v.max) };
  } catch (e) {
    return { w: 360, h: 380, max: false };
  }
})();
const saveQmPopSize = () => localStorage.setItem(QMPOP_KEY, JSON.stringify(qmPopSize));

const qmPopMaxW = () => Math.max(QMPOP_MIN_W, window.innerWidth - 16);
const qmPopMaxH = () => Math.max(QMPOP_MIN_H, window.innerHeight - 60);

let qmPop = null; // { el, memo }
let qmOpen = false;

/**
 * 오른쪽 끝에서 얼마나 떨어뜨릴지.
 * AI 채팅 팝업이 열려 있으면 그 왼쪽에 나란히 세운다 — 겹쳐 놓으면 둘 중
 * 하나는 보이지 않는다. (AI 가 전체보기면 나란히 둘 자리가 없으므로 그냥
 * 오른쪽 끝에 두고 위에 띄운다)
 */
function qmRightOffset(width) {
  const g = activeGroup();
  if (!g || !g.aiOpen || !g.aiPop || aiPopSize.max) return 8;
  const aiW = g.aiPop.el.getBoundingClientRect().width;
  const want = 8 + aiW + 8;
  const limit = Math.max(8, window.innerWidth - width - 8); // 화면 밖으로 밀리지 않게
  return Math.min(want, limit);
}

/** 크기·자리 설정을 팝업에 반영한다 */
function applyQmPopSize() {
  if (!qmPop) return;
  const box = qmPop.el;
  box.classList.toggle('maximized', qmPopSize.max);
  if (qmPopSize.max) {
    box.style.width = '';
    box.style.height = '';
    box.style.right = '';
    return;
  }
  const w = Math.min(qmPopSize.w, qmPopMaxW());
  box.style.width = `${w}px`;
  box.style.height = `${Math.min(qmPopSize.h, qmPopMaxH())}px`;
  box.style.right = `${qmRightOffset(w)}px`;
}

/** 전체보기 켜고 끄기. 지금 상태를 돌려준다 (단추 표시용) */
function toggleQmPopMax() {
  qmPopSize.max = !qmPopSize.max;
  saveQmPopSize();
  applyQmPopSize();
  return qmPopSize.max;
}

function ensureQmPop() {
  if (qmPop) return qmPop;

  const box = document.createElement('div');
  box.className = 'qm-pop hidden';

  const memo = window.QuickMemo.create({
    onClose: () => setQuickMemo(false),
    onToggleMax: () => toggleQmPopMax(),
    isMax: () => qmPopSize.max,
    // 메모장 탭을 열어 두었다면 목록도 바로 새로 고친다
    onSaved: () => {
      if (notesPad && state.notesOpen) notesPad.refresh();
    },
    // "메모장에서 열기" — 큰 화면에서 이어 쓴다
    onOpenNotes: (name) => {
      setQuickMemo(false);
      openNotes();
      if (notesPad && name && notesPad.open) notesPad.open(name);
    }
  });

  box.appendChild(memo.el);
  bindPopResize(box, {
    size: qmPopSize,
    minW: QMPOP_MIN_W,
    minH: QMPOP_MIN_H,
    maxW: qmPopMaxW,
    maxH: qmPopMaxH,
    apply: applyQmPopSize,
    save: saveQmPopSize,
    gripCls: 'ai-pop-grip'
  });
  document.body.appendChild(box);
  qmPop = { el: box, memo };
  applyQmPopSize();
  return qmPop;
}

/** 하단바 📝 단추를 지금 상태에 맞춘다 */
function syncMemoFab() {
  el.memoFab.classList.toggle('on', qmOpen);
}

/** 열기/닫기. 닫아도 적던 글은 그대로 두고 감추기만 한다(저장은 하고 감춘다). */
function setQuickMemo(open) {
  const pop = ensureQmPop();
  qmOpen = Boolean(open);
  pop.el.classList.toggle('hidden', !qmOpen);
  applyQmPopSize();
  syncMemoFab();
  if (qmOpen) {
    pop.memo.focus();
  } else {
    pop.memo.flush(); // 감추기 전에 남은 것을 저장
    const l = activeLeaf();
    if (l && l.mode === 'terminal' && l.term) l.term.focus();
  }
}

/**
 * Ctrl/⌘+M (또는 하단바 📝 단추).
 * 열면 마지막으로 적던 메모를 그대로 잇고, 그런 메모가 없으면 새 메모를 만든다
 * (그 판단은 퀵메모 쪽에서 한다).
 */
function toggleQuickMemo() {
  setQuickMemo(!qmOpen);
}

// 창 크기가 줄면 메모창도 화면 안으로 들어오게 다시 맞춘다
window.addEventListener('resize', () => {
  if (qmPop) applyQmPopSize();
});

// 앱이 뒤로 물러날 때(다른 창을 볼 때) 적던 것을 저장해 둔다
window.addEventListener('blur', () => {
  if (qmPop) qmPop.memo.flush();
});

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
  // 버튼 위치를 "먼저" 재어 둔다.
  // focusLeaf() 가 render() 를 부르면서 헤더를 다시 그리면 이 버튼은 DOM 에서
  // 떨어져 나가고, 그 뒤에 재면 좌표가 전부 0 이라 메뉴가 창 왼쪽 위에 떴다.
  const btn = ev && (ev.currentTarget || ev.target);
  const r = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
  // 버튼은 헤더 오른쪽 끝에 있으므로 메뉴의 오른쪽을 버튼 오른쪽에 맞춘다
  const anchor = r && r.width ? { x: r.right, y: r.bottom + 4 } : null;

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
  const grp = state.groups.find((g) => g.id === leaf.groupId);
  items.push(row('🌐  웹페이지', 'web'));
  items.push(row('✳  AI 채팅', 'ai'));
  items.push(row('📝  메모', 'notes'));
  if (!grp || !grp.isLocal) items.push(row('📁  파일', 'explorer')); // 로컬은 SFTP 없음

  // 버튼 바로 아래에 펼친다 (위치를 못 재었으면 마우스 자리에)
  if (anchor) showContextMenu(anchor.x, anchor.y, items, { alignRight: true });
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

  // 고르기 화면인 판은 아직 붙은 셸이 없으므로 상태 점을 달지 않는다
  const mark = leaf.mode === 'launcher' ? null : statusMark(leaf.status, leaf.alert, leaf.busy);
  if (mark) mark.classList.add('pane-mark');

  const title = document.createElement('span');
  title.className = 'pane-title';
  const group = state.groups.find((g) => g.id === leaf.groupId);
  title.textContent =
    leaf.mode === 'web'
      ? (leaf.web && leaf.web.title) || '웹페이지'
      : leaf.mode === 'ai'
        ? '✳ AI 채팅'
        : leaf.mode === 'notes'
          ? '메모'
        : leaf.mode === 'explorer'
          ? `파일 — ${group ? group.host.name : ''}`
        : leaf.mode === 'launcher'
          ? '새 판'
          : leaf.title || (group ? group.host.name : '');
  title.title = title.textContent;

  header.append(grip, ...(mark ? [mark] : []), title);

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
    clearDropHints();
  });

  // 판 헤더(상단바) 위에 떨어뜨리면 "자리 바꾸기"
  if (!header.dataset.dropBound) {
    header.dataset.dropBound = '1';
    header.addEventListener('dragover', (e) => {
      if (!canDropHere(e, leaf)) return;
      e.preventDefault();
      e.stopPropagation(); // 아래 판 전체의 dragover 로 내려가지 않게
      e.dataTransfer.dropEffect = 'move';
      showDropHint(leaf, 'swap');
    });
    header.addEventListener('drop', (e) => {
      if (!canDropHere(e, leaf)) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropHints();
      const src = findDragSource(e, leaf);
      if (src) swapLeaves(src, leaf);
    });
  }

  // 판 본문 위에 떨어뜨리면 그 가장자리 방향으로 "분할"
  const pane = leaf.el;
  if (pane.dataset.dropBound) return;
  pane.dataset.dropBound = '1';

  pane.addEventListener('dragover', (e) => {
    // OS 에서 끌어온 파일이면 "여기 놓으면 서버로 올라간다" 는 표시를 준다
    if (isFileDrop(e)) {
      if (leaf.mode !== 'terminal' || leaf.status !== 'ready') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      pane.classList.add('file-drop');
      return;
    }
    if (!canDropHere(e, leaf)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showDropHint(leaf, dropZoneOf(pane, e));
  });
  pane.addEventListener('dragleave', (e) => {
    if (e.target === pane) pane.classList.remove('file-drop');
  });
  pane.addEventListener('dragleave', (e) => {
    // 자식 요소로 옮겨 다닐 때도 dragleave 가 오므로, 판 밖으로 나갔을 때만 지운다
    if (e.relatedTarget && pane.contains(e.relatedTarget)) return;
    clearDropHints();
  });
  pane.addEventListener('drop', (e) => {
    pane.classList.remove('file-drop');
    // OS 파일: 서버로 올리고 그 경로를 프롬프트에 적어 준다
    if (isFileDrop(e)) {
      if (leaf.mode !== 'terminal' || leaf.status !== 'ready') return;
      e.preventDefault();
      e.stopPropagation();
      const paths = localPathsFrom(e);
      if (paths.length) dropFilesIntoTerminal(leaf, paths);
      return;
    }
    if (!canDropHere(e, leaf)) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = dropZoneOf(pane, e);
    clearDropHints();
    const src = findDragSource(e, leaf);
    if (src) dropLeafInto(src, leaf, zone);
  });
}

/** 지금 끌고 있는 것이 다른 판인지 */
function canDropHere(e, leaf) {
  if (!draggingLeafId || draggingLeafId === leaf.id) return false;
  return e.dataTransfer.types.includes('armux/pane');
}

/** 드롭 데이터에서 끌려온 판을 찾는다 (같은 서브탭 안에서만) */
function findDragSource(e, leaf) {
  const srcId = e.dataTransfer.getData('armux/pane');
  const group = state.groups.find((g) => g.id === leaf.groupId);
  const tab = group && group.tabs.find((t) => t.id === leaf.tabId);
  return tab ? findLeaf(tab.root, srcId) : null;
}

/**
 * 판 안에서 마우스가 어느 쪽에 있는지 → 어떤 분할이 될지.
 * 가운데(가로·세로 모두 중앙 1/3)에 놓으면 자리 바꾸기로 본다.
 */
function dropZoneOf(pane, e) {
  const r = pane.getBoundingClientRect();
  const px = (e.clientX - r.left) / (r.width || 1); // 0(왼쪽) ~ 1(오른쪽)
  const py = (e.clientY - r.top) / (r.height || 1); // 0(위) ~ 1(아래)
  const dx = Math.min(px, 1 - px); // 좌우 가장자리까지의 거리
  const dy = Math.min(py, 1 - py); // 상하 가장자리까지의 거리
  if (dx > 1 / 3 && dy > 1 / 3) return 'swap'; // 한가운데
  if (dx < dy) return px < 0.5 ? 'left' : 'right'; // 좌우 쪽이 더 가깝다
  return py < 0.5 ? 'top' : 'bottom';
}

/** 어디에 놓일지 미리 보여 주는 표시 */
function showDropHint(leaf, zone) {
  clearDropHints();
  leaf.el.classList.add('drop-target', `drop-${zone}`);
}

function clearDropHints() {
  for (const el2 of document.querySelectorAll('.pane.drop-target')) {
    el2.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-top', 'drop-bottom', 'drop-swap');
  }
}

/**
 * 끌어온 판(src)을 대상 판(dst)의 지정한 쪽에 붙인다.
 * src 를 원래 자리에서 떼어 낸 뒤, dst 자리를 분할 노드로 바꿔 둘을 나란히 넣는다.
 */
function dropLeafInto(src, dst, zone) {
  if (!src || !dst || src === dst) return;
  if (zone === 'swap') return swapLeaves(src, dst);

  const group = state.groups.find((g) => g.id === dst.groupId);
  const tab = group && group.tabs.find((t) => t.id === dst.tabId);
  if (!tab || src.tabId !== dst.tabId) return;

  detachLeaf(tab, src); // 원래 자리에서 뺀다 (형제가 그 자리를 물려받는다)
  // 떼어 내면서 대상이 트리에서 사라졌다면(대상이 src 의 형제였던 경우) 되돌린다
  if (!findLeaf(tab.root, dst.id)) {
    layoutTab(tab);
    render();
    return;
  }

  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const first = zone === 'left' || zone === 'top' ? src : dst;
  const second = first === src ? dst : src;
  replaceNode(tab, dst, {
    kind: 'split',
    id: nextId('s'),
    dir,
    children: [first, second],
    sizes: [0.5, 0.5]
  });

  tab.activeLeafId = src.id;
  layoutTab(tab);
  render();
  fitTab(tab);
  focusLeaf(src);
  saveSession();
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

/** items = [[라벨, 실행함수, 'danger'?, 삭제함수?] | ['-']] */
function showContextMenu(x, y, items, opts) {
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
    // 네 번째 원소가 함수면 항목 오른쪽에 ✕(삭제) 를 단다.
    // 삭제는 항목을 고르는 것과 다른 동작이므로 메뉴를 닫지 않는다.
    if (typeof item[3] === 'function') {
      b.classList.add('has-remove');
      // 바깥의 좌표 인자 x 와 헷갈리지 않게 이름을 따로 둔다
      const rm = document.createElement('span');
      rm.className = 'ctx-remove';
      rm.textContent = '✕';
      rm.title = '삭제';
      rm.addEventListener('mousedown', (e) => e.stopPropagation());
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        item[3]();
      });
      b.appendChild(rm);
    }
    ctxMenu.appendChild(b);
  }
  ctxMenu.classList.remove('hidden'); // 크기를 재려면 먼저 보이게 해야 한다
  // alignRight 면 x 를 "오른쪽 끝" 으로 보고 왼쪽으로 펼친다.
  // (헤더 오른쪽 끝 버튼의 드롭다운은 이렇게 해야 버튼에 딱 붙는다)
  let left = opts && opts.alignRight ? x - ctxMenu.offsetWidth : x;
  left = Math.max(6, Math.min(left, window.innerWidth - ctxMenu.offsetWidth - 8));
  ctxMenu.style.left = `${left}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 8)}px`;
}

function hideContextMenu() {
  ctxMenu.classList.add('hidden');
}
window.showContextMenu = showContextMenu; // 메모장 등 다른 모듈에서도 사용
window.hideContextMenu = hideContextMenu;
el.aiFab.addEventListener('mousedown', (e) => e.stopPropagation());
el.aiFab.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAiPop();
});
el.memoFab.addEventListener('mousedown', (e) => e.stopPropagation());
el.memoFab.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleQuickMemo();
});

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
  if (leaf.retry) {
    cancelRetry(leaf);
    leaf.term.writeln('\x1b[32m● 다시 붙었습니다.\x1b[0m');
  }

  /*
   * 절전에서 깨어나 자동으로 다시 붙은 판이라면, 끊기기 전에 보고 있던 tmux
   * 세션으로 돌려놓는다. 서버의 tmux 는 살아 있으므로 화면이 그대로 돌아온다.
   * 사용자가 직접 누른 재접속에는 하지 않는다(원치 않는 명령을 넣지 않기 위해).
   */
  if (leaf.reattachTmux) {
    leaf.reattachTmux = false;
    const name = leaf.tmuxSession;
    // 이름은 셸에 그대로 들어가므로 안전한 글자만 통과시킨다
    const safe = name && /^[\w.@-]{1,40}$/.test(name) ? name : '';
    if (safe) {
      /*
       * 반드시 "그 판이 보고 있던 세션" 에만 붙는다.
       * 이름이 없거나 그 세션이 사라졌다면 아무것도 하지 않는다 — 그냥
       * `tmux attach` 로 넘어가면 엉뚱한 세션(예: 돌아가고 있는 운영 세션)에
       * 붙을 수 있고, 거기서는 키 하나가 사고가 된다.
       */
      setTimeout(() => {
        if (leaf.status === 'ready' && leaf.sessionId) {
          api.ssh.write(leaf.sessionId, `tmux attach -t ${safe}\n`);
        }
      }, 700); // 셸 프롬프트가 뜬 뒤에 보낸다
    } else if (leaf.wasTmux) {
      el.statusLeft.textContent = '다시 접속했습니다. 이 판은 tmux 였습니다 — tmux a 로 다시 붙으세요.';
    }
  }
  const grp = state.groups.find((g) => g.id === leaf.groupId);
  if (grp) {
    setTimeout(() => refreshClaudeInfo(grp, true), 800);
    setTimeout(() => refreshCodexInfo(grp, true), 1600); // 두 조회가 겹치지 않게 살짝 늦춘다
    refreshAiTools(grp);
    /*
     * 파일 탐색기를 미리 붙여 둔다.
     * 예전에는 📁 를 누른 뒤에야 SFTP 를 열어서 몇 초를 기다려야 했다.
     * 화면에 붙이지는 않으므로(고정 상태가 아니면 DOM 밖에 있다) 눌렀을 때
     * 이미 목록이 준비되어 있다.
     */
    if (!grp.explorer) setTimeout(() => ensureExplorer(grp, true), 500);
  }
  // 완료/대기 알림 훅을 그 서버에 한 번 설치한다.
  // claude 는 ~/.claude/settings.json 의 훅, codex 는 ~/.codex/config.toml 의 notify 를 쓴다.
  // 둘 다 이미 실행 중인 프로세스에는 다음 실행부터 적용된다.
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
  if (grp && !grp.codexHooksInstalled) {
    grp.codexHooksInstalled = true;
    setTimeout(() => {
      api.codex.installHooks(id).then((ok) => {
        if (!ok) {
          // 대개 사용자가 이미 자기 notify 를 쓰고 있어서 건드리지 않은 경우다.
          // (남의 설정을 덮어쓰지 않는 것이 맞으므로 실패로 두고 알리기만 한다)
          console.warn('[armux] codex 완료 알림을 설치하지 못했습니다 — config.toml 의 notify 가 이미 쓰이는 중일 수 있습니다.');
        }
      }).catch((e) => {
        grp.codexHooksInstalled = false;
        console.warn('[armux] codex 알림 설치 오류:', e && e.message);
      });
    }, 2000);
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

/*
 * 판 상태 관찰기가 2초마다 보내 주는 결과.
 * "어느 창이 보이고, 각 창에서 무엇이 돌고 있는지" 를 그대로 담고 있다.
 * 창을 옮기든 tmux 를 빠져나가든 다음 틱에 저절로 맞춰진다.
 */
api.ssh.onPaneState(({ id, ...st }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  leaf.probe = st;
  leaf.probeAt = Date.now(); // 살아 있다는 증거 (끊기면 dropStaleProbes 가 표시를 내린다)
  evaluatePanes(leaf);
});

api.ssh.onExit(({ id, clean }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  sessionToLeaf.delete(id);
  leaf.sessionId = null;
  resetPaneState(leaf); // 끊긴 판의 옛 관찰 결과로 판정하지 않는다
  // 사용자가 exit 를 쳐서 끝난 것이면 그대로 둔다. 끊긴 것이면 스스로 다시 붙는다.
  if (clean || !beginRetry(leaf, '연결이 끊겼습니다')) {
    leaf.status = 'closed';
    leaf.term.writeln('\r\n\x1b[90m● 연결이 종료되었습니다. Enter 를 누르면 다시 접속합니다.\x1b[0m');
  }
  render();
});

api.ssh.onError(({ id, message, code }) => {
  const leaf = sessionToLeaf.get(id);
  if (!leaf) return;
  sessionToLeaf.delete(id);
  leaf.sessionId = null;
  resetPaneState(leaf);
  leaf.term.writeln(`\r\n\x1b[31m✖ ${message}\x1b[0m`);
  // 인증 실패처럼 다시 해도 똑같은 것은 재시도하지 않는다
  if (isFatalConnectError(message, code) || !beginRetry(leaf, message)) {
    leaf.status = 'error';
    leaf.term.writeln('\x1b[90m  Enter 를 누르면 다시 시도합니다.\x1b[0m');
  }
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
      if (isTextInput(document.activeElement)) api.util.edit('copy');
      else if (domSel) api.util.clipboardWrite(domSel);
      else if (l && l.mode !== 'web' && l.term.hasSelection()) api.util.clipboardWrite(l.term.getSelection());
      break;
    }
    case 'cut':
      if (isTextInput(document.activeElement)) api.util.edit('cut');
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
      /*
       * 입력칸(접속 창·메모장·주소창)에서는 네이티브 붙여넣기를 시킨다.
       * 크로미움은 웹 내용이 스스로 붙여넣는 것을 막아 두어서
       * document.execCommand('paste') 는 조용히 아무 일도 하지 않는다.
       * 맥은 ⌘V 를 메뉴가 먼저 가져가므로, 이 길이 막히면 붙여넣기 자체가 안 됐다.
       */
      if (isTextInput(document.activeElement)) {
        api.util.edit('paste');
        break;
      }
      if (!l || l.status !== 'ready' || l.mode === 'web') break;
      /*
       * 터미널에서는 그림(스크린샷)이면 서버로 올리고 경로를 적어 준다.
       * 맥은 ⌘V 를 메뉴가 먼저 가져가서 아래 keydown 경로를 타지 않으므로,
       * 여기에도 같은 처리가 있어야 맥에서도 스크린샷 붙여넣기가 된다.
       */
      if (await pasteImageIntoTerminal(l)) break;
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
    case 'option': // 보기 메뉴의 켬/끔 (mac 시스템 메뉴)
      if (arg && arg.key) setOption(arg.key, arg.on);
      break;
    case 'ai':
      toggleAiPop();
      break;
    case 'quickmemo':
      toggleQuickMemo();
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

    /*
     * 퀵메모 창 안에 커서가 있으면 앱 단축키는 끼어들지 않는다.
     * 글을 쓰는 자리라 ⌘W(판 닫기)·⌘S 같은 것이 여기서 먹으면 곤란하다.
     * 여닫기(Ctrl/⌘+M)만 남기고, 나머지는 메모창이 알아서 처리한다.
     */
    // (target 이 요소가 아닐 수도 있다 — contains 에 요소가 아닌 것을 넣으면 예외가 난다)
    if (qmOpen && qmPop && e.target instanceof Node && qmPop.el.contains(e.target)) {
      if (hasMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        e.stopPropagation();
        toggleQuickMemo();
      }
      return;
    }

    // 서브탭: mac ⌘+숫자 / win Ctrl+숫자
    // 메인탭: mac ⌘+Control+숫자 / win Ctrl+Alt+숫자
    if (hasMod(e) && !e.shiftKey) {
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m && !(isMacPlatform && e.altKey)) {
        // mac ⌘⌃숫자 / win Ctrl+Alt+숫자 가 메인탭. 설정에서 서브탭과 맞바꿀 수 있다.
        const second = isMacPlatform ? e.ctrlKey : e.altKey;
        const toGroup = prefs.swapTabKeys ? !second : second;
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
        /*
         * 클립보드에 그림(스크린샷)이 있으면 서버로 올리고 경로를 적어 준다.
         * Claude Code 는 서버에서 돌아가 내 PC 클립보드를 볼 수 없기 때문이다.
         * 그림이 아니면 지금까지처럼 글자를 그대로 붙여넣는다.
         */
        pasteImageIntoTerminal(leaf).then((wasImage) => {
          if (wasImage) return;
          api.util.clipboardRead().then((text) => text && api.ssh.write(leaf.sessionId, text));
        });
        return;
      }
    }

    /*
     * 나머지 단축키는 표(KEY_ACTIONS)에서 찾아 처리한다.
     * 설정 ▸ 단축키 에서 바꾼 키가 곧바로 반영되고, 예전 키는 더 이상 듣지 않는다.
     * (복사·붙여넣기처럼 터미널 입력과 얽힌 키는 위에서 따로 다루고 바꿀 수 없다)
     */
    {
      const act = actionForEvent(e);
      if (act) {
        e.preventDefault();
        e.stopPropagation();
        runAction(act);
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
const updateMacBox = document.getElementById('update-mac');
const updateMacCmd = document.getElementById('update-mac-cmd');

/*
 * 맥은 앱 안에서 설치까지 되지 않는다.
 * 자동 설치는 Electron 내장 Squirrel.Mac 이 맡는데, 새 앱의 코드 서명이 지금
 * 실행 중인 앱의 요구조건을 만족하는지 검사한다. 지금 빌드는 애드혹 서명이라
 * 그 검사를 통과할 수 없다(정식 서명을 하려면 Apple Developer ID 가 필요하다).
 *
 * 그래서 맥에서는 "내려받기" 대신 한 줄 명령을 건네준다. 이 명령은 curl 로
 * 받으므로 격리 딱지가 붙지 않아 "시스템 설정 → 확인 없이 열기" 도 필요 없다.
 */
const MAC_INSTALL_CMD =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/silvergt/armux/main/scripts/install-mac.sh)"';
updateMacCmd.textContent = MAC_INSTALL_CMD;
document.getElementById('update-mac-copy').addEventListener('click', (e) => {
  api.util.clipboardWrite(MAC_INSTALL_CMD);
  e.target.textContent = '복사됨';
  setTimeout(() => {
    e.target.textContent = '복사';
  }, 1200);
});

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

  /*
   * 맥에서 새 버전이 있으면 한 줄 명령을 보여 주고, 되지도 않을 "내려받기" 는
   * 감춘다 (받아 봐야 마지막 설치에서 멈춘다).
   */
  const macManual = isMacPlatform && (st.status === 'available' || st.status === 'error');
  updateMacBox.classList.toggle('hidden', !macManual);
  if (macManual && st.status === 'available') {
    updateMsg.textContent = `새 버전 v${st.version} 이(가) 있습니다.`;
  }

  const canAct = (st.status === 'available' || st.status === 'ready') && !(isMacPlatform && st.status === 'available');
  updateAction.classList.toggle('hidden', !canAct);
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
  const l = activeLeaf();
  // 파일 판이면 터미널 검색바 대신 그 파일 안에서 찾는다
  if (l && l.mode === 'file' && l.file && l.file.openFind) {
    l.file.openFind();
    return;
  }
  if (!l) return;
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
  localBtn: document.getElementById('modal-local'),
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
  // '로컬 터미널' 은 상단 탭에 있는 즉시 실행 버튼이라 모드와 무관하게 늘 보인다
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
dlg.localBtn.addEventListener('click', () => {
  const target = dlgTargetGroup;
  closeDialog();
  if (target) createTab(target, { local: true }); // 기존 그룹에 로컬 서브탭
  else createLocalGroup();
});
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
    hint.textContent = '아직 즐겨찾기가 없습니다. 웹페이지를 연 뒤 주소창 옆 ☆ 을 눌러 등록하세요.';
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

/*
 * 어디선가 조용히 실패한 것을 하단바에 드러낸다.
 * IPC 호출 상당수가 실패를 그대로 거부로 돌려주는데, 부르는 쪽에서 잡지 않으면
 * "아무 일도 안 일어난 것" 처럼 보였다. 최소한 무엇이 실패했는지는 보이게 한다.
 */
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason && e.reason.message) || e.reason || '').replace(/^Error:\s*/, '');
  console.error('[armux] 처리되지 않은 거부:', e.reason);
  if (msg) el.statusLeft.textContent = `문제가 있었습니다: ${msg.slice(0, 120)}`;
});
window.addEventListener('error', (e) => {
  console.error('[armux] 화면 오류:', e.error || e.message);
});

/* --------------------------------- 시작 동작 -------------------------------- */

// 접속한 서버들의 Claude 사용량을 주기적으로 갱신 (활성 그룹 위주)
claudePollTimer = setInterval(() => {
  /*
   * 보고 있는 그룹을 먼저, 그다음 나머지 접속된 그룹도 훑는다.
   * 예전에는 보고 있는 그룹만 갱신해서, 탭을 옮기면 그 서버의 막대가
   * 한참 뒤에야 뜨거나 아예 안 뜬 채로 남았다.
   * 한 번에 하나씩만 부른다 — 안쪽의 15초 문턱이 나머지를 다음 차례로 미룬다.
   */
  const g = activeGroup();
  if (g) {
    refreshClaudeInfo(g);
    refreshCodexInfo(g);
  }
  for (const other of state.groups) {
    if (other === g) continue;
    refreshClaudeInfo(other);
    refreshCodexInfo(other);
  }
  renderClaudeStatus(); // 초기화까지 남은 시간을 갱신
}, 20000);

// 시작: 지난번 탭 구성이 있으면 되살리고, 없으면 빈 검은 화면.
render();
restoreSession();
