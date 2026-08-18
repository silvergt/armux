'use strict';

/**
 * AI 질문 창 (독립 윈도우).
 *
 * 메인 창에서 Ctrl/⌘+K 를 누르면 이 창이 열리고, 그때의 판 화면(또는 선택한
 * 글자)이 컨텍스트로 넘어온다. 질문은 그 판의 SSH 연결을 빌려 원격 서버의
 * `claude -p` 로 실행되고, 이어지는 질문은 --resume 으로 맥락이 유지된다.
 * 터미널 화면을 전혀 가리지 않으며, 다른 모니터로 옮기거나 📌 로 항상 위에
 * 고정해 둘 수 있다.
 */

const api = window.armux;

const el = {
  ctx: document.getElementById('ctx'),
  log: document.getElementById('log'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  pin: document.getElementById('pin'),
  newchat: document.getElementById('newchat')
};

const state = {
  sshSessionId: null, // 질문을 실행할 SSH 세션
  hostLabel: '',
  context: '', // 첫 질문에 붙일 화면/선택 내용 (보내고 나면 비운다)
  contextLabel: '',
  resumeId: null, // claude -p 대화 이어가기
  busy: false,
  pinned: false
};

function addMsg(cls, text) {
  const m = document.createElement('div');
  m.className = `msg m-${cls}`;
  m.textContent = text;
  el.log.appendChild(m);
  el.log.scrollTop = el.log.scrollHeight;
  return m;
}

function addDivider(text) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.textContent = text;
  el.log.appendChild(d);
  el.log.scrollTop = el.log.scrollHeight;
}

function paintCtx() {
  el.ctx.textContent = state.hostLabel
    ? `${state.hostLabel} · ${state.context ? state.contextLabel : state.resumeId ? '대화 이어가는 중' : '대기'}`
    : '';
  el.ctx.title = el.ctx.textContent;
}

/** 메인 창이 Ctrl/⌘+K 로 보내는 새 컨텍스트 */
api.ai.onContext((p) => {
  const changedTarget = state.sshSessionId && state.sshSessionId !== p.sshSessionId;
  state.sshSessionId = p.sshSessionId;
  state.hostLabel = p.hostLabel || '';
  state.context = p.context || '';
  state.contextLabel = p.contextLabel || '화면 내용 포함';
  // 대화가 이미 있으면 구분선을 긋고 새 대화로 시작한다
  // (새 화면에 대한 질문에 옛 맥락이 섞이지 않도록)
  if (el.log.childElementCount > 0) {
    addDivider(`새 컨텍스트 — ${state.hostLabel}${changedTarget ? ' (다른 세션)' : ''}`);
  }
  state.resumeId = null;
  paintCtx();
  el.input.focus();
});

async function send() {
  const q = el.input.value.trim();
  if (!q || state.busy) return;
  if (!state.sshSessionId) {
    addMsg('err', '대상 터미널이 없습니다. 터미널 판에서 Ctrl/⌘+K 로 다시 열어 주세요.');
    return;
  }
  el.input.value = '';
  autosize();
  addMsg('user', q);

  // 첫 질문에만 컨텍스트를 붙인다 (이후는 --resume 이 맥락을 기억)
  let prompt = q;
  if (!state.resumeId && state.context) {
    prompt =
      `다음은 SSH 터미널 ${state.contextLabel.includes('선택') ? '에서 사용자가 선택한 내용' : '화면에 지금 보이는 내용'}입니다.\n` +
      '이 내용을 참고해 아래 질문에 한국어로 간결하게 답하세요.\n' +
      '```\n' + state.context + '\n```\n\n질문: ' + q;
    state.context = ''; // 한 번만 보낸다
  }

  state.busy = true;
  el.send.disabled = true;
  const wait = addMsg('wait', '생각 중…');
  try {
    const res = await api.ai.ask(state.sshSessionId, prompt, state.resumeId);
    wait.remove();
    if (res.error) addMsg('err', res.error);
    else {
      state.resumeId = res.sessionId || state.resumeId;
      addMsg('ai', res.result || '(빈 응답)');
    }
  } catch (err) {
    wait.remove();
    addMsg('err', `실패: ${String((err && err.message) || err).replace(/^Error:\s*/, '')}`);
  } finally {
    state.busy = false;
    el.send.disabled = false;
    paintCtx();
    el.input.focus();
  }
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(120, el.input.scrollHeight) + 'px';
}

el.input.addEventListener('input', autosize);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
el.send.addEventListener('click', send);

el.pin.addEventListener('click', async () => {
  state.pinned = await api.ai.togglePin();
  el.pin.classList.toggle('on', state.pinned);
  el.pin.textContent = state.pinned ? '📌 고정됨' : '📌 고정';
});

el.newchat.addEventListener('click', () => {
  if (el.log.childElementCount > 0) addDivider('새 대화');
  state.resumeId = null;
  state.context = '';
  paintCtx();
  el.input.focus();
});

el.input.focus();
