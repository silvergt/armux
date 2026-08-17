'use strict';

/* global Terminal, FitAddon, WebLinksAddon, SearchAddon */

/**
 * Armux Terminal 렌더러.
 *
 * 탭 구조는 2단계다.
 *   - 그룹(메인탭)  : 상단 탭바의 각 항목 = "세로 열". Ctrl+Shift+숫자 로 이동.
 *   - 탭(서브탭)    : 그룹 아래 탭바의 각 항목 = "가로 줄". Ctrl+숫자 로 이동.
 * 그룹 하나는 하나의 SSH 호스트에 대응하고, 그 안의 서브탭들은 같은 호스트로의 별도 셸 세션이다.
 */

const api = window.armux;

/* --------------------------------- 전역 상태 --------------------------------- */

const state = {
  groups: [], // [{ id, host, credId, tabs: [], activeTabId }]
  activeGroupId: null,
  fontSize: Number(localStorage.getItem('fontSize')) || 13
};

const sessionToTab = new Map(); // sessionId -> tab (IPC 이벤트 라우팅용)
let uid = 0;
const nextId = (prefix) => `${prefix}${++uid}`;

/* --------------------------------- DOM 참조 --------------------------------- */

const el = {
  body: document.body,
  tabstrip: document.getElementById('tabstrip'),
  substrip: document.getElementById('substrip'),
  terms: document.getElementById('terms'),
  emptyState: document.getElementById('empty-state'),
  newGroupBtn: document.getElementById('new-group-btn'),
  statusLeft: document.getElementById('status-left'),
  statusRight: document.getElementById('status-right'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('find-input')
};

if (api.platform === 'darwin') el.body.classList.add('is-mac');

/* -------------------------------- 터미널 테마 -------------------------------- */

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

const FONT_STACK =
  'Menlo, "SF Mono", Consolas, "Cascadia Mono", "DejaVu Sans Mono", "D2Coding", "Nanum Gothic Coding", monospace';

/* ------------------------------- 상태 조회 헬퍼 ------------------------------- */

const activeGroup = () => state.groups.find((g) => g.id === state.activeGroupId) || null;
const activeTab = () => {
  const g = activeGroup();
  return g ? g.tabs.find((t) => t.id === g.activeTabId) || null : null;
};

/* --------------------------------- 세션 생성 --------------------------------- */

/**
 * 새 SSH 세션 탭을 만든다.
 * @param {object} group    소속 그룹
 * @param {object} connect  { hostId, credId, profile, save } 접속 파라미터
 */
async function createTab(group, connect) {
  const tab = {
    id: nextId('t'),
    groupId: group.id,
    sessionId: null,
    title: group.host.name,
    status: 'connecting', // connecting | ready | closed | error
    pane: null,
    term: null,
    fit: null,
    search: null,
    connect // 재연결에 사용할 접속 파라미터 보관
  };

  // 터미널 DOM/인스턴스 생성
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  el.terms.appendChild(pane);

  const term = new Terminal({
    fontFamily: FONT_STACK,
    fontSize: state.fontSize,
    theme: THEME,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  try {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  } catch (e) {
    /* 링크 애드온 실패는 무시 */
  }
  term.open(pane);

  tab.pane = pane;
  tab.term = term;
  tab.fit = fit;
  tab.search = search;

  // 키 입력 → SSH 로 전달
  term.onData((data) => {
    if (tab.sessionId && tab.status === 'ready') {
      api.ssh.write(tab.sessionId, data);
    } else if (tab.status === 'closed' || tab.status === 'error') {
      // 종료된 탭에서 Enter 를 누르면 같은 호스트로 재접속
      if (data === '\r') reconnect(tab);
    }
  });

  // 셸이 보낸 타이틀(OSC 0/2)을 탭 이름으로 사용
  term.onTitleChange((title) => {
    if (!title) return;
    tab.title = title;
    scheduleRender();
  });

  // 드래그 선택 시 자동 복사 (iTerm 동작)
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) api.util.clipboardWrite(sel);
  });

  // 우클릭 붙여넣기
  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const text = await api.util.clipboardRead();
    if (text && tab.sessionId && tab.status === 'ready') api.ssh.write(tab.sessionId, text);
  });

  group.tabs.push(tab);
  group.activeTabId = tab.id;
  state.activeGroupId = group.id;
  render();
  fitTab(tab);

  await startSession(tab);
  return tab;
}

/** 실제 SSH 접속을 시작한다 (탭/터미널은 이미 준비된 상태) */
async function startSession(tab) {
  const group = state.groups.find((g) => g.id === tab.groupId);
  const h = group.host;
  tab.status = 'connecting';
  tab.term.writeln(`\x1b[90m→ ${h.username}@${h.host}:${h.port} 접속 중…\x1b[0m`);
  render();

  try {
    const res = await api.ssh.connect({
      ...tab.connect,
      size: { cols: tab.term.cols, rows: tab.term.rows }
    });
    tab.sessionId = res.sessionId;
    sessionToTab.set(res.sessionId, tab);

    // 그룹이 아직 임시 정보만 갖고 있으면 서버가 확정한 값으로 갱신
    group.host = { ...group.host, ...res.host };
    // 이후 서브탭은 같은 자격증명으로 접속할 수 있도록 토큰 보관
    group.credId = res.credId || group.credId;
    group.connect = { hostId: res.host.id || null, credId: group.credId };
    tab.connect = { ...group.connect };
    render();
  } catch (err) {
    tab.status = 'error';
    tab.term.writeln(`\r\n\x1b[31m✖ 접속 실패: ${String(err.message || err).replace(/^Error:\s*/, '')}\x1b[0m`);
    tab.term.writeln('\x1b[90m  Enter 를 누르면 다시 시도합니다.\x1b[0m');
    render();
  }
}

/** 종료/실패한 탭을 같은 접속 정보로 다시 연결 */
function reconnect(tab) {
  if (tab.sessionId) sessionToTab.delete(tab.sessionId);
  tab.sessionId = null;
  tab.term.reset();
  startSession(tab);
}

/* --------------------------------- 그룹 관리 --------------------------------- */

/** 새 메인탭(그룹)을 만들고 첫 세션을 연다 */
async function createGroup(hostInfo, connect) {
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
    activeTabId: null
  };
  state.groups.push(group);
  state.activeGroupId = group.id;
  await createTab(group, connect);
  return group;
}

/** 기존 그룹에 서브탭 추가 (같은 호스트로 새 셸) */
async function addSubTab(group) {
  const connect = group.connect || { hostId: group.host.id || null, credId: group.credId };
  if (!connect.hostId && !connect.credId) {
    // 최초 접속이 실패해 자격증명이 없는 경우: 다이얼로그를 다시 띄운다
    openConnectDialog({ group });
    return;
  }
  await createTab(group, connect);
}

function closeTab(group, tab) {
  if (tab.sessionId) {
    api.ssh.close(tab.sessionId);
    sessionToTab.delete(tab.sessionId);
  }
  try {
    tab.term.dispose();
  } catch (e) {
    /* noop */
  }
  tab.pane.remove();

  const idx = group.tabs.indexOf(tab);
  group.tabs.splice(idx, 1);

  if (group.tabs.length === 0) {
    closeGroup(group);
    return;
  }
  if (group.activeTabId === tab.id) {
    const next = group.tabs[Math.min(idx, group.tabs.length - 1)];
    group.activeTabId = next.id;
  }
  render();
  fitTab(activeTab());
}

function closeGroup(group) {
  for (const t of [...group.tabs]) {
    if (t.sessionId) {
      api.ssh.close(t.sessionId);
      sessionToTab.delete(t.sessionId);
    }
    try {
      t.term.dispose();
    } catch (e) {
      /* noop */
    }
    t.pane.remove();
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

/* --------------------------------- 탭 활성화 -------------------------------- */

function selectGroup(groupId) {
  if (state.activeGroupId === groupId) return;
  state.activeGroupId = groupId;
  render();
  const t = activeTab();
  fitTab(t);
  if (t) t.term.focus();
}

function selectTab(group, tabId) {
  group.activeTabId = tabId;
  state.activeGroupId = group.id;
  render();
  const t = activeTab();
  fitTab(t);
  if (t) t.term.focus();
}

/** Ctrl+Shift+숫자 : n번째 메인탭 */
function selectGroupByIndex(i) {
  const g = state.groups[i];
  if (g) selectGroup(g.id);
}

/** Ctrl+숫자 : 현재 그룹의 n번째 서브탭 */
function selectTabByIndex(i) {
  const g = activeGroup();
  if (!g) return;
  const t = g.tabs[i];
  if (t) selectTab(g, t.id);
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
  el.emptyState.classList.toggle('hidden', state.groups.length > 0);
}

function renderTabstrip() {
  // 탭이 다시 그려지면 떠 있던 + 버튼의 기준 탭이 사라졌을 수 있으므로 정리
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
    node.title = `${group.host.username}@${group.host.host}:${group.host.port}`;

    const dot = document.createElement('span');
    dot.className = 'dot ' + (cur ? cur.status : 'closed');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = gi < 9 ? `⇧${gi + 1}` : ''; // Ctrl+Shift+숫자

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = group.host.name + (group.tabs.length > 1 ? ` (${group.tabs.length})` : '');

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmCloseGroup(group);
    });

    node.append(dot, idx, label, close);
    node.addEventListener('click', () => selectGroup(group.id));
    // 탭에 마우스를 올리면 탭 아래에 "서브탭 추가(+)" 버튼을 띄운다
    node.addEventListener('mouseenter', () => showHoverAdd(node, group));
    node.addEventListener('mouseleave', () => hideHoverAdd());
    node.addEventListener('auxclick', (e) => {
      if (e.button === 1) confirmCloseGroup(group); // 휠클릭으로 닫기
    });
    el.tabstrip.appendChild(node);
  });
}

/* ------------------------- 탭 호버 시 뜨는 서브탭 추가 버튼 ------------------------ */

const hoverAdd = document.createElement('button');
hoverAdd.id = 'hover-add';
hoverAdd.className = 'hidden';
hoverAdd.textContent = '+';
hoverAdd.title = '이 그룹에 서브탭 추가 (Shift+클릭: 다른 호스트로 접속)';
document.body.appendChild(hoverAdd);

let hoverAddGroup = null; // 현재 + 버튼이 가리키는 그룹
let hoverAddTimer = null; // 탭 → 버튼으로 마우스가 넘어갈 시간을 주는 타이머

function showHoverAdd(tabNode, group) {
  clearTimeout(hoverAddTimer);
  hoverAddGroup = group;
  const r = tabNode.getBoundingClientRect();
  hoverAdd.style.left = `${Math.round(r.left + r.width / 2 - 12)}px`;
  hoverAdd.style.top = `${Math.round(r.bottom + 3)}px`;
  hoverAdd.classList.remove('hidden');
}

function hideHoverAdd() {
  // 탭에서 버튼으로 마우스를 옮기는 짧은 순간에는 사라지지 않도록 지연
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
  if (e.shiftKey) openConnectDialog({ group }); // Shift+클릭이면 다른 호스트로 접속
  else addSubTab(group);
});

function renderSubstrip() {
  const group = activeGroup();
  el.substrip.innerHTML = '';
  if (!group) {
    el.substrip.classList.add('hidden');
    return;
  }
  el.substrip.classList.remove('hidden');

  group.tabs.forEach((tab, ti) => {
    const node = document.createElement('div');
    node.className = 'subtab' + (tab.id === group.activeTabId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'dot ' + tab.status;

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = ti < 9 ? `${ti + 1}` : ''; // Ctrl+숫자

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.title;

    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '✕';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(group, tab);
    });

    node.append(dot, idx, label, close);
    node.addEventListener('click', () => selectTab(group, tab.id));
    node.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(group, tab);
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
  const cur = activeTab();
  for (const g of state.groups) {
    for (const t of g.tabs) {
      t.pane.classList.toggle('active', cur && t.id === cur.id);
    }
  }
}

function renderStatus() {
  const g = activeGroup();
  const t = activeTab();
  if (!g || !t) {
    el.statusLeft.textContent = '준비됨';
    el.statusRight.textContent = '';
    return;
  }
  const statusText = {
    connecting: '접속 중…',
    ready: '연결됨',
    closed: '연결 종료',
    error: '접속 실패'
  }[t.status];
  el.statusLeft.textContent = `${g.host.username}@${g.host.host}:${g.host.port} · ${statusText}`;
  el.statusRight.textContent = `${t.term.cols}×${t.term.rows} · ${state.fontSize}px · 메인 ${
    state.groups.indexOf(g) + 1
  }/${state.groups.length} · 서브 ${g.tabs.indexOf(t) + 1}/${g.tabs.length}`;
}

async function confirmCloseGroup(group) {
  if (group.tabs.length > 1) {
    const ok = await api.util.confirm(
      `"${group.host.name}" 탭을 닫을까요?`,
      `${group.tabs.length}개의 서브탭이 함께 종료됩니다.`
    );
    if (!ok) return;
  }
  closeGroup(group);
}

/* ------------------------------- 크기 조정 처리 ------------------------------- */

function fitTab(tab) {
  if (!tab) return;
  try {
    tab.fit.fit();
  } catch (e) {
    return;
  }
  if (tab.sessionId && tab.status === 'ready') {
    api.ssh.resize(tab.sessionId, tab.term.cols, tab.term.rows);
  }
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
      t.term.options.fontSize = state.fontSize;
    }
  }
  // 폰트 크기가 바뀌면 모든 탭의 셀 수가 바뀌므로 활성 탭 기준으로 다시 맞춘다
  fitTab(activeTab());
}

/* --------------------------------- IPC 수신 --------------------------------- */

api.ssh.onReady(({ id }) => {
  const tab = sessionToTab.get(id);
  if (!tab) return;
  tab.status = 'ready';
  api.ssh.resize(id, tab.term.cols, tab.term.rows);
  render();
  if (tab === activeTab()) tab.term.focus();
});

api.ssh.onData(({ id, data }) => {
  const tab = sessionToTab.get(id);
  if (tab) tab.term.write(data);
});

api.ssh.onExit(({ id }) => {
  const tab = sessionToTab.get(id);
  if (!tab) return;
  tab.status = 'closed';
  tab.term.writeln('\r\n\x1b[90m● 연결이 종료되었습니다. Enter 를 누르면 다시 접속합니다.\x1b[0m');
  sessionToTab.delete(id);
  tab.sessionId = null;
  render();
});

api.ssh.onError(({ id, message }) => {
  const tab = sessionToTab.get(id);
  if (!tab) return;
  tab.status = 'error';
  tab.term.writeln(`\r\n\x1b[31m✖ ${message}\x1b[0m`);
  tab.term.writeln('\x1b[90m  Enter 를 누르면 다시 시도합니다.\x1b[0m');
  sessionToTab.delete(id);
  tab.sessionId = null;
  render();
});

/* ------------------------------- 메뉴/단축키 명령 ------------------------------ */

api.onMenu(async (cmd, arg) => {
  const g = activeGroup();
  const t = activeTab();
  switch (cmd) {
    case 'new-group':
      openConnectDialog({});
      break;
    case 'new-subtab':
      if (g) addSubTab(g);
      else openConnectDialog({});
      break;
    case 'close-tab':
      if (g && t) closeTab(g, t);
      break;
    case 'copy':
      if (t && t.term.hasSelection()) api.util.clipboardWrite(t.term.getSelection());
      break;
    case 'paste': {
      if (!t || t.status !== 'ready') break;
      const text = await api.util.clipboardRead();
      if (text) api.ssh.write(t.sessionId, text);
      break;
    }
    case 'find':
      openFind();
      break;
    case 'font':
      setFontSize(arg === 0 ? 13 : state.fontSize + arg);
      break;
    default:
      break;
  }
});

// Ctrl+숫자 / Ctrl+Shift+숫자 로 탭 이동 (xterm 이 키를 먹기 전에 캡처 단계에서 처리)
window.addEventListener(
  'keydown',
  (e) => {
    if (!modalOpen() && e.ctrlKey && !e.altKey && !e.metaKey) {
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) {
        e.preventDefault();
        e.stopPropagation();
        const n = Number(m[1]) - 1;
        if (e.shiftKey) selectGroupByIndex(n);
        else selectTabByIndex(n);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (modalOpen()) closeDialog();
      else if (!el.findbar.classList.contains('hidden')) closeFind();
    }
  },
  true
);

el.newGroupBtn.addEventListener('click', () => openConnectDialog({}));

/* ---------------------------------- 검색바 ---------------------------------- */

function openFind() {
  if (!activeTab()) return;
  el.findbar.classList.remove('hidden');
  el.findInput.focus();
  el.findInput.select();
}
function closeFind() {
  el.findbar.classList.add('hidden');
  const t = activeTab();
  if (t) {
    t.search.clearDecorations();
    t.term.focus();
  }
}
function findNext(back) {
  const t = activeTab();
  if (!t) return;
  const q = el.findInput.value;
  if (!q) return;
  const opts = { decorations: { activeMatchBackground: '#f3f99d', matchBackground: '#3a4a5a' } };
  if (back) t.search.findPrevious(q, opts);
  else t.search.findNext(q, opts);
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
  save: document.getElementById('f-save'),
  savePw: document.getElementById('f-save-pw'),
  error: document.getElementById('modal-error'),
  connectBtn: document.getElementById('modal-connect'),
  cancelBtn: document.getElementById('modal-cancel'),
  closeBtn: document.getElementById('modal-close'),
  deleteBtn: document.getElementById('host-delete')
};

let dlgHosts = []; // 저장된 호스트 목록
let dlgSelectedId = null; // 목록에서 선택된 호스트 id
let dlgTargetGroup = null; // null 이면 새 그룹, 있으면 해당 그룹에 서브탭 추가
let canSavePassword = true; // OS 암호화 사용 가능 여부

const modalOpen = () => !dlg.backdrop.classList.contains('hidden');

async function openConnectDialog({ group }) {
  dlgTargetGroup = group || null;
  dlg.title.textContent = group ? `"${group.host.name}" 그룹에 서브탭 추가` : '새 SSH 접속';
  dlg.error.classList.add('hidden');
  dlg.backdrop.classList.remove('hidden');

  canSavePassword = await api.hosts.canSavePassword();
  dlg.savePw.disabled = !canSavePassword;
  dlg.savePw.parentElement.title = canSavePassword
    ? 'OS 키체인으로 암호화해 저장합니다.'
    : '이 환경에서는 안전한 암호화를 사용할 수 없어 비밀번호를 저장하지 않습니다.';

  dlgHosts = await api.hosts.list();
  dlgSelectedId = null;
  renderHostList();
  updateAuthRows();

  if (dlgHosts.length > 0) {
    selectHost(dlgHosts[0].id); // 가장 최근에 쓴 호스트를 기본 선택
  } else {
    clearForm();
    dlg.host.focus();
  }
}

function closeDialog() {
  dlg.backdrop.classList.add('hidden');
  dlg.password.value = '';
  dlg.passphrase.value = '';
  const t = activeTab();
  if (t) t.term.focus();
}

function renderHostList() {
  const q = dlg.filter.value.trim().toLowerCase();
  const items = dlgHosts.filter(
    (h) => !q || `${h.name} ${h.username}@${h.host}`.toLowerCase().includes(q)
  );
  dlg.list.innerHTML = '';
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = dlgHosts.length ? '검색 결과가 없습니다.' : '저장된 접속이 없습니다.';
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
    }${h.hasSavedPassword ? ' · 저장됨' : ''}`;
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
    dlg.save.checked = true;
    dlg.savePw.checked = false;
  }
  dlg.deleteBtn.classList.remove('hidden');
  updateAuthRows();
  renderHostList();
}

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
  dlg.deleteBtn.classList.add('hidden');
  updateAuthRows();
  renderHostList();
}

/** 인증 방식에 따라 비밀번호 / 키 관련 입력을 보여주거나 숨긴다 */
function updateAuthRows() {
  const isPw = dlg.auth.value === 'password';
  const isKey = dlg.auth.value === 'key';
  document.querySelectorAll('.row-password').forEach((n) => n.classList.toggle('hidden', !isPw));
  document.querySelectorAll('.row-key').forEach((n) => n.classList.toggle('hidden', !isKey));
}

// 폼을 직접 수정하면 "저장된 호스트 선택" 상태를 해제하지 않고 값만 덮어쓴다(임시 변경).
for (const f of [dlg.name, dlg.host, dlg.port, dlg.user]) {
  f.addEventListener('input', () => {
    dlg.deleteBtn.classList.toggle('hidden', !dlgSelectedId);
  });
}

dlg.auth.addEventListener('change', updateAuthRows);
dlg.filter.addEventListener('input', renderHostList);
dlg.keyBrowse.addEventListener('click', async () => {
  const p = await api.util.pickKeyFile();
  if (p) dlg.key.value = p;
});
dlg.closeBtn.addEventListener('click', closeDialog);
dlg.cancelBtn.addEventListener('click', closeDialog);
dlg.connectBtn.addEventListener('click', () => doConnect());
dlg.deleteBtn.addEventListener('click', async () => {
  if (!dlgSelectedId) return;
  const h = dlgHosts.find((x) => x.id === dlgSelectedId);
  const ok = await api.util.confirm(`"${h.name}" 접속 정보를 삭제할까요?`, `${h.username}@${h.host}:${h.port}`);
  if (!ok) return;
  await api.hosts.remove(dlgSelectedId);
  dlgHosts = await api.hosts.list();
  clearForm();
});

dlg.backdrop.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialog();
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') doConnect();
  e.stopPropagation();
});
dlg.backdrop.addEventListener('mousedown', (e) => {
  if (e.target === dlg.backdrop) closeDialog();
});

/** 다이얼로그 입력값으로 접속 실행 */
async function doConnect() {
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
  if (!profile.host) return showDlgError('호스트를 입력하세요.');
  if (!profile.username) return showDlgError('사용자 이름을 입력하세요.');
  if (!profile.name) profile.name = `${profile.username}@${profile.host}`;

  const connect = {
    hostId: dlgSelectedId || null,
    profile,
    save: dlg.save.checked
  };

  closeDialog();
  if (dlgTargetGroup) {
    await createTab(dlgTargetGroup, connect);
  } else {
    await createGroup(profile, connect);
  }
}

function showDlgError(msg) {
  dlg.error.textContent = msg;
  dlg.error.classList.remove('hidden');
}

/* --------------------------------- 시작 동작 -------------------------------- */

// 시작 시에는 빈 검은 터미널 화면만 보여준다. 접속은 상단 + 버튼 / Ctrl(⌘)+N 으로 시작.
render();
