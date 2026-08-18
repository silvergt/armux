'use strict';

/**
 * 판(페인) 안의 AI 채팅 — claude.ai 처럼 대화하되, 실제 실행은 원격(또는 로컬)
 * 서버의 `claude -p` 다. 이어지는 질문은 --resume 으로 맥락이 유지된다.
 *
 * 📎 컨텍스트 버튼으로 같은 서브탭의 다른 판(터미널 화면·웹페이지 본문)을
 * 첨부해 그 내용에 대해 물어볼 수 있다. 첨부는 다음 한 번의 질문에만 붙는다.
 */

window.AiChat = (function () {
  const api = window.armux;

  /**
   * @param {object} opts
   *   getSessionId()      질문을 실행할 SSH/로컬 세션 id
   *   getContextSources() [{ label, get: async () => text }] — 첨부 가능한 판 목록
   *   hostLabel           머리에 보여 줄 대상 이름
   */
  function create(opts) {
    const state = { resumeId: null, busy: false, pending: null }; // pending = 다음 질문에 붙일 첨부

    const root = document.createElement('div');
    root.className = 'aichat';

    /* --------------------------------- 머리 --------------------------------- */
    const head = document.createElement('div');
    head.className = 'ac-head';
    const title = document.createElement('span');
    title.className = 'ac-title';
    title.textContent = `✳ AI 채팅${opts.hostLabel ? ` — ${opts.hostLabel}` : ''}`;
    const chip = document.createElement('span'); // 첨부 표시
    chip.className = 'ac-chip hidden';
    const newBtn = document.createElement('button');
    newBtn.className = 'ac-hbtn';
    newBtn.textContent = '새 대화';
    newBtn.title = '대화를 새로 시작 (기록은 남습니다)';
    newBtn.addEventListener('click', () => {
      if (log.childElementCount > 0) divider('새 대화');
      state.resumeId = null;
      clearPending();
      input.focus();
    });
    head.append(title, chip, newBtn);

    /* --------------------------------- 로그 --------------------------------- */
    const log = document.createElement('div');
    log.className = 'ac-log';
    const empty = document.createElement('div');
    empty.className = 'ac-empty';
    empty.textContent =
      '무엇이든 물어보세요. 답변은 서버에 로그인된 Claude 계정(claude -p)으로 실행됩니다.\n📎 컨텍스트 로 옆 판의 터미널 화면이나 웹페이지 내용을 첨부할 수 있습니다.';
    log.appendChild(empty);

    const addMsg = (cls, text) => {
      if (empty.parentNode) empty.remove();
      const m = document.createElement('div');
      m.className = `ac-msg ac-${cls}`;
      m.textContent = text;
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    };
    const divider = (text) => {
      if (empty.parentNode) empty.remove();
      const d = document.createElement('div');
      d.className = 'ac-divider';
      d.textContent = text;
      log.appendChild(d);
    };

    /* -------------------------------- 입력 줄 -------------------------------- */
    const row = document.createElement('div');
    row.className = 'ac-row';
    const ctxBtn = document.createElement('button');
    ctxBtn.className = 'ac-hbtn';
    ctxBtn.textContent = '📎';
    ctxBtn.title = '옆 판의 내용을 다음 질문에 첨부';
    const input = document.createElement('textarea');
    input.className = 'ac-input';
    input.rows = 1;
    input.spellcheck = false;
    input.placeholder = '메시지 입력 (Enter 전송 · Shift+Enter 줄바꿈)';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'ac-send';
    sendBtn.textContent = '전송';
    row.append(ctxBtn, input, sendBtn);

    root.append(head, log, row);

    /* ------------------------------- 컨텍스트 첨부 ------------------------------ */

    function clearPending() {
      state.pending = null;
      chip.classList.add('hidden');
      chip.textContent = '';
    }

    ctxBtn.addEventListener('click', (ev) => {
      const sources = (opts.getContextSources && opts.getContextSources()) || [];
      const items = sources.map((src) => [
        src.label,
        async () => {
          const text = await src.get();
          if (!text) {
            chip.classList.remove('hidden');
            chip.textContent = '첨부할 내용이 없습니다';
            setTimeout(clearPending, 1800);
            return;
          }
          state.pending = { label: src.label, text };
          chip.classList.remove('hidden');
          chip.textContent = `📎 ${src.label} (${text.length}자) ✕`;
          input.focus();
        }
      ]);
      if (!items.length) items.push(['첨부할 판이 없습니다', () => {}]);
      const r = ev.currentTarget.getBoundingClientRect();
      // 렌더러의 공용 컨텍스트 메뉴를 쓴다
      window.showContextMenu(r.left, r.top - 8 - items.length * 26, items);
    });
    chip.addEventListener('click', clearPending); // 첨부 취소

    /* --------------------------------- 전송 --------------------------------- */

    async function send() {
      const q = input.value.trim();
      if (!q || state.busy) return;
      const sessionId = opts.getSessionId && opts.getSessionId();
      if (!sessionId) {
        addMsg('err', '연결된 세션이 없습니다. 이 그룹의 터미널이 접속된 뒤에 다시 시도하세요.');
        return;
      }
      input.value = '';
      autosize();
      addMsg('user', state.pending ? `[📎 ${state.pending.label}]\n${q}` : q);

      let prompt = q;
      if (state.pending) {
        prompt =
          `다음은 사용자가 첨부한 "${state.pending.label}" 의 내용입니다.\n` +
          '이 내용을 참고해 아래 질문에 한국어로 답하세요.\n' +
          '```\n' + state.pending.text + '\n```\n\n질문: ' + q;
        clearPending();
      }

      state.busy = true;
      sendBtn.disabled = true;
      const wait = addMsg('wait', '생각 중…');
      try {
        const res = await api.ai.ask(sessionId, prompt, state.resumeId);
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
        sendBtn.disabled = false;
        input.focus();
      }
    }

    const autosize = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    };
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    sendBtn.addEventListener('click', send);

    return {
      el: root,
      focus: () => input.focus(),
      dispose: () => root.remove()
    };
  }

  return { create };
})();
