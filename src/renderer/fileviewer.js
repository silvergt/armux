'use strict';

/**
 * 판(페인) 안에서 원격 파일을 여는 뷰어/에디터.
 * 터미널·웹에 이어지는 세 번째 판 모드('file').
 *
 * 지원:
 *  - 텍스트/코드/json/yaml/txt : 편집 + 저장(Ctrl/⌘+S)
 *  - markdown(.md)            : 미리보기 ↔ 편집
 *  - csv                      : 표 보기 ↔ 원본 편집
 *  - 이미지(png/jpg/…)         : 보기
 *  - ipynb                    : 셀 렌더(마크다운/코드/출력) + 셀 편집 + 저장 + 전체 실행(원격 jupyter)
 *  - parquet                  : 앞부분 미리보기(원격 duckdb/pandas, 읽기 전용)
 */

window.FileViewer = (function () {
  const api = window.armux;

  const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];
  const TEXTY = [
    'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'ini', 'conf', 'cfg', 'env', 'toml',
    'js', 'ts', 'jsx', 'tsx', 'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'java',
    'kt', 'php', 'pl', 'lua', 'sql', 'r', 'jl', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'vue', 'svelte',
    'dockerfile', 'makefile', 'gitignore', 'gradle', 'properties'
  ];

  const extOf = (name) => {
    const b = name.toLowerCase();
    if (b === 'dockerfile' || b === 'makefile' || b.endsWith('/dockerfile')) return b.split('/').pop();
    const m = b.match(/\.([^.]+)$/);
    return m ? m[1] : '';
  };

  const HLJS_LANG = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
    go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', java: 'java',
    sql: 'sql', rb: 'ruby', php: 'php', html: 'xml', htm: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml',
    css: 'css', scss: 'css', less: 'css', md: 'markdown', markdown: 'markdown', dockerfile: 'dockerfile'
  };

  function kindOf(name) {
    const e = extOf(name);
    if (e === 'ipynb') return 'ipynb';
    if (e === 'parquet' || e === 'pq') return 'parquet';
    if (IMAGE.includes(e)) return 'image';
    if (e === 'csv' || e === 'tsv') return 'csv';
    if (e === 'md' || e === 'markdown') return 'markdown';
    if (TEXTY.includes(e)) return 'text';
    return 'text'; // 알 수 없는 확장자도 일단 텍스트로 시도
  }

  /** 이 파일을 이 뷰어로 열 수 있는지(무엇이든 시도는 가능하지만, 안내에 쓴다) */
  function canOpen(name) {
    return true;
  }

  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const b64ToUtf8 = (b64) => new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const utf8ToB64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  /* ------------------------------ 작은 마크다운 렌더러 ------------------------------ */
  function mdToHtml(md) {
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inCode = false;
    let inList = false;
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" class="md-link">$1</a>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line)) {
        if (inCode) {
          html += '</code></pre>';
          inCode = false;
        } else {
          if (inList) {
            html += '</ul>';
            inList = false;
          }
          html += '<pre class="md-pre"><code>';
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        html += esc(line) + '\n';
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        continue;
      }
      const li = line.match(/^\s*[-*+]\s+(.*)$/);
      if (li) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${inline(li[1])}</li>`;
        continue;
      }
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      if (!line.trim()) {
        html += '';
        continue;
      }
      html += `<p>${inline(line)}</p>`;
    }
    if (inCode) html += '</code></pre>';
    if (inList) html += '</ul>';
    return html;
  }

  /* --------------------------------- CSV 파서 --------------------------------- */
  function parseCsv(text, sep) {
    const rows = [];
    let row = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) {
        row.push(cur);
        cur = '';
      } else if (c === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else if (c === '\r') {
        /* skip */
      } else cur += c;
    }
    if (cur.length || row.length) {
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }

  /**
   * @param {object} opts { sftpId(), sessionId(), path, name, onClose }
   */
  function create(opts) {
    const state = { kind: kindOf(opts.name), content: '', dirty: false, mode: 'edit' };

    const root = document.createElement('div');
    root.className = 'fileview';
    root.tabIndex = 0;

    /* --------------------------------- 헤더 --------------------------------- */
    const bar = document.createElement('div');
    bar.className = 'fv-bar';

    const title = document.createElement('span');
    title.className = 'fv-title';
    title.textContent = opts.name;
    title.title = opts.path;

    const dirtyDot = document.createElement('span');
    dirtyDot.className = 'fv-dirty hidden';
    dirtyDot.textContent = '●';
    dirtyDot.title = '저장하지 않은 변경';

    const spacer = document.createElement('span');
    spacer.className = 'fv-spacer';

    const status = document.createElement('span');
    status.className = 'fv-status';

    const tools = document.createElement('span');
    tools.className = 'fv-tools';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fv-btn fv-close';
    closeBtn.textContent = '✕ 닫기';
    closeBtn.title = '파일을 닫고 터미널로 (Ctrl/⌘+W)';
    closeBtn.addEventListener('click', () => opts.onClose());

    bar.append(title, dirtyDot, spacer, status, tools, closeBtn);

    const body = document.createElement('div');
    body.className = 'fv-body';

    /* ------------------------------ 파일 안 검색 바 ------------------------------ */
    const findBar = document.createElement('div');
    findBar.className = 'fv-find hidden';
    const findInput = document.createElement('input');
    findInput.className = 'fv-find-input';
    findInput.placeholder = '파일에서 찾기';
    findInput.spellcheck = false;
    const findCount = document.createElement('span');
    findCount.className = 'fv-find-count';
    const mkFindBtn = (label, tip, fn) => {
      const b = document.createElement('button');
      b.className = 'fv-btn';
      b.textContent = label;
      b.title = tip;
      b.addEventListener('click', fn);
      return b;
    };
    const findPrev = mkFindBtn('↑', '이전 (Shift+Enter)', () => stepFind(-1));
    const findNext = mkFindBtn('↓', '다음 (Enter)', () => stepFind(1));
    const findClose = mkFindBtn('✕', '닫기 (Esc)', () => closeFind());
    findBar.append(findInput, findCount, findPrev, findNext, findClose);

    root.append(bar, findBar, body);

    /* ------------------------------- 도구 버튼 헬퍼 ------------------------------- */
    function addTool(label, tip, fn) {
      const b = document.createElement('button');
      b.className = 'fv-btn';
      b.textContent = label;
      b.title = tip || '';
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    }
    function setStatus(t, sticky) {
      status.textContent = t;
      if (!sticky) setTimeout(() => (status.textContent === t ? (status.textContent = '') : null), 2500);
    }
    const cleanErr = (e) => String((e && e.message) || e).replace(/^Error:\s*/, '');
    const markDirty = (d) => {
      state.dirty = d;
      dirtyDot.classList.toggle('hidden', !d);
    };

    /* --------------------------------- 로드 --------------------------------- */
    async function load() {
      body.innerHTML = '<div class="fv-loading">불러오는 중…</div>';
      try {
        if (state.kind === 'parquet') return renderParquet();
        const res = await api.sftp.readFile(opts.sftpId(), opts.path);
        state.size = res.size;
        if (state.kind === 'image') return renderImage(res.base64);
        state.content = b64ToUtf8(res.base64);
        if (state.kind === 'ipynb') return renderNotebook();
        if (state.kind === 'markdown') return renderMarkdown();
        if (state.kind === 'csv') return renderCsv();
        return renderText();
      } catch (e) {
        body.innerHTML = `<div class="fv-loading">열지 못했습니다: ${esc(cleanErr(e))}</div>`;
      }
    }

    /* --------------------------------- 저장 --------------------------------- */
    async function save() {
      if (state.kind === 'image' || state.kind === 'parquet') return;
      try {
        setStatus('저장 중…', true);
        await api.sftp.writeFile(opts.sftpId(), opts.path, utf8ToB64(state.content));
        markDirty(false);
        const now = new Date();
        const p = (x) => String(x).padStart(2, '0');
        setStatus(`저장됨 ${p(now.getHours())}:${p(now.getMinutes())}`);
      } catch (e) {
        setStatus(`저장 실패: ${cleanErr(e)}`, true);
      }
    }

    /* ------------------------------- 렌더: 텍스트 ------------------------------- */
    function makeEditor(value) {
      const wrap = document.createElement('div');
      wrap.className = 'fv-edit';
      const ta = document.createElement('textarea');
      ta.className = 'fv-textarea';
      ta.spellcheck = false;
      ta.value = value;
      ta.addEventListener('input', () => {
        state.content = ta.value;
        markDirty(true);
      });
      wrap.appendChild(ta);
      return { wrap, ta };
    }

    function highlightLang() {
      return HLJS_LANG[extOf(opts.name)] || null;
    }

    /*
     * 텍스트/코드 파일.
     *
     * 따로 "편집" 을 누르지 않아도 곧바로 고칠 수 있어야 하고, 그러면서 색깔도
     * 유지되어야 한다. 그래서 구문 강조한 <pre> 를 뒤에 깔고 그 위에 글자가
     * 투명한 <textarea> 를 정확히 겹쳐 놓는다. 사용자는 textarea 에 입력하지만
     * 눈에 보이는 글자는 뒤쪽 <pre> 의 색깔 있는 글자다.
     *
     * 왼쪽에는 줄 번호(gutter)를 둔다. 줄 번호가 글자와 어긋나지 않으려면 줄이
     * 접히면 안 되므로 자동 줄바꿈 대신 가로 스크롤을 쓴다(코드 편집기와 같은 방식).
     * 세 요소(줄번호·pre·textarea)의 폰트·크기·행간·세로 여백이 모두 같아야 한다.
     */
    function renderText() {
      tools.innerHTML = '';
      const lang = highlightLang();
      const hasHl = lang && window.hljs;

      if (extOf(opts.name) === 'json') {
        addTool('정리', 'JSON 들여쓰기 정리', () => {
          try {
            state.content = JSON.stringify(JSON.parse(state.content), null, 2);
            markDirty(true);
            renderText();
          } catch (e) {
            setStatus('JSON 형식이 아니라 정리할 수 없습니다.', true);
          }
        });
      }
      addTool('저장', '저장 (Ctrl/⌘+S)', save);

      body.innerHTML = '';

      const wrap = document.createElement('div');
      wrap.className = 'fv-hledit';

      const gutter = document.createElement('div'); // 왼쪽 줄 번호
      gutter.className = 'fv-gutter';
      gutter.setAttribute('aria-hidden', 'true');

      const area = document.createElement('div'); // pre + textarea 가 겹치는 영역
      area.className = 'fv-hlarea';

      // 검색 결과를 칠할 레이어. 글자는 투명하고 배경만 보인다.
      // 색깔 글자(<pre>)보다 뒤에 두어야 글자를 덮지 않는다.
      const marks = document.createElement('div');
      marks.className = 'fv-hl-marks';
      marks.setAttribute('aria-hidden', 'true');
      area.appendChild(marks);

      let code = null;
      if (hasHl) {
        const pre = document.createElement('pre'); // 뒤: 색깔 입힌 글자
        pre.className = 'fv-hl-back';
        pre.setAttribute('aria-hidden', 'true');
        code = document.createElement('code');
        pre.appendChild(code);
        area.appendChild(pre);
        area.dataset.hl = '1';
      }

      const ta = document.createElement('textarea'); // 앞: 실제 입력
      ta.className = 'fv-hl-front' + (hasHl ? '' : ' plain'); // 강조가 없으면 글자를 그대로 보여 준다
      ta.spellcheck = false;
      ta.value = state.content;
      area.appendChild(ta);

      wrap.append(gutter, area);
      body.appendChild(wrap);

      const back = () => area.querySelector('.fv-hl-back');

      /** 줄 번호를 현재 줄 수에 맞게 다시 그린다 */
      const paintGutter = () => {
        const n = ta.value.split('\n').length;
        if (gutter.childElementCount !== n) {
          const frag = [];
          for (let i = 1; i <= n; i++) frag.push(`<span>${i}</span>`);
          gutter.innerHTML = frag.join('');
        }
        // 자릿수만큼 너비를 잡아 준다(1000줄이 넘어가도 잘리지 않게)
        gutter.style.width = `calc(${String(n).length}ch + 20px)`;
      };

      /** 구문 강조를 다시 칠한다 */
      const paintCode = () => {
        if (!code) return;
        try {
          code.innerHTML = window.hljs.highlight(ta.value, { language: lang, ignoreIllegals: true }).value;
        } catch (e) {
          code.textContent = ta.value;
        }
        // 끝이 개행이면 <pre> 높이가 한 줄 모자라 스크롤이 어긋난다
        if (ta.value.endsWith('\n')) code.innerHTML += '\n';
      };

      const syncScroll = () => {
        const p = back();
        if (p) {
          p.scrollTop = ta.scrollTop;
          p.scrollLeft = ta.scrollLeft;
        }
        marks.scrollTop = ta.scrollTop;
        marks.scrollLeft = ta.scrollLeft;
        gutter.scrollTop = ta.scrollTop; // 줄 번호도 같이 움직인다
      };

      const onEdit = () => {
        state.content = ta.value;
        markDirty(true);
        paintCode();
        paintGutter();
        marks.innerHTML = ''; // 내용이 바뀌었으니 이전 검색 표시는 지운다
        syncScroll();
      };

      ta.addEventListener('input', onEdit);
      ta.addEventListener('scroll', syncScroll);
      // Tab 은 포커스 이동 대신 들여쓰기로 (코드 편집기다운 동작)
      ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        const st = ta.selectionStart;
        const en = ta.selectionEnd;
        ta.value = ta.value.slice(0, st) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = st + 2;
        onEdit();
      });

      paintCode();
      paintGutter();
      state._focus = () => ta.focus();
      // 검색 기능이 이 편집기의 강조 레이어를 쓸 수 있게 연결해 둔다
      state._marks = marks;
      state._syncScroll = syncScroll;
    }

    /* ------------------------------ 렌더: 마크다운 ------------------------------ */
    function renderMarkdown() {
      tools.innerHTML = '';
      const toggle = addTool(state.mode === 'preview' ? '편집' : '미리보기', '보기 전환', () => {
        state.mode = state.mode === 'preview' ? 'edit' : 'preview';
        renderMarkdown();
      });
      addTool('저장', '저장 (Ctrl/⌘+S)', save);
      body.innerHTML = '';
      if (state.mode === 'preview') {
        const div = document.createElement('div');
        div.className = 'fv-md';
        div.innerHTML = mdToHtml(state.content);
        div.querySelectorAll('a.md-link').forEach((a) =>
          a.addEventListener('click', (e) => {
            e.preventDefault();
            api.util.openExternal(a.getAttribute('href'));
          })
        );
        body.appendChild(div);
      } else {
        const { wrap, ta } = makeEditor(state.content);
        body.appendChild(wrap);
        state._focus = () => ta.focus();
      }
      toggle.textContent = state.mode === 'preview' ? '편집' : '미리보기';
    }

    /* -------------------------------- 렌더: CSV -------------------------------- */
    function renderCsv() {
      tools.innerHTML = '';
      addTool(state.mode === 'table' ? '원본' : '표', '보기 전환', () => {
        state.mode = state.mode === 'table' ? 'edit' : 'table';
        renderCsv();
      });
      addTool('저장', '저장 (Ctrl/⌘+S)', save);
      body.innerHTML = '';
      if (state.mode === 'table') {
        const sep = extOf(opts.name) === 'tsv' ? '\t' : ',';
        const rows = parseCsv(state.content, sep).slice(0, 2000);
        const table = document.createElement('table');
        table.className = 'fv-table';
        rows.forEach((r, i) => {
          const tr = document.createElement('tr');
          r.forEach((cell) => {
            const td = document.createElement(i === 0 ? 'th' : 'td');
            td.textContent = cell;
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        const scroll = document.createElement('div');
        scroll.className = 'fv-table-scroll';
        scroll.appendChild(table);
        body.appendChild(scroll);
        setStatus(`${rows.length}행 (표는 읽기 전용, 편집은 "원본")`, true);
      } else {
        const { wrap, ta } = makeEditor(state.content);
        body.appendChild(wrap);
        state._focus = () => ta.focus();
      }
    }

    /* ------------------------------- 렌더: 이미지 ------------------------------- */
    function renderImage(b64) {
      tools.innerHTML = '';
      const e = extOf(opts.name);
      const mime = e === 'svg' ? 'image/svg+xml' : e === 'ico' ? 'image/x-icon' : `image/${e === 'jpg' ? 'jpeg' : e}`;
      body.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'fv-image';
      const img = document.createElement('img');
      img.src = `data:${mime};base64,${b64}`;
      img.onload = () => setStatus(`${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(state.size)}`, true);
      box.appendChild(img);
      body.appendChild(box);
    }

    /* ------------------------------ 렌더: parquet ------------------------------ */
    async function renderParquet() {
      tools.innerHTML = '';
      body.innerHTML = '<div class="fv-loading">미리보기 불러오는 중… (원격 duckdb/pandas 사용)</div>';
      try {
        const out = await api.sftp.parquetPreview({ sessionId: opts.sessionId(), path: opts.path, limit: 300 });
        if (/ARMUX_ERR:/.test(out) || !out.trim()) {
          body.innerHTML =
            '<div class="fv-loading">미리보기를 만들 수 없습니다. 서버에 <b>duckdb</b> 또는 <b>python3 + pandas</b> 가 필요합니다.<br/>' +
            (out.includes('ARMUX_ERR:') ? esc(out.split('ARMUX_ERR:')[1].split('\n')[0]) : '') +
            '</div>';
          return;
        }
        let shape = '';
        let csv = out;
        const m = out.match(/ARMUX_SHAPE:(\d+),(\d+)/);
        if (m) {
          shape = ` · 전체 ${m[1]}행 × ${m[2]}열`;
          csv = out.replace(/ARMUX_SHAPE:[^\n]*\n/, '');
        }
        const rows = parseCsv(csv, ',');
        const table = document.createElement('table');
        table.className = 'fv-table';
        rows.forEach((r, i) => {
          const tr = document.createElement('tr');
          r.forEach((cell) => {
            const td = document.createElement(i === 0 ? 'th' : 'td');
            td.textContent = cell;
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        const scroll = document.createElement('div');
        scroll.className = 'fv-table-scroll';
        scroll.appendChild(table);
        body.innerHTML = '';
        body.appendChild(scroll);
        setStatus(`parquet 미리보기 ${Math.max(0, rows.length - 1)}행 표시${shape} (읽기 전용)`, true);
      } catch (e) {
        body.innerHTML = `<div class="fv-loading">미리보기 실패: ${esc(cleanErr(e))}</div>`;
      }
    }

    /* ------------------------------- 렌더: ipynb ------------------------------- */
    let nb = null;
    function renderNotebook() {
      try {
        nb = JSON.parse(state.content);
      } catch (e) {
        return renderText(); // 깨진 노트북은 원본 텍스트로
      }
      tools.innerHTML = '';
      addTool('저장', '셀 편집 내용을 저장 (Ctrl/⌘+S)', saveNotebook);
      const runBtn = addTool('▶ 전체 실행', '서버의 jupyter 로 노트북 전체 실행', runNotebook);
      runBtn.classList.add('fv-run');

      body.innerHTML = '';
      const list = document.createElement('div');
      list.className = 'fv-nb';
      const cells = Array.isArray(nb.cells) ? nb.cells : [];
      cells.forEach((cell, idx) => list.appendChild(renderCell(cell, idx)));
      body.appendChild(list);
      // DOM 에 올라간 뒤에 코드 셀 높이를 다시 맞춘다(붙기 전엔 scrollHeight 가 0)
      requestAnimationFrame(() => list.querySelectorAll('.nb-src').forEach(autoGrow));
      setStatus(`${cells.length}개 셀`, true);
    }

    function cellSource(cell) {
      return Array.isArray(cell.source) ? cell.source.join('') : cell.source || '';
    }

    function renderCell(cell, idx) {
      const wrap = document.createElement('div');
      wrap.className = `nb-cell nb-${cell.cell_type}`;

      const gutter = document.createElement('div');
      gutter.className = 'nb-gutter';
      gutter.textContent =
        cell.cell_type === 'code' ? `[${cell.execution_count != null ? cell.execution_count : ' '}]` : 'md';

      const main = document.createElement('div');
      main.className = 'nb-main';

      if (cell.cell_type === 'markdown') {
        const view = document.createElement('div');
        view.className = 'fv-md nb-md';
        view.innerHTML = mdToHtml(cellSource(cell));
        view.title = '더블클릭하면 편집';
        view.addEventListener('dblclick', () => editCellSource(cell, main, view));
        main.appendChild(view);
      } else {
        const ta = document.createElement('textarea');
        ta.className = 'nb-src';
        ta.spellcheck = false;
        ta.value = cellSource(cell);
        autoGrow(ta);
        ta.addEventListener('input', () => {
          cell.source = ta.value.split(/(?<=\n)/);
          autoGrow(ta);
          markDirty(true);
        });
        main.appendChild(ta);
        // 출력
        const outs = Array.isArray(cell.outputs) ? cell.outputs : [];
        for (const o of outs) {
          const oe = renderOutput(o);
          if (oe) main.appendChild(oe);
        }
      }
      wrap.append(gutter, main);
      return wrap;
    }

    function editCellSource(cell, main, view) {
      const ta = document.createElement('textarea');
      ta.className = 'nb-src nb-md-edit';
      ta.spellcheck = false;
      ta.value = cellSource(cell);
      autoGrow(ta);
      ta.addEventListener('input', () => {
        cell.source = ta.value.split(/(?<=\n)/);
        autoGrow(ta);
        markDirty(true);
      });
      ta.addEventListener('blur', () => {
        view.innerHTML = mdToHtml(cellSource(cell));
        main.replaceChild(view, ta);
      });
      main.replaceChild(ta, view);
      ta.focus();
    }

    function autoGrow(ta) {
      ta.style.height = 'auto';
      const h = ta.scrollHeight || (ta.value.split('\n').length * 18 + 16);
      ta.style.height = Math.max(28, Math.min(600, h + 2)) + 'px';
    }

    function renderOutput(o) {
      const box = document.createElement('div');
      box.className = 'nb-out';
      if (o.output_type === 'stream') {
        box.classList.add('nb-out-text');
        box.textContent = Array.isArray(o.text) ? o.text.join('') : o.text || '';
        return box;
      }
      if (o.output_type === 'error') {
        box.classList.add('nb-out-error');
        box.textContent = (o.traceback || []).join('\n').replace(/\[[0-9;]*m/g, '');
        return box;
      }
      if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
        const data = o.data || {};
        if (data['image/png']) {
          const img = document.createElement('img');
          img.className = 'nb-out-img';
          img.src = `data:image/png;base64,${(Array.isArray(data['image/png']) ? data['image/png'].join('') : data['image/png']).replace(/\n/g, '')}`;
          box.appendChild(img);
          return box;
        }
        if (data['text/html']) {
          box.classList.add('nb-out-html');
          box.innerHTML = sanitizeHtml(Array.isArray(data['text/html']) ? data['text/html'].join('') : data['text/html']);
          return box;
        }
        if (data['text/plain']) {
          box.classList.add('nb-out-text');
          box.textContent = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain'];
          return box;
        }
      }
      return null;
    }

    // 노트북 HTML 출력은 표 정도만 허용(스크립트 제거)
    function sanitizeHtml(html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      div.querySelectorAll('script,style,iframe,object,embed,link').forEach((n) => n.remove());
      div.querySelectorAll('*').forEach((n) => {
        [...n.attributes].forEach((a) => {
          if (/^on/i.test(a.name) || (a.name === 'href' && /^javascript:/i.test(a.value))) n.removeAttribute(a.name);
        });
      });
      return div.innerHTML;
    }

    async function saveNotebook() {
      if (!nb) return;
      state.content = JSON.stringify(nb, null, 1);
      await save();
    }

    async function runNotebook() {
      if (state.dirty) await saveNotebook();
      const runBtn = tools.querySelector('.fv-run');
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = '실행 중…';
      }
      setStatus('노트북 실행 중… (서버 jupyter)', true);
      try {
        const out = await api.sftp.runNotebook({ sessionId: opts.sessionId(), path: opts.path, timeout: 300 });
        if (/ARMUX_NONBCONVERT|ARMUX_NOJUPYTER/.test(out)) {
          setStatus('서버에 nbconvert 가 없어 실행할 수 없습니다. (pip install nbconvert ipykernel)', true);
          return;
        } else if (/Traceback|Error/.test(out) && !/ARMUX_DONE/.test(out)) {
          setStatus('실행 중 오류가 발생했습니다. 출력을 확인하세요.', true);
        } else {
          setStatus('실행 완료 — 결과를 다시 불러왔습니다.');
        }
        // 실행 결과가 파일에 반영됐으니 다시 읽어 렌더
        const res = await api.sftp.readFile(opts.sftpId(), opts.path);
        state.content = b64ToUtf8(res.base64);
        markDirty(false);
        renderNotebook();
      } catch (e) {
        setStatus(`실행 실패: ${cleanErr(e)}`, true);
      } finally {
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.textContent = '▶ 전체 실행';
        }
      }
    }

    /* --------------------------------- 닫기/키 -------------------------------- */
    async function requestClose() {
      if (state.dirty) {
        const ok = await api.util.confirm('저장하지 않은 변경이 있습니다. 저장하고 닫을까요?', opts.name, '저장하고 닫기');
        if (ok) await (state.kind === 'ipynb' ? saveNotebook() : save());
      }
      opts.onClose();
    }

    /* -------------------------------- 파일 안 검색 ------------------------------- */

    const find = { hits: [], at: -1, q: '' };

    /** 지금 화면의 편집기(textarea). 텍스트/코드 보기일 때만 있다. */
    const findTarget = () => body.querySelector('.fv-hl-front, .fv-textarea');

    /** 검색어로 위치를 모두 찾아 둔다 (대소문자 무시) */
    function runFind() {
      const ta = findTarget();
      const q = findInput.value;
      find.q = q;
      find.hits = [];
      find.at = -1;
      if (ta && q) {
        const hay = ta.value.toLowerCase();
        const needle = q.toLowerCase();
        let i = hay.indexOf(needle);
        while (i !== -1 && find.hits.length < 5000) {
          find.hits.push(i);
          i = hay.indexOf(needle, i + Math.max(1, needle.length));
        }
      }
      if (find.hits.length) {
        stepFind(1);
      } else {
        paintMarks(); // 결과가 없으면 이전 표시를 지운다
        paintFindCount();
      }
    }

    /**
     * 찾은 자리를 강조 레이어에 칠한다.
     * textarea 는 포커스가 없으면 브라우저가 선택을 그려 주지 않으므로,
     * 배경만 있는 레이어를 따로 두고 거기에 직접 표시한다.
     * 지금 보고 있는 결과는 더 진한 색으로 구분한다.
     */
    function paintMarks() {
      const marks = state._marks;
      const ta = findTarget();
      if (!marks || !ta) return;
      if (!find.hits.length || !find.q) {
        marks.innerHTML = '';
        return;
      }
      const text = ta.value;
      const len = find.q.length;
      let html = '';
      let at = 0;
      for (let i = 0; i < find.hits.length; i++) {
        const pos = find.hits[i];
        html += esc(text.slice(at, pos));
        html += `<mark class="${i === find.at ? 'cur' : ''}">${esc(text.slice(pos, pos + len))}</mark>`;
        at = pos + len;
      }
      html += esc(text.slice(at));
      marks.innerHTML = html;
      if (state._syncScroll) state._syncScroll();
    }

    function paintFindCount() {
      const ta = findTarget();
      if (!ta) findCount.textContent = '이 보기에서는 검색할 수 없습니다';
      else if (!find.q) findCount.textContent = '';
      else if (!find.hits.length) findCount.textContent = '결과 없음';
      else findCount.textContent = `${find.at + 1} / ${find.hits.length}`;
      findPrev.disabled = findNext.disabled = find.hits.length === 0;
    }

    /**
     * 다음(1)/이전(-1) 결과로 이동해 선택하고 화면을 맞춘다.
     * 포커스는 검색창에 그대로 둔다 — 예전에는 여기서 편집기에 포커스를 줘서
     * 한 글자만 쳐도 커서가 본문으로 튀어 버렸다(일반 검색창 동작과 다름).
     * 위치는 직접 계산해 넣으므로 포커스를 옮기지 않아도 정확히 스크롤된다.
     */
    function stepFind(dir) {
      const ta = findTarget();
      if (!ta || !find.hits.length) return paintFindCount();
      find.at = (find.at + dir + find.hits.length) % find.hits.length;
      const pos = find.hits[find.at];
      ta.setSelectionRange(pos, pos + find.q.length);
      // 줄이 접히지 않으므로(white-space: pre) 줄 번호 × 줄 높이로 위치를 계산할 수 있다
      const line = ta.value.slice(0, pos).split('\n').length;
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
      ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 3);
      // 찾은 글자가 가로로 멀리 있으면 그쪽도 보이게 맞춘다
      const col = pos - ta.value.lastIndexOf('\n', pos - 1) - 1;
      const cw = lh * 0.5; // 고정폭 글꼴의 대략적인 글자 너비
      const want = col * cw;
      if (want < ta.scrollLeft || want > ta.scrollLeft + ta.clientWidth - 80) {
        ta.scrollLeft = Math.max(0, want - ta.clientWidth / 3);
      }
      paintMarks(); // 찾은 자리를 칠하고 스크롤도 맞춘다
      paintFindCount();
    }

    function openFind() {
      findBar.classList.remove('hidden');
      const ta = findTarget();
      if (ta) ta.classList.add('finding'); // 포커스가 없어도 선택이 보이도록
      // 드래그로 고른 글자가 있으면 그것을 검색어로 채운다
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (sel && !sel.includes('\n')) findInput.value = sel;
      }
      findInput.focus();
      findInput.select();
      runFind();
    }

    function closeFind() {
      findBar.classList.add('hidden');
      find.hits = [];
      find.at = -1;
      if (state._marks) state._marks.innerHTML = '';
      const ta = findTarget();
      if (ta) {
        ta.classList.remove('finding');
        ta.focus(); // 검색을 끝냈으니 이제 본문으로 돌아간다
      }
    }

    findInput.addEventListener('input', runFind);
    findInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
      }
    });

    root.addEventListener('keydown', (e) => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openFind();
        return;
      }
      if (e.key === 'Escape' && !findBar.classList.contains('hidden')) {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        if (state.kind === 'ipynb') saveNotebook();
        else save();
      }
    });

    load();

    return {
      el: root,
      focus: () => (state._focus ? state._focus() : root.focus()),
      isDirty: () => state.dirty,
      openFind,
      dispose: () => root.remove()
    };
  }

  return { create, kindOf, canOpen };
})();
