'use strict';

/**
 * 판(페인) 안의 AI 채팅 — claude.ai 처럼 대화하되, 실제 실행은 원격(또는 로컬)
 * 서버의 `claude -p` 다. 이어지는 질문은 --resume 으로 맥락이 유지된다.
 *
 * 📎 컨텍스트 버튼으로 같은 서브탭의 다른 판(터미널 화면·웹페이지 본문)을
 * 첨부해 그 내용에 대해 물어볼 수 있다. 첨부는 다음 한 번의 질문에만 붙는다.
 * Ctrl/⌘+K 로 이 판을 열면 누른 판의 내용이 자동으로 첨부된다.
 *
 * "새 대화" 를 누르면 지금 대화는 화면에서 사라지고 기록(아카이브)으로 넘어간다.
 * 머리의 "기록" 버튼으로 지난 대화를 다시 꺼내 볼 수 있다.
 */

window.AiChat = (function () {
  const api = window.armux;

  // 스트리밍 델타 라우팅: reqId → 처리 함수 (판이 여러 개여도 알맞은 채팅으로)
  let reqSeq = 0;
  const pendingReqs = new Map();
  if (api.ai.onDelta) {
    api.ai.onDelta((p) => {
      const h = pendingReqs.get(p.reqId);
      if (h) h(p);
    });
  }

  // 전체보기는 앱 전체 설정이라, 열려 있는 모든 채팅의 단추 표시를 같이 바꾼다
  const chatMaxPainters = [];
  function paintAllMaxButtons(on) {
    for (const f of chatMaxPainters) f(on);
  }

  /** 12:34 · 오늘이 아니면 3/15 12:34 */
  function timeLabel(ts) {
    const d = new Date(ts);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  /**
   * @param {object} opts
   *   getTarget(bindKey)  이번 질문을 실행할 곳 { sessionId, key, label }
   *                       key 는 "어느 서버인지" 를 나타내는 값이다. 대화가 매인
   *                       서버가 바뀌면(=key 가 달라지면) 새 대화로 시작한다.
   *   getContextSources() [{ label, get: async () => text }] — 첨부 가능한 판 목록
   *   hostLabel           머리에 보여 줄 대상 이름
   */
  function create(opts) {
    const state = {
      tool: 'claude', // 'claude' | 'codex' — 어느 CLI 로 물어볼지 (기본 claude)
      /*
       * 이어 말하기 id 는 "그 서버에 있는" 대화 id 다. 그래서 대화가 어느 서버에
       * 매여 있는지도 같이 들고 있어야 한다. 서버를 옮겨 다니며 물어보면
       * 그쪽에 없는 id 로 --resume 을 걸어 오류가 났다.
       */
      bindKey: null, // 이 대화가 매인 서버 (getTarget 이 주는 값)
      resumeId: null, // 이어 말하기용 대화 id (claude --resume / codex exec resume)
      busy: false,
      pending: null, // 다음 질문에 붙일 첨부
      viewing: null // 열람 중인 보관 대화 (null 이면 현재 대화)
    };
    const archives = []; // [{ at, title, wrap }] — 오래된 것이 앞

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
    // 어떤 AI 로 물어볼지 고르는 버튼. 그 서버에 깔려 있는 것만 보여 준다.
    const toolBtn = document.createElement('button');
    toolBtn.className = 'ac-hbtn ac-tool';
    const TOOL_NAME = { claude: 'Claude', codex: 'Codex' };
    const syncTool = () => {
      toolBtn.textContent = `${state.tool === 'codex' ? '◆' : '✳'} ${TOOL_NAME[state.tool]} ▾`;
      toolBtn.title = `${TOOL_NAME[state.tool]} 로 물어봅니다 (눌러서 변경)`;
      toolBtn.classList.toggle('ac-tool-codex', state.tool === 'codex');
    };
    syncTool();

    const histBtn = document.createElement('button');
    histBtn.className = 'ac-hbtn';
    histBtn.textContent = '기록';
    histBtn.title = '보관된 지난 대화 보기';
    const newBtn = document.createElement('button');
    newBtn.className = 'ac-hbtn';
    newBtn.textContent = '새 대화';
    newBtn.title = '지금 대화를 기록으로 넘기고 새로 시작';
    head.append(title, chip, toolBtn, histBtn, newBtn);
    // 떠 있는 팝업으로 쓸 때만 닫기 단추를 단다 (판 안에서는 판 헤더의 ✕ 를 쓴다)
    // 전체보기 (팝업일 때만) — 창을 화면 가득 넓혔다 되돌린다
    if (opts.onToggleMax) {
      const maxBtn = document.createElement('button');
      maxBtn.className = 'ac-hbtn ac-max';
      const paintMax = (on) => {
        maxBtn.textContent = on ? '❐' : '⛶';
        maxBtn.title = on ? '원래 크기로' : '전체보기';
      };
      paintMax(Boolean(opts.isMax && opts.isMax()));
      maxBtn.addEventListener('click', () => paintMax(opts.onToggleMax()));
      head.appendChild(maxBtn);
      // 창이 여러 개여도 표시가 어긋나지 않게 (전체보기는 앱 전체 설정이다)
      chatMaxPainters.push(paintMax);
    }
    if (opts.onClose) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'ac-hbtn ac-close';
      closeBtn.textContent = '✕';
      closeBtn.title = '닫기 (대화는 그대로 남습니다)';
      closeBtn.addEventListener('click', () => opts.onClose());
      head.appendChild(closeBtn);
    }

    /* --------------------------------- 로그 --------------------------------- */
    const log = document.createElement('div');
    log.className = 'ac-log';

    // 대화 하나가 담기는 묶음. "새 대화" 를 하면 이 묶음째로 보관된다.
    const mkWrap = () => {
      const w = document.createElement('div');
      w.className = 'ac-stream';
      return w;
    };
    let liveWrap = mkWrap(); // 지금 진행 중인 대화가 쌓이는 곳
    log.appendChild(liveWrap);

    const empty = document.createElement('div');
    empty.className = 'ac-empty';
    empty.textContent =
      '무엇이든 물어보세요. 답변은 서버에 로그인된 AI 계정(claude / codex)으로 실행됩니다.\n' +
      '📎 컨텍스트 로 옆 판의 터미널 화면이나 웹페이지 내용을 첨부할 수 있습니다.\n' +
      '머리의 AI 이름을 눌러 Claude · Codex 를 바꿀 수 있습니다.';
    liveWrap.appendChild(empty);

    // 보관 대화를 볼 때 위에 붙는 안내 줄
    const banner = document.createElement('div');
    banner.className = 'ac-banner';
    const bannerText = document.createElement('span');
    const bannerBtn = document.createElement('button');
    bannerBtn.className = 'ac-hbtn';
    bannerBtn.textContent = '↩ 현재 대화로';
    bannerBtn.addEventListener('click', () => returnToLive());
    banner.append(bannerText, bannerBtn);

    // 답변은 언제나 "현재 대화" 묶음에 쌓인다. 보관 대화를 열람 중이어도
    // 스트리밍이 엉뚱한 곳에 붙지 않는다.
    /*
     * AI 답변은 마크다운으로 그린다(코드블록·목록·표·굵게…).
     * 사용자가 보낸 글은 손대지 않고 그대로 보여 준다 — 친 그대로가 정확하다.
     *
     * 스트리밍 중에는 조각이 계속 붙으므로, 원문을 md 에 모아 두고 그때그때
     * 다시 그린다. setMarkdown() 이 그 일을 한다.
     */
    const addMsg = (cls, text) => {
      if (empty.parentNode) empty.remove();
      const m = document.createElement('div');
      m.className = `ac-msg ac-${cls}`;
      if (cls === 'ai') {
        m.classList.add('ac-md');
        m.md = '';
        m.setMarkdown = (t) => {
          m.md = t;
          window.Markdown.into(m, t);
        };
        m.setMarkdown(text || '');
      } else {
        m.textContent = text;
      }
      liveWrap.appendChild(m);
      if (!state.viewing) log.scrollTop = log.scrollHeight;
      return m;
    };

    /** 대화 흐름 안에 가로줄 안내를 하나 넣는다 (AI 전환 등) */
    const divider = (text) => {
      const d = document.createElement('div');
      d.className = 'ac-divider';
      d.textContent = text;
      liveWrap.appendChild(d);
      if (!state.viewing) log.scrollTop = log.scrollHeight;
    };

    /* ------------------------------- 대화 보관/열람 ------------------------------ */

    /** 묶음 안 첫 사용자 발화를 제목으로 */
    const wrapTitle = (wrap) => {
      const u = wrap.querySelector('.ac-user');
      const t = ((u && u.textContent) || '').replace(/^\[📎[^\]]*\]\s*/, '').split('\n')[0].trim();
      return t ? (t.length > 28 ? `${t.slice(0, 28)}…` : t) : '(빈 대화)';
    };

    const updateHist = () => {
      histBtn.textContent = archives.length ? `기록 ${archives.length}` : '기록';
    };

    function viewArchive(a) {
      state.viewing = a;
      bannerText.textContent = `보관된 대화 · ${timeLabel(a.at)}`;
      log.replaceChildren(banner, a.wrap);
      log.scrollTop = 0;
      row.classList.add('hidden'); // 지난 대화는 읽기 전용
    }

    function returnToLive() {
      if (!state.viewing) return;
      state.viewing = null;
      log.replaceChildren(liveWrap);
      row.classList.remove('hidden');
      log.scrollTop = log.scrollHeight;
      input.focus();
    }

    /** 지금 대화를 기록으로 넘기고 화면을 비운다 */
    function startNewConversation() {
      returnToLive();
      const hasMsg = liveWrap.querySelector('.ac-msg');
      if (hasMsg) {
        archives.push({ at: Date.now(), title: wrapTitle(liveWrap), wrap: liveWrap });
        liveWrap = mkWrap();
      } else {
        liveWrap.replaceChildren(); // 빈 대화는 보관하지 않는다
      }
      liveWrap.appendChild(empty);
      log.replaceChildren(liveWrap);
      state.resumeId = null;
      state.bindKey = null; // 다음 질문을 보내는 서버에 새로 매인다
      clearPending();
      updateHist();
      input.focus();
    }

    newBtn.addEventListener('click', () => {
      if (state.busy) return; // 답변 받는 중에는 넘기지 않는다
      startNewConversation();
    });

    /*
     * AI 를 바꾸면 대화 맥락(resumeId)은 이어갈 수 없다 — claude 의 세션 id 와
     * codex 의 thread id 는 서로 다른 체계다. 그래서 지금 대화는 기록으로 넘기고
     * 새 대화로 시작한다(사용자가 앞 내용을 잃지 않도록).
     */
    function switchTool(next) {
      if (next === state.tool) return;
      state.tool = next;
      syncTool();
      if (liveWrap.querySelector('.ac-msg')) startNewConversation();
      else state.resumeId = null;
      divider(`${TOOL_NAME[next]} 로 전환`);
      input.focus();
    }

    toolBtn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    toolBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const avail = (opts.getTools && opts.getTools()) || null;
      // 아직 확인 전이면 둘 다 보여 준다(없는 것을 고르면 실행할 때 안내가 나간다)
      const list = ['claude', 'codex'].filter((t) => !avail || avail[t]);
      const items = list.map((t) => [
        `${t === 'codex' ? '◆' : '✳'} ${TOOL_NAME[t]}${t === state.tool ? '  ✓' : ''}`,
        () => switchTool(t)
      ]);
      if (!items.length) items.push(['이 서버에 claude·codex 가 없습니다', () => {}]);
      const r = ev.currentTarget.getBoundingClientRect();
      window.showContextMenu(r.right, r.bottom + 4, items, { alignRight: true });
    });

    /** 보관 목록을 펼친다. 각 줄 오른쪽 ✕ 로 지울 수 있다. */
    function openHistoryMenu(anchorEl) {
      const items = [];
      if (state.viewing) items.push(['↩ 현재 대화로 돌아가기', () => returnToLive()]);
      for (let i = archives.length - 1; i >= 0; i--) {
        const a = archives[i];
        items.push([
          `${timeLabel(a.at)} · ${a.title}`,
          () => viewArchive(a),
          '',
          () => {
            // 지우던 대화를 보고 있었다면 현재 대화로 돌아온다
            if (state.viewing === a) returnToLive();
            const at = archives.indexOf(a);
            if (at >= 0) archives.splice(at, 1);
            updateHist();
            // 지운 뒤에도 이어서 지울 수 있게 목록을 다시 펼친다
            if (archives.length || state.viewing) openHistoryMenu(anchorEl);
            else window.hideContextMenu();
          }
        ]);
      }
      if (!archives.length) items.push(['보관된 대화가 없습니다', () => {}]);
      const r = anchorEl.getBoundingClientRect();
      window.showContextMenu(r.right, r.bottom + 4, items, { alignRight: true });
    }

    histBtn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    histBtn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // document 까지 가면 열리자마자 닫힌다
      openHistoryMenu(ev.currentTarget);
    });

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

    /** 첨부를 걸어 둔다 (📎 메뉴와 Ctrl/⌘+K 가 함께 쓴다) */
    function setPending(label, text) {
      if (!text) {
        chip.classList.remove('hidden');
        chip.textContent = '첨부할 내용이 없습니다';
        setTimeout(clearPending, 1800);
        return false;
      }
      state.pending = { label, text };
      chip.classList.remove('hidden');
      chip.textContent = `📎 ${label} (${text.length}자) ✕`;
      return true;
    }

    // 이 클릭이 document 까지 올라가면 공용 메뉴가 열리자마자 닫힌다(전역 닫기 핸들러).
    ctxBtn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    ctxBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const sources = (opts.getContextSources && opts.getContextSources()) || [];
      const items = sources.map((src) => [
        src.label,
        async () => {
          if (setPending(src.label, await src.get())) input.focus();
        }
      ]);
      if (!items.length) items.push(['첨부할 판이 없습니다', () => {}]);
      const r = ev.currentTarget.getBoundingClientRect();
      // 렌더러의 공용 컨텍스트 메뉴를 쓴다 (입력 줄 위쪽으로 펼친다)
      window.showContextMenu(r.left, r.top - 8 - items.length * 26, items);
    });
    chip.addEventListener('click', clearPending); // 첨부 취소

    /*
     * 이번 질문을 실행할 서버를 정한다.
     * 대화가 이미 어느 서버에 매여 있으면 계속 그 서버로 보낸다(맥락이 거기 있다).
     * 그 서버의 연결이 끊겼으면 지금 보고 있는 서버로 옮기고 새 대화로 시작한다.
     */
    function resolveTarget() {
      return opts.getTarget ? opts.getTarget(state.bindKey) : null;
    }

    /** 머리에 "이 대화가 매인 서버" 를 적는다 */
    function paintTitle(label) {
      title.textContent = `✳ AI 채팅${label ? ` — ${label}` : ''}`;
    }

    /* --------------------------------- 전송 --------------------------------- */

    async function send() {
      const q = input.value.trim();
      if (!q || state.busy) return;
      const target = resolveTarget();
      if (!target || !target.sessionId) {
        addMsg('err', '연결된 세션이 없습니다. 터미널이 접속된 뒤에 다시 시도하세요.');
        return;
      }
      const sessionId = target.sessionId;
      returnToLive(); // 보관 대화를 보던 중이면 현재 대화로 돌아온다

      // 대화가 매여 있던 서버가 사라져 다른 서버로 넘어가는 경우
      if (state.bindKey && target.key !== state.bindKey) {
        // 새 대화로 넘어가도 방금 붙인 첨부는 이번 질문에 그대로 써야 한다
        const keepPending = state.pending;
        if (liveWrap.querySelector('.ac-msg')) startNewConversation();
        else state.resumeId = null;
        if (keepPending) setPending(keepPending.label, keepPending.text);
        divider(`${target.label || '다른 서버'} 로 옮겨 새 대화를 시작합니다`);
      }
      state.bindKey = target.key;
      paintTitle(target.label);
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
      if (opts.onBusy) opts.onBusy(true);
      const reqId = `c${Date.now()}_${reqSeq++}`;
      const wait = addMsg('wait', '생각 중…');
      // 사고 과정(thinking)·진행 단계는 접이식 상자에, 답변은 실시간 타이핑으로
      let think = null;
      let thinkBody = null;
      let bubble = null;
      const ensureThink = () => {
        if (think) return;
        think = document.createElement('details');
        think.className = 'ac-think';
        think.open = true;
        const sum = document.createElement('summary');
        sum.textContent = '🧠 사고 과정';
        thinkBody = document.createElement('div');
        thinkBody.className = 'ac-think-body';
        think.append(sum, thinkBody);
        if (empty.parentNode) empty.remove();
        liveWrap.appendChild(think);
        if (!state.viewing) log.scrollTop = log.scrollHeight;
      };
      /*
       * 토큰이 올 때마다 전체를 다시 그리면 무거우므로 한 프레임에 한 번만 그린다.
       * (코드블록이 열린 채로 오는 중에도 보기 좋게 나오도록 마크다운은 매번 새로 만든다)
       */
      let paintQueued = null;
      const paint = (text) => {
        if (!bubble) return;
        bubble.md = text;
        if (paintQueued) return;
        paintQueued = requestAnimationFrame(() => {
          paintQueued = null;
          if (bubble) bubble.setMarkdown(bubble.md);
          if (!state.viewing) log.scrollTop = log.scrollHeight;
        });
      };

      pendingReqs.set(reqId, (p) => {
        if (wait.parentNode) wait.remove();
        if (p.kind === 'reset') {
          // 새 대화로 다시 보내는 중 — 첫 시도에서 흘러온 조각은 버린다
          if (bubble) bubble.remove();
          if (think) think.remove();
          bubble = null;
          think = null;
          thinkBody = null;
          return;
        }
        if (p.kind === 'thinking') {
          ensureThink();
          thinkBody.textContent += p.text;
        } else if (p.kind === 'step') {
          ensureThink();
          const line = document.createElement('div');
          line.className = 'ac-think-step';
          line.textContent = `⚙ ${p.text}`;
          thinkBody.appendChild(line);
        } else if (p.kind === 'text') {
          if (!bubble) bubble = addMsg('ai', '');
          paint(bubble.md + p.text); // claude: 토큰이 이어 붙는다
        } else if (p.kind === 'answer') {
          // codex: 메시지 단위로 오므로 통째로 갈아 끼운다
          if (!bubble) bubble = addMsg('ai', '');
          paint(p.text);
        }
        if (!state.viewing) log.scrollTop = log.scrollHeight;
      });
      try {
        const res = await api.ai.askStream(reqId, sessionId, prompt, state.resumeId, state.tool);
        if (wait.parentNode) wait.remove();
        if (think) think.open = false; // 끝나면 접는다
        if (res.error) addMsg('err', res.error);
        else {
          if (res.restarted) {
            // 그 서버에 이전 대화가 없어 새 대화로 다시 보냈다
            divider('이전 대화를 이어가지 못해 새 대화로 물어봤습니다');
            state.resumeId = null;
          }
          state.resumeId = res.sessionId || state.resumeId;
          if (!bubble) bubble = addMsg('ai', res.result || '(빈 응답)');
          else bubble.setMarkdown(bubble.md || res.result || '(빈 응답)'); // 마지막 조각까지 반영
        }
      } catch (err) {
        if (wait.parentNode) wait.remove();
        addMsg('err', `실패: ${String((err && err.message) || err).replace(/^Error:\s*/, '')}`);
      } finally {
        pendingReqs.delete(reqId);
        state.busy = false;
        sendBtn.disabled = false;
        if (opts.onBusy) opts.onBusy(false);
        if (opts.onAnswer) opts.onAnswer(); // 숨겨져 있었다면 단추에 표시가 뜬다
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
      // 팝업으로 떠 있을 때는 Esc 로 접는다 (내용은 남는다)
      if (e.key === 'Escape' && opts.onClose && !e.isComposing) {
        e.preventDefault();
        opts.onClose();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      }
    });
    sendBtn.addEventListener('click', send);

    updateHist();

    return {
      el: root,
      focus: () => {
        returnToLive();
        input.focus();
      },
      /** Ctrl/⌘+K 등 바깥에서 컨텍스트를 걸어 준다 */
      attachContext: (label, text) => {
        returnToLive();
        return setPending(label, text);
      },
      newConversation: startNewConversation,
      dispose: () => root.remove()
    };
  }

  return { create, paintAllMaxButtons };
})();
