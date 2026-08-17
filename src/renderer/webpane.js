'use strict';

/**
 * 판(페인) 안에 뜨는 웹 브라우저.
 *
 * 크롬처럼 쓰라고 주소창 · 뒤로/앞으로 · 새로고침 · 북마크 바를 갖췄고,
 * 북마크 바에는 이 PC 에 설치된 **크롬의 북마크 바**를 읽어와 함께 보여 준다.
 *
 * 다만 크롬의 로그인 세션(쿠키)까지 가져올 수는 없다. 크롬이 프로필을 암호화해
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

    const urlInput = document.createElement('input');
    urlInput.className = 'web-url';
    urlInput.spellcheck = false;
    urlInput.placeholder = '주소를 입력하거나 검색어를 입력하세요';
    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go(urlInput.value);
      if (e.key === 'Escape') urlInput.value = state.url;
    });
    urlInput.addEventListener('focus', () => urlInput.select());

    const starBtn = mk('☆', '이 페이지를 북마크에 추가', async () => {
      await api.web.addBookmark({ name: state.title || state.url, url: state.url });
      await loadBookmarks();
    });
    const chromeBtn = mk('크롬에서 열기', '이 PC 의 기본 브라우저(크롬)로 열기 — 크롬 로그인/설정 그대로', () =>
      api.web.openExternal(state.url)
    );
    chromeBtn.classList.add('web-btn-wide');

    bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, urlInput, starBtn, chromeBtn);

    /* ------------------------------- 북마크 바 ------------------------------- */

    const marks = document.createElement('div');
    marks.className = 'web-marks';

    async function loadBookmarks() {
      const res = await api.web.bookmarks();
      marks.innerHTML = '';
      if (!res.items.length) {
        const hint = document.createElement('span');
        hint.className = 'web-marks-hint';
        hint.textContent = '북마크가 없습니다. ☆ 로 추가하거나, 이 PC 의 크롬 북마크가 있으면 자동으로 보입니다.';
        marks.appendChild(hint);
        return;
      }
      for (const b of res.items) {
        const chip = document.createElement('button');
        chip.className = 'web-mark' + (b.mine ? ' mine' : '');
        chip.textContent = b.name.length > 22 ? `${b.name.slice(0, 21)}…` : b.name;
        chip.title = `${b.name}\n${b.url}${b.mine ? '\n(우클릭: 삭제)' : '\n(크롬 북마크)'}`;
        chip.addEventListener('click', () => go(b.url));
        chip.addEventListener('contextmenu', async (e) => {
          e.preventDefault();
          if (!b.mine) return;
          await api.web.removeBookmark(b.url);
          await loadBookmarks();
        });
        marks.appendChild(chip);
      }
    }

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

    root.append(bar, marks, view, status);

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
    loadBookmarks();

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
      reloadBookmarks: loadBookmarks,
      dispose: () => root.remove()
    };
  }

  return { create, toUrl };
})();
