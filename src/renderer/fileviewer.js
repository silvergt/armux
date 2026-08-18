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

    root.append(bar, body);

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

    function renderText() {
      tools.innerHTML = '';
      const lang = highlightLang();
      const hasHl = lang && window.hljs;
      if (!state._textInit) {
        state._textInit = true;
        state.mode = hasHl ? 'view' : 'edit';
      }

      if (hasHl) {
        addTool(state.mode === 'view' ? '편집' : '보기', '구문 강조 보기 ↔ 편집', () => {
          state.mode = state.mode === 'view' ? 'edit' : 'view';
          renderText();
        });
      }
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
      if (hasHl && state.mode === 'view') {
        const pre = document.createElement('pre');
        pre.className = 'fv-code';
        const code = document.createElement('code');
        try {
          code.innerHTML = window.hljs.highlight(state.content, { language: lang, ignoreIllegals: true }).value;
        } catch (e) {
          code.textContent = state.content;
        }
        pre.appendChild(code);
        pre.title = '더블클릭하면 편집';
        pre.addEventListener('dblclick', () => {
          state.mode = 'edit';
          renderText();
        });
        body.appendChild(pre);
      } else {
        const { wrap, ta } = makeEditor(state.content);
        body.appendChild(wrap);
        state._focus = () => ta.focus();
      }
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

    root.addEventListener('keydown', (e) => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey;
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
      dispose: () => root.remove()
    };
  }

  return { create, kindOf, canOpen };
})();
