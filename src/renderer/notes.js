'use strict';

/**
 * 메모장.
 * 메인 탭바 맨 왼쪽의 📝 메모 탭(Ctrl+Alt+`)에서 열린다.
 *
 * - 목록: 이름 / 만든 날짜 / 마지막 작성 (기본 정렬은 마지막 작성 최신순)
 * - 편집: 평범한 텍스트 편집기. 드래그 선택·복사·붙여넣기·되돌리기 모두 OS 기본 동작.
 *   Ctrl/⌘+S 로 저장하고, 입력이 멈추면 잠시 뒤 자동 저장한다.
 * - 파일은 <userData>/notes/*.md
 */

window.Notes = (function () {
  const api = window.armux;

  const fmtTime = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

  function create() {
    const notes = {
      items: [],
      current: null, // 편집 중인 메모 이름
      dirty: false,
      sortKey: 'updatedAt', // 기본: 마지막 작성 최신순
      sortAsc: false,
      el: null,
      refresh,
      // 퀵메모의 "메모장에서 열기" 가 그 메모를 바로 펼치는 데 쓴다
      open: (name) => openNote(name),
      focus: () => (notes.current ? editor.focus() : root.focus()),
      dispose
    };

    /* --------------------------------- DOM --------------------------------- */

    const root = document.createElement('div');
    root.className = 'notes';
    root.tabIndex = 0;

    /* 목록 화면 */
    const listView = document.createElement('div');
    listView.className = 'notes-view';

    const listBar = document.createElement('div');
    listBar.className = 'ex-bar';
    const newBtn = document.createElement('button');
    newBtn.className = 'ex-btn';
    newBtn.textContent = '+ 새 메모';
    newBtn.title = '새 메모 만들기 (Ctrl/⌘+N)';
    newBtn.addEventListener('click', () => createNote());

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'ex-btn';
    reloadBtn.textContent = '⟳';
    reloadBtn.title = '새로고침 (F5)';
    reloadBtn.addEventListener('click', () => refresh());

    const folderBtn = document.createElement('button');
    folderBtn.className = 'ex-btn';
    folderBtn.textContent = '📂 폴더 열기';
    folderBtn.title = '메모가 저장된 폴더 열기';
    folderBtn.addEventListener('click', () => api.notes.reveal());

    const search = document.createElement('input');
    search.className = 'ex-path';
    search.placeholder = '메모 검색…';
    search.spellcheck = false;
    search.addEventListener('input', renderList);
    search.addEventListener('keydown', (e) => e.stopPropagation());

    listBar.append(newBtn, reloadBtn, search, folderBtn);

    const head = document.createElement('div');
    head.className = 'ex-head notes-head';
    const mkHead = (label, key) => {
      const sp = document.createElement('span');
      sp.className = `c-${key}`;
      sp.textContent = label;
      sp.title = '클릭하면 이 기준으로 정렬';
      sp.addEventListener('click', () => {
        if (notes.sortKey === key) notes.sortAsc = !notes.sortAsc;
        else {
          notes.sortKey = key;
          notes.sortAsc = key === 'name';
        }
        renderList();
      });
      return sp;
    };
    head.append(mkHead('이름', 'name'), mkHead('크기', 'size'), mkHead('만든 날짜', 'createdAt'), mkHead('마지막 작성', 'updatedAt'));

    const listEl = document.createElement('div');
    listEl.className = 'ex-list';

    const listStatus = document.createElement('div');
    listStatus.className = 'ex-status';

    listView.append(listBar, head, listEl, listStatus);

    /* 편집 화면 */
    const editView = document.createElement('div');
    editView.className = 'notes-view hidden';

    const editBar = document.createElement('div');
    editBar.className = 'ex-bar';

    const backBtn = document.createElement('button');
    backBtn.className = 'ex-btn';
    backBtn.textContent = '←';
    backBtn.title = '목록으로 (저장됨)';
    backBtn.addEventListener('click', () => closeEditor());

    const nameInput = document.createElement('input');
    nameInput.className = 'ex-path notes-name';
    nameInput.spellcheck = false;
    nameInput.title = '메모 이름 (수정 후 Enter)';
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') renameCurrent();
      if (e.key === 'Escape') nameInput.value = notes.current;
    });
    nameInput.addEventListener('blur', renameCurrent);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ex-btn';
    saveBtn.textContent = '저장';
    saveBtn.title = '저장 (Ctrl/⌘+S)';
    saveBtn.addEventListener('click', () => save(true));

    const delBtn = document.createElement('button');
    delBtn.className = 'ex-btn danger';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', () => removeCurrent());

    editBar.append(backBtn, nameInput, saveBtn, delBtn);

    const editor = document.createElement('textarea');
    editor.className = 'notes-editor';
    editor.spellcheck = false;
    editor.placeholder = '여기에 메모를 작성하세요. (Markdown 으로 저장됩니다)';

    const editStatus = document.createElement('div');
    editStatus.className = 'ex-status';

    editView.append(editBar, editor, editStatus);

    root.append(listView, editView);
    notes.el = root;

    /* -------------------------------- 목록 동작 ------------------------------- */

    async function refresh() {
      notes.items = await api.notes.list();
      renderList();
    }

    function sortedItems() {
      const q = search.value.trim().toLowerCase();
      const items = notes.items.filter((n) => !q || n.name.toLowerCase().includes(q));
      const k = notes.sortKey;
      return items.sort((a, b) => {
        const av = a[k];
        const bv = b[k];
        const cmp = typeof av === 'string' ? av.localeCompare(bv, 'ko') : av - bv;
        return notes.sortAsc ? cmp : -cmp;
      });
    }

    function renderList() {
      listEl.innerHTML = '';
      const items = sortedItems();

      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'ex-row';
        row.dataset.name = item.name;

        const name = document.createElement('span');
        name.className = 'c-name';
        name.textContent = `📝 ${item.name}`;

        const size = document.createElement('span');
        size.className = 'c-size';
        size.textContent = fmtSize(item.size);

        const created = document.createElement('span');
        created.className = 'c-createdAt';
        created.textContent = fmtTime(item.createdAt);

        const updated = document.createElement('span');
        updated.className = 'c-updatedAt';
        updated.textContent = fmtTime(item.updatedAt);

        row.append(name, size, created, updated);
        row.addEventListener('click', () => openNote(item.name));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (window.showContextMenu) {
            window.showContextMenu(e.clientX, e.clientY, [
              ['열기', () => openNote(item.name)],
              ['이름 변경', () => openNote(item.name).then(() => nameInput.select())],
              ['삭제', () => removeNote(item.name), 'danger']
            ]);
          }
        });
        listEl.appendChild(row);
      }

      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ex-empty';
        empty.textContent = notes.items.length
          ? '검색 결과가 없습니다.'
          : '아직 메모가 없습니다. "+ 새 메모" 로 시작하세요.';
        listEl.appendChild(empty);
      }

      const sortLabel = { name: '이름', size: '크기', createdAt: '만든 날짜', updatedAt: '마지막 작성' }[notes.sortKey];
      listStatus.textContent = `메모 ${notes.items.length}개 · ${sortLabel} ${notes.sortAsc ? '오름차순' : '내림차순'} 정렬`;
    }

    /* -------------------------------- 편집 동작 ------------------------------- */

    async function createNote() {
      const created = await api.notes.create('새 메모');
      await refresh();
      await openNote(created.name);
      nameInput.select();
    }

    async function openNote(name) {
      notes.current = name;
      editor.value = await api.notes.read(name);
      nameInput.value = name;
      notes.dirty = false;
      listView.classList.add('hidden');
      editView.classList.remove('hidden');
      editStatus.textContent = '저장됨';
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }

    async function closeEditor() {
      if (notes.dirty) await save();
      notes.current = null;
      editView.classList.add('hidden');
      listView.classList.remove('hidden');
      await refresh();
    }

    let saveTimer = null;
    editor.addEventListener('input', () => {
      notes.dirty = true;
      editStatus.textContent = '작성 중…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(), 1200); // 입력이 멈추면 자동 저장
    });

    async function save(explicit) {
      if (!notes.current) return;
      clearTimeout(saveTimer);
      await api.notes.write(notes.current, editor.value);
      notes.dirty = false;
      const now = new Date();
      const p = (x) => String(x).padStart(2, '0');
      editStatus.textContent = `${explicit ? '저장했습니다' : '자동 저장됨'} · ${p(now.getHours())}:${p(now.getMinutes())}`;
    }

    async function renameCurrent() {
      const to = nameInput.value.trim();
      if (!notes.current || !to || to === notes.current) return;
      try {
        if (notes.dirty) await save();
        const res = await api.notes.rename(notes.current, to);
        notes.current = res.name;
        nameInput.value = res.name;
        editStatus.textContent = '이름을 바꿨습니다';
        await refresh();
      } catch (err) {
        editStatus.textContent = String((err && err.message) || err).replace(/^Error:\s*/, '');
        nameInput.value = notes.current;
      }
    }

    async function removeNote(name) {
      const ok = await api.util.confirm(`"${name}" 메모를 삭제할까요?`, '삭제한 메모는 되돌릴 수 없습니다.');
      if (!ok) return;
      await api.notes.remove(name);
      if (notes.current === name) {
        notes.current = null;
        editView.classList.add('hidden');
        listView.classList.remove('hidden');
      }
      await refresh();
    }

    const removeCurrent = () => notes.current && removeNote(notes.current);

    /* --------------------------------- 단축키 -------------------------------- */

    root.addEventListener('keydown', (e) => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        save(true);
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        e.stopPropagation();
        createNote();
      }
      if (e.key === 'F5') {
        e.preventDefault();
        refresh();
      }
      if (e.key === 'Escape' && notes.current) {
        e.preventDefault();
        e.stopPropagation();
        closeEditor();
      }
    });

    function dispose() {
      clearTimeout(saveTimer);
      root.remove();
    }

    refresh();
    return notes;
  }

  return { create };
})();
