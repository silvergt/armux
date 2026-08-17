'use strict';

/**
 * 판(페인) 안에 뜨는 웹 브라우저.
 *
 * 주소창 · 뒤로/앞으로 · 새로고침을 갖춘 단순한 브라우저다.
 * 주소창에는 이 PC 크롬의 방문 기록을 읽어와 자동완성 후보를 띄운다(읽기 전용).
 *
 * 크롬의 로그인 세션(쿠키)까지 가져올 수는 없다. 크롬이 프로필을 암호화해
 * 잠가 두기 때문이다. 그래서 로그인은 이 창에서 따로 하거나,
 * 주소창 오른쪽의 "크롬에서 열기" 로 진짜 크롬에 넘겨서 열면 된다.
 */

window.WebPane = (function () {
  const api = window.armux;

  /** 사용자가 친 글자를 URL 로 (아니면 구글 검색) */
  function toUrl(input) {
    const q = String(input || '').trim();
    if (!q) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return q;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(q)) return `http://${q}`;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(q)) return `https://${q}`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  /**
   * @param {object} opts { url, onTitle(title), onUrl(url) }
   */
  function create(opts) {
    const state = { url: opts.url || 'https://www.google.com', title: '' };

    const root = document.createElement('div');
    root.className = 'webpane';

    /* --------------------------------- 툴바 --------------------------------- */

    const bar = document.createElement('div');
    bar.className = 'web-bar';

    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'web-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };

    const backBtn = mk('←', '뒤로', () => view.canGoBack() && view.goBack());
    const fwdBtn = mk('→', '앞으로', () => view.canGoForward() && view.goForward());
    const reloadBtn = mk('⟳', '새로고침', () => view.reload());
    const homeBtn = mk('⌂', '홈 (google.com)', () => go('https://www.google.com'));

    const urlWrap = document.createElement('div');
    urlWrap.className = 'web-url-wrap';

    const urlInput = document.createElement('input');
    urlInput.className = 'web-url';
    urlInput.spellcheck = false;
    urlInput.placeholder = '주소를 입력하거나 검색어를 입력하세요';

    // 방문 기록 자동완성 드롭다운
    const sugg = document.createElement('div');
    sugg.className = 'web-suggest hidden';
    let suggItems = [];
    let suggIndex = -1;

    const hideSuggest = () => {
      sugg.classList.add('hidden');
      suggItems = [];
      suggIndex = -1;
    };

    function renderSuggest() {
      sugg.innerHTML = '';
      if (!suggItems.length) {
        hideSuggest();
        return;
      }
      suggItems.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'web-suggest-row' + (i === suggIndex ? ' active' : '');
        const t = document.createElement('span');
        t.className = 'ws-title';
        t.textContent = it.title || it.url;
        const u = document.createElement('span');
        u.className = 'ws-url';
        u.textContent = it.url;
        row.append(t, u);
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          go(it.url);
          hideSuggest();
        });
        row.addEventListener('mouseenter', () => {
          suggIndex = i;
          for (const [j, el2] of [...sugg.children].entries()) el2.classList.toggle('active', j === i);
        });
        sugg.appendChild(row);
      });
      sugg.classList.remove('hidden');
    }

    let suggTimer = null;
    async function updateSuggest() {
      const q = urlInput.value.trim();
      if (!q || !api.web.historySuggest) {
        hideSuggest();
        return;
      }
      try {
        const items = await api.web.historySuggest(q);
        // 입력 도중 값이 바뀌었으면 버린다
        if (urlInput.value.trim() !== q) return;
        suggItems = items || [];
        suggIndex = -1;
        renderSuggest();
      } catch (e) {
        hideSuggest();
      }
    }

    urlInput.addEventListener('input', () => {
      clearTimeout(suggTimer);
      suggTimer = setTimeout(updateSuggest, 120);
    });
    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const open = !sugg.classList.contains('hidden') && suggItems.length;
      if (e.key === 'ArrowDown' && open) {
        e.preventDefault();
        suggIndex = (suggIndex + 1) % suggItems.length;
        renderSuggest();
        return;
      }
      if (e.key === 'ArrowUp' && open) {
        e.preventDefault();
        suggIndex = (suggIndex - 1 + suggItems.length) % suggItems.length;
        renderSuggest();
        return;
      }
      if (e.key === 'Enter') {
        if (open && suggIndex >= 0) go(suggItems[suggIndex].url);
        else go(urlInput.value);
        hideSuggest();
      }
      if (e.key === 'Escape') {
        if (open) hideSuggest();
        else urlInput.value = state.url;
      }
    });
    urlInput.addEventListener('focus', () => urlInput.select());
    urlInput.addEventListener('blur', () => setTimeout(hideSuggest, 120));

    urlWrap.append(urlInput, sugg);

    const chromeBtn = mk('크롬에서 열기', '이 PC 의 기본 브라우저(크롬)로 열기 — 크롬 로그인/설정 그대로', () =>
      api.web.openExternal(state.url)
    );
    chromeBtn.classList.add('web-btn-wide');

    bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, urlWrap, chromeBtn);

    /* -------------------------------- 웹 화면 -------------------------------- */

    const view = document.createElement('webview');
    view.className = 'web-view';
    view.setAttribute('src', state.url);
    view.setAttribute('allowpopups', '');
    // 로그인 세션이 유지되도록 영구 파티션을 쓴다
    view.setAttribute('partition', 'persist:armux-web');
    view.setAttribute('useragent', api.web.userAgent());

    const status = document.createElement('div');
    status.className = 'web-status';

    root.append(bar, view, status);

    /* --------------------------------- 동작 --------------------------------- */

    function go(input) {
      const url = toUrl(input);
      if (!url) return;
      state.url = url;
      urlInput.value = url;
      view.loadURL(url).catch(() => {});
    }

    function syncNav() {
      backBtn.disabled = !view.canGoBack();
      fwdBtn.disabled = !view.canGoForward();
    }

    view.addEventListener('did-start-loading', () => {
      status.textContent = '불러오는 중…';
      reloadBtn.textContent = '✕';
      reloadBtn.title = '중지';
    });
    view.addEventListener('did-stop-loading', () => {
      status.textContent = '';
      reloadBtn.textContent = '⟳';
      reloadBtn.title = '새로고침';
      syncNav();
    });
    view.addEventListener('did-navigate', (e) => {
      state.url = e.url;
      urlInput.value = e.url;
      syncNav();
      if (opts.onUrl) opts.onUrl(e.url);
    });
    view.addEventListener('did-navigate-in-page', (e) => {
      if (!e.isMainFrame) return;
      state.url = e.url;
      urlInput.value = e.url;
      if (opts.onUrl) opts.onUrl(e.url);
    });
    view.addEventListener('page-title-updated', (e) => {
      state.title = e.title;
      if (opts.onTitle) opts.onTitle(e.title);
    });
    view.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // 사용자가 중단한 경우
      status.textContent = `열지 못했습니다: ${e.errorDescription || e.errorCode}`;
    });
    // 새 창(target=_blank)은 같은 판에서 연다
    view.addEventListener('new-window', (e) => {
      e.preventDefault();
      go(e.url);
    });

    urlInput.value = state.url;

    return {
      el: root,
      get url() {
        return state.url;
      },
      get title() {
        return state.title;
      },
      go,
      focus: () => urlInput.focus(),
      dispose: () => root.remove()
    };
  }

  return { create, toUrl };
})();
