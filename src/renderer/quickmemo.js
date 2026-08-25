'use strict';

/**
 * 퀵메모 — 하단바 오른쪽 📝 단추(또는 Ctrl/⌘+M)에서 올라오는 작은 메모창.
 *
 * AI 채팅 팝업과 같은 방식이다. 판(분할 트리)을 건드리지 않고 터미널 위에 겹쳐
 * 뜨고, 닫아도 없애지 않고 감추기만 한다 — 쓰던 글이 그대로 남는다.
 *
 * 저장 위치는 메모장 탭과 같다(<userData>/notes/*.md). 그래서 여기서 급히 적은
 * 것을 나중에 메모장 탭에서 정리할 수 있다.
 *
 * 열면 "마지막으로 적던 메모" 를 그대로 이어서 연다. 그런 메모가 없으면(처음
 * 쓰거나, 그 메모를 지웠으면) 새 메모를 하나 만들어 바로 적을 수 있게 한다.
 * 머리의 이름 단추로 다른 메모로 갈아탈 수 있다.
 */

window.QuickMemo = (function () {
  const api = window.armux;

  /** 새로 만드는 메모의 이름 (메모장 탭과 같은 규칙으로 (2), (3) 이 붙는다) */
  const NEW_NOTE = '새 메모';
  /** 마지막에 적던 메모를 기억해 둔다 (다음에 열면 그대로 이어 쓴다) */
  const LAST_KEY = 'quickMemoNote';

  const hhmm = (d) => {
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const stamp = (d) => {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hhmm(d)}`;
  };

  /**
   * @param {{ onToggleMax?: fn, isMax?: fn, onClose?: fn, onSaved?: fn, onOpenNotes?: fn }} opts
   */
  function create(opts = {}) {
    const memo = {
      el: null,
      note: null, // 지금 적고 있는 메모 이름
      dirty: false,
      focus,
      flush, // 감추기 전에 확실히 저장
      dispose
    };

    /* --------------------------------- 머리 --------------------------------- */

    const root = document.createElement('div');
    root.className = 'quickmemo';

    const head = document.createElement('div');
    head.className = 'qm-head';

    const title = document.createElement('span');
    title.className = 'qm-title';
    title.textContent = '📝 퀵메모';

    // 지금 메모 이름 — 누르면 다른 메모로 갈아탈 수 있는 목록이 열린다
    const nameBtn = document.createElement('button');
    nameBtn.className = 'qm-hbtn qm-name';
    nameBtn.title = '다른 메모로 바꾸기';
    nameBtn.addEventListener('click', openNoteMenu);

    const timeBtn = document.createElement('button');
    timeBtn.className = 'qm-hbtn';
    timeBtn.textContent = '⏱';
    timeBtn.title = '지금 시각 넣기';
    timeBtn.addEventListener('click', insertStamp);

    const newBtn = document.createElement('button');
    newBtn.className = 'qm-hbtn';
    newBtn.textContent = '+';
    newBtn.title = '새 메모 만들기';
    newBtn.addEventListener('click', () => createNote());

    head.append(title, nameBtn, timeBtn, newBtn);

    if (opts.onToggleMax) {
      const maxBtn = document.createElement('button');
      maxBtn.className = 'qm-hbtn qm-max';
      const paintMax = (on) => {
        maxBtn.textContent = on ? '❐' : '⛶';
        maxBtn.title = on ? '원래 크기로' : '전체보기';
      };
      paintMax(Boolean(opts.isMax && opts.isMax()));
      maxBtn.addEventListener('click', () => paintMax(opts.onToggleMax()));
      head.appendChild(maxBtn);
    }

    if (opts.onClose) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'qm-hbtn qm-close';
      closeBtn.textContent = '✕';
      closeBtn.title = '닫기 (적은 내용은 저장됩니다)';
      closeBtn.addEventListener('click', () => opts.onClose());
      head.appendChild(closeBtn);
    }

    /* --------------------------------- 본문 --------------------------------- */

    const editor = document.createElement('textarea');
    editor.className = 'qm-editor';
    editor.spellcheck = false;
    editor.placeholder = '떠오른 것을 바로 적어 두세요. 자동으로 저장됩니다.';

    const foot = document.createElement('div');
    foot.className = 'qm-foot';

    const status = document.createElement('span');
    status.className = 'qm-status';

    const openBtn = document.createElement('button');
    openBtn.className = 'qm-hbtn';
    openBtn.textContent = '메모장에서 열기';
    openBtn.title = '메모장 탭에서 이어 쓰기';
    openBtn.addEventListener('click', async () => {
      await save();
      if (opts.onOpenNotes) opts.onOpenNotes(memo.note);
    });

    foot.append(status, openBtn);
    root.append(head, editor, foot);
    memo.el = root;

    /* -------------------------------- 메모 고르기 ------------------------------- */

    function paintName() {
      nameBtn.textContent = `${memo.note || NEW_NOTE} ▾`;
    }

    /** 그 이름의 메모를 연다 (없으면 만든다) */
    async function useNote(name) {
      await flush(); // 옮겨 가기 전에 지금 것부터 저장
      const list = await api.notes.list();
      let target = list.find((n) => n.name === name);
      if (!target) target = await api.notes.create(name);
      memo.note = target.name;
      localStorage.setItem(LAST_KEY, memo.note);
      editor.value = await api.notes.read(memo.note);
      memo.dirty = false;
      paintName();
      status.textContent = '저장됨';
      // 이어 쓰기 좋게 글 끝으로
      editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.scrollTop = editor.scrollHeight;
    }

    async function createNote() {
      await flush();
      const created = await api.notes.create(NEW_NOTE);
      memo.note = created.name;
      localStorage.setItem(LAST_KEY, memo.note);
      editor.value = '';
      memo.dirty = false;
      paintName();
      status.textContent = '새 메모를 만들었습니다';
      if (opts.onSaved) opts.onSaved();
      editor.focus();
    }

    async function openNoteMenu(e) {
      e.stopPropagation();
      await save();
      const list = await api.notes.list();
      const r = nameBtn.getBoundingClientRect();
      const items = list.slice(0, 20).map((n) => [
        `${n.name === memo.note ? '✓ ' : '   '}${n.name}`,
        () => useNote(n.name),
        '',
        // 오른쪽 ✕ 로 바로 지운다 (지금 적고 있는 메모는 지우지 않는다)
        n.name === memo.note ? null : () => removeNote(n.name)
      ]);
      if (!items.length) items.push(['메모가 없습니다', () => {}]);
      items.push(['-'], ['+ 새 메모', () => createNote()]);
      window.showContextMenu(r.right, r.bottom + 2, items, { alignRight: true });
    }

    async function removeNote(name) {
      const ok = await api.util.confirm(`"${name}" 메모를 삭제할까요?`, '삭제한 메모는 되돌릴 수 없습니다.');
      if (!ok) return;
      await api.notes.remove(name);
      if (opts.onSaved) opts.onSaved();
      window.hideContextMenu();
    }

    /* --------------------------------- 저장 --------------------------------- */

    let saveTimer = null;

    editor.addEventListener('input', () => {
      memo.dirty = true;
      status.textContent = '작성 중…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(), 800); // 손을 멈추면 곧 저장
    });

    async function save(explicit) {
      clearTimeout(saveTimer);
      if (!memo.note || !memo.dirty) {
        if (explicit) status.textContent = '저장됨';
        return;
      }
      const text = editor.value;
      await api.notes.write(memo.note, text);
      // 저장하는 사이에 더 쳤다면 아직 저장할 것이 남은 것이다
      if (editor.value === text) memo.dirty = false;
      status.textContent = `${explicit ? '저장했습니다' : '자동 저장됨'} · ${hhmm(new Date())}`;
      if (opts.onSaved) opts.onSaved();
    }

    /** 창을 감추거나 앱을 끄기 전에 남은 것을 확실히 저장한다 */
    async function flush() {
      if (memo.dirty) await save();
    }

    /** 커서 자리에 "2026-08-25 14:03" 줄을 넣는다 */
    function insertStamp() {
      const s = editor.selectionStart;
      const before = editor.value.slice(0, s);
      const after = editor.value.slice(editor.selectionEnd);
      // 줄 가운데면 줄을 바꿔 넣는다
      const head0 = before && !before.endsWith('\n') ? '\n' : '';
      const text = `${head0}## ${stamp(new Date())}\n`;
      editor.value = before + text + after;
      const at = before.length + text.length;
      editor.setSelectionRange(at, at);
      editor.focus();
      memo.dirty = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(), 800);
    }

    function focus() {
      editor.focus();
    }

    /* -------------------------------- 단축키 -------------------------------- */

    root.addEventListener('keydown', (e) => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey;
      // 여기서 처리하는 키는 바깥(터미널 단축키)으로 새어 나가지 않게 막는다
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        save(true);
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        e.stopPropagation();
        insertStamp();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (opts.onClose) opts.onClose();
        return;
      }
      // 글자 입력·복사·붙여넣기는 창 안에서 끝난다 (터미널로 흘러가면 안 된다)
      e.stopPropagation();
    });

    function dispose() {
      clearTimeout(saveTimer);
      root.remove();
    }

    /*
     * 처음 열 때: 마지막으로 적던 메모를 그대로 잇는다.
     * 기억해 둔 이름이 없거나 그 메모가 지워졌으면 새 메모를 만들어 준다
     * (빈 창을 띄워 두고 어디에 적히는지 모르게 두지 않는다).
     */
    (async () => {
      const last = localStorage.getItem(LAST_KEY);
      if (last) {
        const list = await api.notes.list();
        if (list.some((n) => n.name === last)) {
          await useNote(last);
          return;
        }
      }
      await createNote();
      status.textContent = '새 메모입니다';
    })();
    paintName();

    return memo;
  }

  return { create, NEW_NOTE };
})();
