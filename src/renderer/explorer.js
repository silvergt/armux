'use strict';

/**
 * SFTP 파일 탐색기.
 * 서브탭 왼쪽의 폴더 버튼을 누르면 터미널 대신 이 화면이 뜬다.
 *
 * - 더블클릭: 폴더 열기 / 파일 내려받기
 * - 우클릭: 이름 변경, 새 폴더, 새 파일, 다운로드, 업로드, 삭제 …
 * - 드래그: 항목을 폴더 위로 끌면 이동. OS 창에서 파일을 끌어다 놓으면 업로드.
 *   Alt(⌥) 를 누른 채 끌면 내 PC 로 꺼내기(다운로드 후 시스템 드래그).
 */

window.Explorer = (function () {
  const api = window.armux;

  const fmtSize = (n) => {
    if (n === undefined || n === null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(n);
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
  };

  const fmtTime = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const parentOf = (p) => {
    if (!p || p === '/') return '/';
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx <= 0 ? '/' : trimmed.slice(0, idx);
  };

  const joinRemote = (base, name) => (base === '/' ? `/${name}` : `${base.replace(/\/+$/, '')}/${name}`);

  /**
   * @param {object} opts { getConnect(): {hostId, credId}, hostLabel: string }
   */
  function create(opts) {
    const ex = {
      sftpId: null,
      cwd: '.',
      history: [], // 방문한 경로들 (뒤로/앞으로 이동용)
      histIndex: -1,
      entries: [],
      expanded: new Set(), // 펼쳐 놓은 폴더 경로들
      children: new Map(), // 경로 -> 그 폴더의 항목들 (펼칠 때 한 번 읽어 캐시)
      selected: new Set(), // 선택된 경로들
      showHidden: false,
      busy: false,
      el: null,
      dispose,
      refresh,
      back,
      forward,
      focus: () => ex.el && ex.el.focus()
    };

    /* --------------------------------- DOM --------------------------------- */

    const root = document.createElement('div');
    root.className = 'explorer';
    root.tabIndex = 0;

    const bar = document.createElement('div');
    bar.className = 'ex-bar';

    const mkBtn = (label, title, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'ex-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };

    // ← 는 뒤로가기(히스토리가 없으면 상위 폴더), → 는 앞으로가기.
    // 마우스의 뒤로/앞으로 버튼과 Backspace 로도 같은 동작을 한다.
    const backBtn = mkBtn('←', '뒤로 (없으면 상위 폴더) · 마우스 뒤로 버튼', () => back());
    const fwdBtn = mkBtn('→', '앞으로 · 마우스 앞으로 버튼', () => forward());
    const homeBtn = mkBtn('⌂', '홈 디렉터리', () => navigate('.'));
    const reloadBtn = mkBtn('⟳', '새로고침 (F5)', () => refresh());

    const pathInput = document.createElement('input');
    pathInput.className = 'ex-path';
    pathInput.spellcheck = false;
    pathInput.title = '경로를 입력하고 Enter';
    pathInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') navigate(pathInput.value.trim());
      if (e.key === 'Escape') pathInput.value = ex.cwd;
    });

    const reconnectBtn = mkBtn('⟲ 다시 연결', 'SFTP 연결을 다시 맺습니다', () => reconnect());
    reconnectBtn.classList.add('hidden', 'danger');

    const uploadBtn = mkBtn('⬆ 업로드', '이 폴더로 파일 업로드', () => pickAndUpload(false));
    const newDirBtn = mkBtn('+ 폴더', '새 폴더 만들기', () => createEntry('dir'));
    const hiddenBtn = mkBtn('숨김', '숨김 파일 표시 토글', () => {
      ex.showHidden = !ex.showHidden;
      hiddenBtn.classList.toggle('on', ex.showHidden);
      renderList();
    });

    bar.append(backBtn, fwdBtn, homeBtn, reloadBtn, pathInput, reconnectBtn, hiddenBtn, newDirBtn, uploadBtn);

    const head = document.createElement('div');
    head.className = 'ex-head';
    head.innerHTML =
      '<span class="c-name">이름</span><span class="c-size">크기</span>' +
      '<span class="c-time">수정한 날짜</span><span class="c-perm">권한</span>';

    const listEl = document.createElement('div');
    listEl.className = 'ex-list';

    const status = document.createElement('div');
    status.className = 'ex-status';

    // 업로드/다운로드 진행 표시 (하단에 크게 뜬다)
    const progress = document.createElement('div');
    progress.className = 'ex-progress hidden';
    const progTitle = document.createElement('div');
    progTitle.className = 'ex-progress-title';
    const progBarWrap = document.createElement('div');
    progBarWrap.className = 'ex-progress-bar';
    const progFill = document.createElement('span');
    progBarWrap.appendChild(progFill);
    const progMeta = document.createElement('div');
    progMeta.className = 'ex-progress-meta';
    const progPct = document.createElement('span');
    progPct.className = 'ex-progress-pct';
    progress.append(progTitle, progBarWrap, progMeta, progPct);

    root.append(bar, head, listEl, progress, status);
    ex.el = root;

    // 왼쪽 고정 패널처럼 폭이 좁아지면 수정날짜/권한 열을 접어 이름 칸을 확보한다
    const widthObserver = new ResizeObserver(() => {
      const w = root.clientWidth;
      root.classList.toggle('narrow', w < 520);
      root.classList.toggle('very-narrow', w < 380);
    });
    widthObserver.observe(root);

    /* ------------------------------- 상태 표시 ------------------------------- */

    let statusTimer = null;
    function setStatus(text, sticky) {
      status.textContent = text;
      clearTimeout(statusTimer);
      if (!sticky) statusTimer = setTimeout(() => summarize(), 2500);
    }

    function summarize() {
      const dirs = ex.entries.filter((e) => e.type === 'dir' || e.linkToDir).length;
      const files = ex.entries.length - dirs;
      const bytes = ex.entries.filter((e) => e.type === 'file').reduce((a, b) => a + (b.size || 0), 0);
      status.textContent = `폴더 ${dirs} · 파일 ${files} · ${fmtSize(bytes)}`;
    }

    /* ------------------------------ 접속 / 이동 ------------------------------ */

    async function ensureSession(force) {
      if (ex.sftpId && !force) return ex.sftpId;
      setStatus('SFTP 연결 중…', true);
      const connect = typeof opts.getConnect === 'function' ? opts.getConnect() : opts.connect;
      const res = await api.sftp.open(connect);
      ex.sftpId = res.sftpId;
      if (!ex.cwd || ex.cwd === '.') ex.cwd = res.home || '/';
      reconnectBtn.classList.add('hidden');
      return ex.sftpId;
    }

    /** 연결이 끊겼을 때 나는 오류인지 */
    const isDisconnected = (err) =>
      /세션이 없습니다|not connected|No response|closed|ECONNRESET|EPIPE|Channel/i.test(String((err && err.message) || err));

    /**
     * SFTP 작업 실행기.
     * 연결이 끊겨 있으면 자동으로 한 번 다시 연결하고 그 작업을 재시도한다.
     */
    async function withSession(fn) {
      try {
        await ensureSession();
        return await fn();
      } catch (err) {
        if (!isDisconnected(err)) throw err;
        setStatus('SFTP 연결이 끊겨 다시 연결하는 중…', true);
        try {
          ex.sftpId = null;
          await ensureSession(true);
          const out = await fn();
          setStatus('다시 연결했습니다.');
          return out;
        } catch (err2) {
          ex.sftpId = null;
          reconnectBtn.classList.remove('hidden');
          setStatus(`SFTP 연결 실패: ${cleanErr(err2)} — "⟲ 다시 연결" 을 눌러 주세요.`, true);
          throw err2;
        }
      }
    }

    /** 사용자가 직접 다시 연결 */
    async function reconnect() {
      ex.sftpId = null;
      try {
        await ensureSession(true);
        await refresh();
        setStatus('다시 연결했습니다.');
      } catch (err) {
        reconnectBtn.classList.remove('hidden');
        setStatus(`다시 연결 실패: ${cleanErr(err)}`, true);
      }
    }

    async function navigate(target, push = true) {
      try {
        const abs = await withSession(() => api.sftp.realpath(ex.sftpId, target || '.'));
        if (abs === ex.cwd && ex.histIndex >= 0) return;
        ex.cwd = abs;
        if (push) {
          // 뒤로 간 상태에서 새 경로로 이동하면 앞쪽 기록은 버린다 (브라우저와 동일)
          ex.history = ex.history.slice(0, ex.histIndex + 1);
          ex.history.push(abs);
          ex.histIndex = ex.history.length - 1;
        }
        updateNavButtons();
        await refresh();
      } catch (err) {
        setStatus(`이동 실패: ${cleanErr(err)}`, true);
      }
    }

    /** 뒤로: 방문 기록이 있으면 이전 경로, 없으면 상위 폴더 */
    async function back() {
      if (ex.histIndex > 0) {
        ex.histIndex -= 1;
        await navigate(ex.history[ex.histIndex], false);
        return;
      }
      const up = parentOf(ex.cwd);
      if (up !== ex.cwd) await navigate(up);
    }

    async function forward() {
      if (ex.histIndex < ex.history.length - 1) {
        ex.histIndex += 1;
        await navigate(ex.history[ex.histIndex], false);
      }
    }

    function updateNavButtons() {
      backBtn.disabled = false; // 뒤로는 상위 폴더 역할도 하므로 항상 활성
      fwdBtn.disabled = ex.histIndex >= ex.history.length - 1;
      fwdBtn.classList.toggle('disabled', fwdBtn.disabled);
    }

    async function refresh() {
      try {
        setStatus('불러오는 중…', true);
        ex.entries = await withSession(() => api.sftp.list(ex.sftpId, ex.cwd));

        // 펼쳐 둔 하위 폴더들도 같이 새로 읽는다 (없어진 폴더는 접는다)
        ex.children.clear();
        for (const dir of Array.from(ex.expanded)) {
          if (!dir.startsWith(ex.cwd)) {
            ex.expanded.delete(dir);
            continue;
          }
          try {
            ex.children.set(dir, await withSession(() => api.sftp.list(ex.sftpId, dir)));
          } catch (e) {
            ex.expanded.delete(dir);
          }
        }

        ex.selected.clear();
        pathInput.value = ex.cwd;
        renderList();
        summarize();
      } catch (err) {
        listEl.innerHTML = '';
        setStatus(`목록을 불러오지 못했습니다: ${cleanErr(err)}`, true);
      }
    }

    const isDirEntry = (e) => e.type === 'dir' || e.linkToDir;

    /** 폴더를 그 자리에서 펼치거나 접는다 (들어가지 않고 하위 항목을 아래에 보여준다) */
    async function toggleExpand(entry) {
      if (!isDirEntry(entry)) return;
      if (ex.expanded.has(entry.path)) {
        ex.expanded.delete(entry.path);
        renderList();
        return;
      }
      try {
        if (!ex.children.has(entry.path)) {
          setStatus(`${entry.name} 불러오는 중…`, true);
          ex.children.set(entry.path, await withSession(() => api.sftp.list(ex.sftpId, entry.path)));
        }
        ex.expanded.add(entry.path);
        renderList();
        summarize();
      } catch (err) {
        setStatus(`${entry.name} 을(를) 열 수 없습니다: ${cleanErr(err)}`, true);
      }
    }

    const cleanErr = (err) => String((err && err.message) || err).replace(/^Error:\s*/, '');

    /* -------------------------------- 목록 그리기 ------------------------------- */

    const visibleOf = (entries) =>
      ex.showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));

    function visibleEntries() {
      return visibleOf(ex.entries);
    }

    /** 현재 폴더를 뿌리로 삼아 트리를 그린다 (펼친 폴더는 하위 항목이 들여쓰기되어 이어진다) */
    function renderList() {
      listEl.innerHTML = '';

      // 상위 폴더 줄 (여기로 파일을 끌어다 놓으면 상위 폴더로 이동한다)
      if (ex.cwd !== '/') {
        const up = document.createElement('div');
        up.className = 'ex-row up';
        up.innerHTML =
          '<span class="c-name"><span class="caret"></span>📁 <b>..</b></span>' +
          '<span class="c-size"></span><span class="c-time"></span><span class="c-perm"></span>';
        up.addEventListener('dblclick', () => navigate(parentOf(ex.cwd)));
        makeDropTarget(up, parentOf(ex.cwd));
        listEl.appendChild(up);
      }

      appendRows(ex.entries, 0);

      if (visibleEntries().length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ex-empty';
        empty.textContent = '빈 폴더입니다. 파일을 끌어다 놓거나 우클릭해 새로 만들 수 있습니다.';
        listEl.appendChild(empty);
      }
    }

    /** entries 를 depth 만큼 들여써서 붙이고, 펼쳐진 폴더는 재귀로 이어 붙인다 */
    function appendRows(entries, depth) {
      for (const entry of visibleOf(entries)) {
        listEl.appendChild(buildRow(entry, depth));
        if (isDirEntry(entry) && ex.expanded.has(entry.path)) {
          const kids = ex.children.get(entry.path) || [];
          if (visibleOf(kids).length === 0) {
            const empty = document.createElement('div');
            empty.className = 'ex-row child-empty';
            empty.style.paddingLeft = `${10 + (depth + 1) * 16}px`;
            empty.textContent = '(비어 있음)';
            listEl.appendChild(empty);
          } else {
            appendRows(kids, depth + 1);
          }
        }
      }
    }

    function buildRow(entry, depth) {
      const isDir = isDirEntry(entry);
      const row = document.createElement('div');
      row.className = 'ex-row' + (isDir ? ' is-dir' : '');
      row.draggable = true;
      row.dataset.path = entry.path;

      const name = document.createElement('span');
      name.className = 'c-name';
      name.style.paddingLeft = `${depth * 16}px`;
      name.title = entry.path;

      // 폴더 앞의 ▸/▾ — 누르면 그 자리에서 펼쳐진다
      const caret = document.createElement('span');
      caret.className = 'caret' + (isDir ? ' has' : '');
      caret.textContent = isDir ? (ex.expanded.has(entry.path) ? '▾' : '▸') : '';
      if (isDir) {
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleExpand(entry);
        });
      }

      const icon = entry.type === 'dir' ? '📁' : entry.type === 'link' ? '🔗' : fileIcon(entry.name);
      const text = document.createElement('span');
      text.className = 'nm';
      text.textContent = `${icon} ${entry.name}`;

      name.append(caret, text);

      const size = document.createElement('span');
      size.className = 'c-size';
      size.textContent = isDir ? '' : fmtSize(entry.size);

      const time = document.createElement('span');
      time.className = 'c-time';
      time.textContent = fmtTime(entry.mtime);

      const perm = document.createElement('span');
      perm.className = 'c-perm';
      perm.textContent = entry.rights || '';

      row.append(name, size, time, perm);
      if (ex.selected.has(entry.path)) row.classList.add('selected');

      row.addEventListener('click', (e) => selectRow(entry, row, e));
      row.addEventListener('dblclick', () => {
        if (isDir) toggleExpand(entry); // 들어가지 않고 그 자리에서 펼친다
        else if (typeof opts.onOpenFile === 'function') opts.onOpenFile(entry); // 현재 창에 파일 열기
        else downloadEntries([entry]);
      });
      row.addEventListener('contextmenu', (e) => {
        if (!ex.selected.has(entry.path)) selectRow(entry, row, e);
        openMenu(e, entry);
      });

      row.addEventListener('dragstart', (e) => {
        if (e.altKey) {
          e.preventDefault();
          dragOutToOS(entry);
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/armux-path', entry.path);
        e.dataTransfer.setData('text/plain', entry.path);
      });

      if (isDir) makeDropTarget(row, entry.path);
      return row;
    }

    function fileIcon(name) {
      const ext = name.split('.').pop().toLowerCase();
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return '🖼️';
      if (['zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar'].includes(ext)) return '🗜️';
      if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) return '🎞️';
      if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return '🎵';
      if (['pdf'].includes(ext)) return '📕';
      if (['py', 'js', 'ts', 'sh', 'rs', 'go', 'c', 'cpp', 'java', 'rb', 'php'].includes(ext)) return '📜';
      if (['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env'].includes(ext)) return '⚙️';
      if (['md', 'txt', 'log', 'csv'].includes(ext)) return '📄';
      return '📄';
    }

    function selectRow(entry, row, e) {
      if (!e.ctrlKey && !e.metaKey) ex.selected.clear();
      if (ex.selected.has(entry.path)) ex.selected.delete(entry.path);
      else ex.selected.add(entry.path);
      for (const r of listEl.querySelectorAll('.ex-row')) {
        r.classList.toggle('selected', ex.selected.has(r.dataset.path));
      }
    }

    const selectedEntries = () => ex.entries.filter((e) => ex.selected.has(e.path));

    /* --------------------------------- 드롭 --------------------------------- */

    /** row 를 드롭 대상(폴더)으로 만든다 */
    function makeDropTarget(row, dirPath) {
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add('drop-hover');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-hover'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-hover');
        await handleDrop(e, dirPath);
      });
    }

    // 빈 공간에 떨어뜨리면 현재 폴더로
    listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      listEl.classList.add('drop-hover');
    });
    listEl.addEventListener('dragleave', () => listEl.classList.remove('drop-hover'));
    listEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      listEl.classList.remove('drop-hover');
      await handleDrop(e, ex.cwd);
    });

    async function handleDrop(e, destDir) {
      // 1) OS 에서 끌어온 파일 → 업로드
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) {
        const paths = files.map((f) => api.util.pathForFile(f)).filter(Boolean);
        if (paths.length) return uploadPaths(paths, destDir);
      }
      // 2) 탐색기 내부 이동
      const src = e.dataTransfer.getData('text/armux-path');
      if (src) return moveEntry(src, destDir);
    }

    async function uploadPaths(paths, destDir) {
      try {
        ex.busy = true;
        ex.transferKind = 'upload';
        showProgress('upload', paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length}개 항목`, 0, 1);
        setStatus(`업로드 중… (${paths.length}개)`, true);
        await withSession(() => api.sftp.upload({ id: ex.sftpId, localPaths: paths, remoteDir: destDir }));
        setStatus(`업로드 완료 (${paths.length}개)`);
        await refresh();
      } catch (err) {
        hideProgress();
        setStatus(`업로드 실패: ${cleanErr(err)}`, true);
      } finally {
        ex.busy = false;
        ex.transferKind = null;
      }
    }

    async function pickAndUpload(directory) {
      const paths = await api.sftp.pickUpload(directory);
      if (paths && paths.length) await uploadPaths(paths, ex.cwd);
    }

    async function moveEntry(src, destDir) {
      const name = src.split('/').pop();
      const dest = joinRemote(destDir, name);
      if (src === dest || destDir === src) return;
      try {
        await withSession(() => api.sftp.rename(ex.sftpId, src, dest));
        setStatus(`${name} → ${destDir} 이동됨`);
        await refresh();
      } catch (err) {
        setStatus(`이동 실패: ${cleanErr(err)}`, true);
      }
    }

    async function dragOutToOS(entry) {
      try {
        ex.transferKind = 'download';
        showProgress('download', entry.name, 0, 1);
        setStatus(`${entry.name} 내려받는 중… (내 PC 로 꺼내기)`, true);
        const res = await withSession(() => api.sftp.dragOut({ id: ex.sftpId, remote: entry.path, name: entry.name }));
        if (res && res.dragStarted) setStatus(`${entry.name} 을(를) 끌어다 놓으세요`);
        else setStatus(`임시 폴더에 저장됨: ${res && res.path}`, true);
      } catch (err) {
        setStatus(`꺼내기 실패: ${cleanErr(err)}`, true);
      }
    }

    /* -------------------------------- 파일 작업 ------------------------------- */

    async function downloadEntries(entries) {
      for (const entry of entries) {
        try {
          ex.transferKind = 'download';
          showProgress('download', entry.name, 0, 1);
          setStatus(`${entry.name} 내려받는 중…`, true);
          const saved = await withSession(() => api.sftp.download({
            id: ex.sftpId,
            remote: entry.path,
            name: entry.name,
            isDir: entry.type === 'dir' || entry.linkToDir
          }));
          if (!saved) hideProgress(); // 저장 위치 선택을 취소한 경우
          setStatus(saved ? `저장됨: ${saved}` : '취소됨');
        } catch (err) {
          hideProgress();
          setStatus(`다운로드 실패: ${cleanErr(err)}`, true);
        } finally {
          ex.transferKind = null;
        }
      }
    }

    async function createEntry(kind) {
      const name = await prompt(kind === 'dir' ? '새 폴더 이름' : '새 파일 이름', kind === 'dir' ? 'new-folder' : 'new-file.txt');
      if (!name) return;
      const target = joinRemote(ex.cwd, name);
      try {
        if (kind === 'dir') await withSession(() => api.sftp.mkdir(ex.sftpId, target));
        else await withSession(() => api.sftp.createFile(ex.sftpId, target));
        setStatus(`${name} 생성됨`);
        await refresh();
      } catch (err) {
        setStatus(`생성 실패: ${cleanErr(err)}`, true);
      }
    }

    async function renameEntry(entry) {
      const name = await prompt('새 이름', entry.name);
      if (!name || name === entry.name) return;
      try {
        await withSession(() => api.sftp.rename(ex.sftpId, entry.path, joinRemote(parentOf(entry.path), name)));
        setStatus(`이름 변경: ${entry.name} → ${name}`);
        await refresh();
      } catch (err) {
        setStatus(`이름 변경 실패: ${cleanErr(err)}`, true);
      }
    }

    async function removeEntries(entries) {
      const label = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length}개 항목`;
      const ok = await api.util.confirm(`${label} 을(를) 삭제할까요?`, '폴더는 안의 내용까지 모두 삭제됩니다. 되돌릴 수 없습니다.');
      if (!ok) return;
      for (const entry of entries) {
        try {
          setStatus(`${entry.name} 삭제 중…`, true);
          await withSession(() => api.sftp.remove(ex.sftpId, entry.path));
        } catch (err) {
          setStatus(`삭제 실패: ${cleanErr(err)}`, true);
        }
      }
      setStatus('삭제 완료');
      await refresh();
    }

    /* ------------------------------- 우클릭 메뉴 ------------------------------- */

    const menu = document.createElement('div');
    menu.className = 'ex-menu hidden';
    document.body.appendChild(menu);

    function openMenu(e, entry) {
      e.preventDefault();
      const targets = selectedEntries().length ? selectedEntries() : [entry];
      const isDir = entry && (entry.type === 'dir' || entry.linkToDir);

      const items = [];
      if (entry) {
        if (isDir) {
          items.push([ex.expanded.has(entry.path) ? '접기' : '펼치기', () => toggleExpand(entry)]);
          items.push(['이 폴더를 최상위로', () => navigate(entry.path)]);
          items.push(['폴더째 내려받기', () => downloadEntries(targets)]);
        } else {
          if (typeof opts.onOpenFile === 'function') items.push(['현재 창에 열기', () => opts.onOpenFile(entry)]);
          items.push(['내려받기', () => downloadEntries(targets)]);
        }
        items.push(['이름 변경', () => renameEntry(entry)]);
        items.push(['경로 복사', () => api.util.clipboardWrite(entry.path)]);
        items.push(['삭제', () => removeEntries(targets), 'danger']);
        items.push(['-']);
      }
      items.push(['새 폴더', () => createEntry('dir')]);
      items.push(['새 파일', () => createEntry('file')]);
      items.push(['파일 업로드', () => pickAndUpload(false)]);
      items.push(['폴더 업로드', () => pickAndUpload(true)]);
      items.push(['-']);
      items.push(['새로고침', () => refresh()]);

      menu.innerHTML = '';
      for (const item of items) {
        if (item[0] === '-') {
          const hr = document.createElement('div');
          hr.className = 'ex-menu-sep';
          menu.appendChild(hr);
          continue;
        }
        const b = document.createElement('button');
        b.textContent = item[0];
        if (item[2]) b.classList.add(item[2]);
        b.addEventListener('click', () => {
          closeMenu();
          item[1]();
        });
        menu.appendChild(b);
      }

      menu.classList.remove('hidden');
      const maxX = window.innerWidth - menu.offsetWidth - 8;
      const maxY = window.innerHeight - menu.offsetHeight - 8;
      menu.style.left = `${Math.min(e.clientX, maxX)}px`;
      menu.style.top = `${Math.min(e.clientY, maxY)}px`;
    }

    function closeMenu() {
      menu.classList.add('hidden');
    }
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', (e) => {
      if (!menu.contains(e.target) && !root.contains(e.target)) closeMenu();
    });

    /* -------------------------------- 입력 대화상자 ------------------------------ */

    /** 간단한 이름 입력 프롬프트 (window.prompt 는 Electron 에서 막혀 있다) */
    function prompt(title, initial) {
      return new Promise((resolve) => {
        const back = document.createElement('div');
        back.className = 'ex-prompt-back';
        const box = document.createElement('div');
        box.className = 'ex-prompt';
        const h = document.createElement('div');
        h.className = 'ex-prompt-title';
        h.textContent = title;
        const input = document.createElement('input');
        input.className = 'field';
        input.value = initial || '';
        input.spellcheck = false;
        const row = document.createElement('div');
        row.className = 'ex-prompt-row';
        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.textContent = '취소';
        const ok = document.createElement('button');
        ok.className = 'btn btn-primary';
        ok.textContent = '확인';
        row.append(cancel, ok);
        box.append(h, input, row);
        back.appendChild(box);
        root.appendChild(back);

        const done = (val) => {
          back.remove();
          resolve(val);
        };
        cancel.addEventListener('click', () => done(null));
        ok.addEventListener('click', () => done(input.value.trim()));
        back.addEventListener('mousedown', (e) => {
          if (e.target === back) done(null);
        });
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') done(input.value.trim());
          if (e.key === 'Escape') done(null);
        });
        input.focus();
        input.select();
      });
    }

    /* --------------------------------- 키 입력 -------------------------------- */

    // 마우스 4번(뒤로) / 5번(앞으로) 버튼
    root.addEventListener('mousedown', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        back();
      } else if (e.button === 4) {
        e.preventDefault();
        forward();
      }
    });
    root.addEventListener('auxclick', (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    });

    root.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault();
        refresh();
      }
      if (e.key === 'Delete' && selectedEntries().length) {
        e.preventDefault();
        removeEntries(selectedEntries());
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        back();
      }
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        forward();
      }
    });

    /* -------------------------------- 진행률 표시 ------------------------------- */

    let progressTimer = null;

    /** 전송 진행 카드 표시 */
    function showProgress(kind, name, transferred, total) {
      const pct = total ? Math.round((transferred / total) * 100) : 0;
      progress.classList.remove('hidden');
      progress.classList.toggle('upload', kind === 'upload');
      progTitle.textContent = `${kind === 'upload' ? '⬆ 업로드 중' : '⬇ 다운로드 중'} — ${name}`;
      progFill.style.width = `${pct}%`;
      progMeta.textContent = `${fmtSize(transferred)} / ${fmtSize(total)}`;
      progPct.textContent = `${pct}%`;

      clearTimeout(progressTimer);
      // 전송이 끝나면 잠깐 100% 를 보여 주고 사라진다
      progressTimer = setTimeout(() => progress.classList.add('hidden'), pct >= 100 ? 1200 : 4000);
    }

    function hideProgress() {
      clearTimeout(progressTimer);
      progress.classList.add('hidden');
    }

    api.sftp.onProgress(({ id, name, transferred, total }) => {
      if (id !== ex.sftpId || !total) return;
      const base = String(name).split(/[\\/]/).pop();
      showProgress(ex.transferKind || 'download', base, transferred, total);
    });

    /* ---------------------------------- 정리 --------------------------------- */

    function dispose() {
      widthObserver.disconnect();
      if (ex.sftpId) api.sftp.close(ex.sftpId);
      ex.sftpId = null;
      menu.remove();
      root.remove();
    }

    // 최초 진입: 홈 디렉터리
    navigate('.');

    return ex;
  }

  return { create };
})();
