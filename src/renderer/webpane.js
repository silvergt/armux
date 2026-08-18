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
    const state = { url: opts.url || null, title: '', faved: false };

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
    const homeBtn = mk('⌂ 홈', '시작 화면(주소 입력 + 즐겨찾기)', () => showStart());

    // 즐겨찾기 토글. 지금 페이지가 목록에 있으면 꽉 찬 별(★), 없으면 빈 별(☆).
    const favBtn = mk('☆', '이 페이지를 즐겨찾기에 추가', async () => {
      if (!state.url) return;
      if (state.faved) await api.web.favRemove(state.url);
      else await api.web.favAdd({ name: state.title || state.url, url: state.url });
      await syncFav();
      renderFavs(); // 시작 화면 목록도 같이 갱신
    });

    /** 지금 주소가 즐겨찾기에 들어 있는지 확인해 별 모양을 맞춘다 */
    async function syncFav() {
      let list = [];
      try {
        list = (await api.web.favList()) || [];
      } catch (e) {
        list = [];
      }
      state.faved = Boolean(state.url && list.some((f) => f.url === state.url));
      favBtn.textContent = state.faved ? '★' : '☆';
      favBtn.title = state.faved ? '즐겨찾기에서 빼기' : '이 페이지를 즐겨찾기에 추가';
      favBtn.classList.toggle('on', state.faved);
      favBtn.disabled = !state.url;
    }

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

    bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, favBtn, urlWrap, chromeBtn);

    /* -------------------------------- 웹 화면 -------------------------------- */

    const view = document.createElement('webview');
    view.className = 'web-view';
    view.setAttribute('src', 'about:blank');
    view.setAttribute('allowpopups', '');
    // 로그인 세션이 유지되도록 영구 파티션을 쓴다
    view.setAttribute('partition', 'persist:armux-web');
    view.setAttribute('useragent', api.web.userAgent());

    // 시작 화면(주소 입력 + 즐겨찾기). URL 이 아직 없을 때 보인다.
    const start = document.createElement('div');
    start.className = 'web-start';
    const startInner = document.createElement('div');
    startInner.className = 'web-start-inner';
    const startTitle = document.createElement('div');
    startTitle.className = 'web-start-title';
    startTitle.textContent = '웹페이지 열기';
    const startInput = document.createElement('input');
    startInput.className = 'web-start-url';
    startInput.spellcheck = false;
    startInput.placeholder = '주소를 입력하거나 검색어를 입력하고 Enter';
    startInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && startInput.value.trim()) go(startInput.value.trim());
    });
    const favTitle = document.createElement('div');
    favTitle.className = 'web-start-subtitle';
    favTitle.textContent = '즐겨찾기';
    const favGrid = document.createElement('div');
    favGrid.className = 'web-fav-grid';
    startInner.append(startTitle, startInput, favTitle, favGrid);
    start.appendChild(startInner);

    async function renderFavs() {
      const favs = await api.web.favList();
      favGrid.innerHTML = '';
      if (!favs.length) {
        const hint = document.createElement('div');
        hint.className = 'web-fav-empty';
        hint.textContent = '아직 즐겨찾기가 없습니다. 페이지를 연 뒤 주소창 옆 ☆ 을 눌러 등록하세요.';
        favGrid.appendChild(hint);
        return;
      }
      for (const f of favs) {
        const card = document.createElement('div');
        card.className = 'web-fav';
        const name = document.createElement('div');
        name.className = 'web-fav-name';
        name.textContent = f.name || f.url;
        const url = document.createElement('div');
        url.className = 'web-fav-url';
        url.textContent = f.url;
        const del = document.createElement('button');
        del.className = 'web-fav-del';
        del.textContent = '✕';
        del.title = '즐겨찾기에서 삭제';
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          await api.web.favRemove(f.url);
          renderFavs();
        });
        card.append(name, url, del);
        card.addEventListener('click', () => go(f.url));
        favGrid.appendChild(card);
      }
    }

    // 열지 못했을 때 보여 줄 화면. webview 는 실패하면 하얀 화면만 남으므로
    // 무엇이 잘못됐는지 이 판 위에 직접 그려 준다.
    const errBox = document.createElement('div');
    errBox.className = 'web-error hidden';
    const errTitle = document.createElement('div');
    errTitle.className = 'web-error-title';
    const errMsg = document.createElement('div');
    errMsg.className = 'web-error-msg';
    const errActions = document.createElement('div');
    errActions.className = 'web-error-actions';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'web-btn';
    retryBtn.textContent = '다시 시도';
    retryBtn.addEventListener('click', () => state.url && go(state.url));
    const extBtn = document.createElement('button');
    extBtn.className = 'web-btn';
    extBtn.textContent = '크롬에서 열기';
    extBtn.addEventListener('click', () => state.url && api.web.openExternal(state.url));
    errActions.append(retryBtn, extBtn);
    errBox.append(errTitle, errMsg, errActions);

    const showError = (title, msg) => {
      errTitle.textContent = title;
      errMsg.textContent = msg || '';
      errBox.classList.remove('hidden');
    };
    const hideError = () => errBox.classList.add('hidden');

    const status = document.createElement('div');
    status.className = 'web-status';

    root.append(bar, start, view, errBox, status);

    function showStart() {
      hideError();
      start.classList.remove('hidden');
      view.classList.add('hidden');
      urlInput.value = '';
      syncFav();
      renderFavs();
      startInput.focus();
    }
    function showBrowser() {
      start.classList.add('hidden');
      view.classList.remove('hidden');
    }

    /* --------------------------------- 동작 --------------------------------- */

    function go(input) {
      const url = toUrl(input);
      if (!url) return;
      state.url = url;
      urlInput.value = url;
      showBrowser();
      syncFav();
      view.loadURL(url).catch(() => {});
    }

    function syncNav() {
      backBtn.disabled = !view.canGoBack();
      fwdBtn.disabled = !view.canGoForward();
    }

    view.addEventListener('did-start-loading', () => {
      hideError();
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
      hideError();
      state.url = e.url;
      urlInput.value = e.url;
      syncNav();
      syncFav(); // 주소가 바뀌었으니 별 모양을 다시 맞춘다
      if (opts.onUrl) opts.onUrl(e.url);
    });
    view.addEventListener('did-navigate-in-page', (e) => {
      if (!e.isMainFrame) return;
      state.url = e.url;
      urlInput.value = e.url;
      syncFav();
      if (opts.onUrl) opts.onUrl(e.url);
    });
    view.addEventListener('page-title-updated', (e) => {
      state.title = e.title;
      if (opts.onTitle) opts.onTitle(e.title);
    });
    view.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // 사용자가 중단한 경우
      if (e.isMainFrame === false) return; // 페이지 안의 부속 요청 실패는 무시
      status.textContent = '';
      const desc = e.errorDescription || `오류 ${e.errorCode}`;
      // 인증서 계열(-200 대)은 본 프로세스가 확인 창을 띄우므로 그에 맞춰 안내한다
      const certish = e.errorCode <= -200 && e.errorCode > -300;
      showError(
        certish ? '이 사이트의 인증서를 확인할 수 없습니다' : '페이지를 열지 못했습니다',
        certish
          ? `${desc}\n확인 창에서 "위험을 감수하고 열기" 를 고르면 이 사이트를 열 수 있습니다.`
          : `${desc}\n${state.url || ''}`
      );
    });
    // 새 창(target=_blank)은 같은 판에서 연다
    view.addEventListener('new-window', (e) => {
      e.preventDefault();
      go(e.url);
    });

    if (state.url) {
      view.setAttribute('src', state.url);
      urlInput.value = state.url;
      showBrowser();
    } else {
      showStart();
    }

    return {
      el: root,
      get url() {
        return state.url;
      },
      get title() {
        return state.title;
      },
      go,
      focus: () => (start.classList.contains('hidden') ? urlInput.focus() : startInput.focus()),
      dispose: () => root.remove()
    };
  }

  return { create, toUrl };
})();
