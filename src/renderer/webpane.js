'use strict';

/**
 * 판(페인) 안에 뜨는 웹 브라우저 — 크롬처럼 탭을 여러 개 가진다.
 *
 * 구조(위에서 아래로): [탭 바] [주소창 툴바] [내용(webview 들 / 시작 화면 / 오류 화면)]
 *  - 탭마다 webview 를 하나씩 만들고, 활성 탭의 것만 보여 준다.
 *  - 링크의 새 창(target=_blank)은 크롬처럼 새 탭으로 연다.
 *  - 주소가 없는 탭은 시작 화면(주소 입력 + 즐겨찾기)을 보여 준다.
 *
 * 크롬의 로그인 세션(쿠키)까지 가져올 수는 없다. 크롬이 프로필을 암호화해
 * 잠가 두기 때문이다. 로그인은 이 창에서 따로 하거나 "크롬에서 열기" 를 쓴다.
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

  let nextTabId = 1;

  // webview 의 webContents id → 그 탭을 소유한 판의 newTab().
  // 본 프로세스가 "새 창 요청" 을 보내면 여기서 알맞은 판을 찾아 새 탭으로 연다.
  const wcRegistry = new Map();
  if (api.web.onOpenInNewTab) {
    api.web.onOpenInNewTab(({ viewId, url }) => {
      const open = wcRegistry.get(viewId);
      if (open) open(url);
    });
  }

  /**
   * @param {object} opts { url, urls, active, onTitle(title), onUrl(url) }
   */
  function create(opts) {
    const state = { tabs: [], active: -1 };

    const root = document.createElement('div');
    root.className = 'webpane';

    /* --------------------------------- 탭 바 --------------------------------- */

    const tabbar = document.createElement('div');
    tabbar.className = 'wt-bar';
    const tabsEl = document.createElement('div');
    tabsEl.className = 'wt-tabs';
    const addBtn = document.createElement('button');
    addBtn.className = 'wt-add';
    addBtn.textContent = '+';
    addBtn.title = '새 탭';
    addBtn.addEventListener('click', () => newTab(null));
    tabbar.append(tabsEl, addBtn);

    const cur = () => state.tabs[state.active] || null;

    function renderTabs() {
      tabsEl.innerHTML = '';
      state.tabs.forEach((t, i) => {
        const el = document.createElement('div');
        el.className = 'wt-tab' + (i === state.active ? ' active' : '');
        const label = document.createElement('span');
        label.className = 'wt-label';
        label.textContent = t.title || (t.url ? t.url.replace(/^https?:\/\//, '') : '새 탭');
        el.title = t.url || '새 탭';
        const close = document.createElement('span');
        close.className = 'wt-close';
        close.textContent = '✕';
        close.title = '탭 닫기';
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(i);
        });
        el.append(label, close);
        el.addEventListener('mousedown', (e) => {
          if (e.button === 1) return; // 휠 클릭은 아래 auxclick 에서 닫기로
          activateTab(i);
        });
        el.addEventListener('auxclick', (e) => {
          if (e.button === 1) closeTab(i); // 휠 클릭으로 닫기 (크롬과 동일)
        });
        tabsEl.appendChild(el);
      });
    }

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

    const backBtn = mk('←', '뒤로', () => {
      const t = cur();
      if (t && t.view.canGoBack()) t.view.goBack();
    });
    const fwdBtn = mk('→', '앞으로', () => {
      const t = cur();
      if (t && t.view.canGoForward()) t.view.goForward();
    });
    const reloadBtn = mk('⟳', '새로고침', () => {
      const t = cur();
      if (t) t.view.reload();
    });
    const homeBtn = mk('⌂ 홈', '시작 화면(주소 입력 + 즐겨찾기)', () => showStart());

    // 즐겨찾기 토글. 지금 페이지가 목록에 있으면 꽉 찬 별(★), 없으면 빈 별(☆).
    const favBtn = mk('☆', '이 페이지를 즐겨찾기에 추가', async () => {
      const t = cur();
      if (!t || !t.url) return;
      if (t.faved) await api.web.favRemove(t.url);
      else await api.web.favAdd({ name: t.title || t.url, url: t.url });
      await syncFav();
      renderFavs(); // 시작 화면 목록도 같이 갱신
    });

    /** 지금 주소가 즐겨찾기에 들어 있는지 확인해 별 모양을 맞춘다 */
    async function syncFav() {
      const t = cur();
      let list = [];
      try {
        list = (await api.web.favList()) || [];
      } catch (e) {
        list = [];
      }
      const faved = Boolean(t && t.url && list.some((f) => f.url === t.url));
      if (t) t.faved = faved;
      favBtn.textContent = faved ? '★' : '☆';
      favBtn.title = faved ? '즐겨찾기에서 빼기' : '이 페이지를 즐겨찾기에 추가';
      favBtn.classList.toggle('on', faved);
      favBtn.disabled = !(t && t.url);
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
        else urlInput.value = (cur() && cur().url) || '';
      }
    });
    urlInput.addEventListener('focus', () => urlInput.select());
    urlInput.addEventListener('blur', () => setTimeout(hideSuggest, 120));

    urlWrap.append(urlInput, sugg);

    const chromeBtn = mk('크롬에서 열기', '이 PC 의 기본 브라우저(크롬)로 열기 — 크롬 로그인/설정 그대로', () => {
      const t = cur();
      if (t && t.url) api.web.openExternal(t.url);
    });
    chromeBtn.classList.add('web-btn-wide');

    bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, favBtn, urlWrap, chromeBtn);

    /* -------------------------------- 내용 영역 -------------------------------- */

    const content = document.createElement('div');
    content.className = 'web-content';

    // 시작 화면(주소 입력 + 즐겨찾기). 주소가 없는 탭에서 보인다.
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
      let favs = [];
      try {
        favs = (await api.web.favList()) || [];
      } catch (e) {
        favs = [];
      }
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
          syncFav();
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
    retryBtn.addEventListener('click', () => {
      const t = cur();
      if (t && t.url) go(t.url);
    });
    const extBtn = document.createElement('button');
    extBtn.className = 'web-btn';
    extBtn.textContent = '크롬에서 열기';
    extBtn.addEventListener('click', () => {
      const t = cur();
      if (t && t.url) api.web.openExternal(t.url);
    });
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

    content.append(start, errBox);
    root.append(tabbar, bar, content, status);

    /* --------------------------------- 탭 관리 -------------------------------- */

    function newTab(url, background) {
      const t = { id: nextTabId++, url: url || null, title: '', faved: false, view: null };

      const view = document.createElement('webview');
      view.className = 'web-view hidden';
      view.setAttribute('src', url || 'about:blank');
      view.setAttribute('allowpopups', '');
      // 로그인 세션이 유지되도록 영구 파티션을 쓴다 (모든 탭이 공유 — 크롬과 동일)
      view.setAttribute('partition', 'persist:armux-web');
      view.setAttribute('useragent', api.web.userAgent());
      t.view = view;

      view.addEventListener('did-start-loading', () => {
        if (t === cur()) {
          hideError();
          status.textContent = '불러오는 중…';
          reloadBtn.textContent = '✕';
          reloadBtn.title = '중지';
        }
      });
      view.addEventListener('did-stop-loading', () => {
        if (t === cur()) {
          status.textContent = '';
          reloadBtn.textContent = '⟳';
          reloadBtn.title = '새로고침';
          syncNav();
        }
      });
      view.addEventListener('did-navigate', (e) => {
        if (e.url === 'about:blank') return; // 빈 탭의 초기 로드는 주소로 치지 않는다
        t.url = e.url;
        if (t === cur()) {
          hideError();
          urlInput.value = e.url;
          syncNav();
          syncFav();
          refresh();
          if (opts.onUrl) opts.onUrl(e.url);
        } else {
          renderTabs();
        }
      });
      view.addEventListener('did-navigate-in-page', (e) => {
        if (!e.isMainFrame || e.url === 'about:blank') return;
        t.url = e.url;
        if (t === cur()) {
          urlInput.value = e.url;
          syncFav();
          if (opts.onUrl) opts.onUrl(e.url);
        }
      });
      view.addEventListener('page-title-updated', (e) => {
        t.title = e.title;
        renderTabs();
        if (t === cur() && opts.onTitle) opts.onTitle(e.title);
      });
      view.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3) return; // 사용자가 중단한 경우
        if (e.isMainFrame === false) return; // 페이지 안의 부속 요청 실패는 무시
        if (t !== cur()) return;
        status.textContent = '';
        const desc = e.errorDescription || `오류 ${e.errorCode}`;
        // 인증서 계열(-200 대)은 본 프로세스가 확인 창을 띄우므로 그에 맞춰 안내한다
        const certish = e.errorCode <= -200 && e.errorCode > -300;
        showError(
          certish ? '이 사이트의 인증서를 확인할 수 없습니다' : '페이지를 열지 못했습니다',
          certish
            ? `${desc}\n확인 창에서 "위험을 감수하고 열기" 를 고르면 이 사이트를 열 수 있습니다.`
            : `${desc}\n${t.url || ''}`
        );
      });
      // 새 창(target=_blank)은 크롬처럼 새 탭으로 연다.
      // (최신 Electron 은 new-window 이벤트가 없어 본 프로세스가 신호를 보내 준다)
      // did-attach 가 환경에 따라 안 오는 경우가 있어 dom-ready 에서도 등록한다.
      const registerWc = () => {
        if (t.wcId) return;
        try {
          t.wcId = view.getWebContentsId();
          wcRegistry.set(t.wcId, (url) => newTab(url));
        } catch (e) {
          /* 아직 attach 전이면 다음 기회에 */
        }
      };
      view.addEventListener('did-attach', registerWc);
      view.addEventListener('dom-ready', registerWc);

      content.appendChild(view);
      state.tabs.push(t);
      if (!background) activateTab(state.tabs.length - 1);
      else renderTabs();
      return t;
    }

    function activateTab(i) {
      if (i < 0 || i >= state.tabs.length) return;
      state.active = i;
      const t = state.tabs[i];
      for (const other of state.tabs) other.view.classList.toggle('hidden', other !== t);
      hideError();
      // 주소 없는 탭이면 시작 화면
      start.classList.toggle('hidden', Boolean(t.url));
      urlInput.value = t.url || '';
      renderTabs();
      syncNav();
      syncFav();
      if (!t.url) {
        renderFavs();
        startInput.value = '';
        startInput.focus();
      }
      if (opts.onTitle) opts.onTitle(t.title || '웹페이지');
      if (opts.onUrl) opts.onUrl(t.url);
    }

    function closeTab(i) {
      const t = state.tabs[i];
      if (!t) return;
      if (t.wcId) wcRegistry.delete(t.wcId);
      try {
        t.view.remove();
      } catch (e) {
        /* noop */
      }
      state.tabs.splice(i, 1);
      if (!state.tabs.length) {
        // 마지막 탭을 닫으면 빈 탭 하나를 새로 연다 (판 자체는 유지)
        newTab(null);
        return;
      }
      activateTab(Math.min(i, state.tabs.length - 1));
    }

    /** 탭바만 다시 그리기 + 세션 저장 신호 */
    function refresh() {
      renderTabs();
    }

    /* --------------------------------- 동작 --------------------------------- */

    function showStart() {
      hideError();
      start.classList.remove('hidden');
      urlInput.value = '';
      renderFavs();
      startInput.value = '';
      startInput.focus();
      syncFav();
    }

    function go(input) {
      const url = toUrl(input);
      if (!url) return;
      let t = cur();
      if (!t) t = newTab(null);
      t.url = url;
      urlInput.value = url;
      start.classList.add('hidden');
      hideError();
      syncFav();
      t.view.loadURL(url).catch(() => {});
      renderTabs();
    }

    function syncNav() {
      const t = cur();
      backBtn.disabled = !(t && t.view.canGoBack && safeCanGoBack(t.view));
      fwdBtn.disabled = !(t && t.view.canGoForward && safeCanGoForward(t.view));
    }
    // webview 가 아직 attach 되기 전에 부르면 예외가 나므로 감싼다
    const safeCanGoBack = (v) => {
      try {
        return v.canGoBack();
      } catch (e) {
        return false;
      }
    };
    const safeCanGoForward = (v) => {
      try {
        return v.canGoForward();
      } catch (e) {
        return false;
      }
    };

    /* --------------------------------- 초기 탭 -------------------------------- */

    // 복원(urls) > 단일 url > 빈 탭
    const initUrls = Array.isArray(opts.urls) && opts.urls.length ? opts.urls : opts.url ? [opts.url] : [null];
    for (const u of initUrls) newTab(u, true);
    activateTab(Math.min(Math.max(0, opts.active || 0), state.tabs.length - 1));

    return {
      el: root,
      get url() {
        const t = cur();
        return t ? t.url : null;
      },
      get title() {
        const t = cur();
        return t ? t.title : '';
      },
      /** 세션 저장용: 모든 탭의 주소와 활성 탭 번호 */
      get tabsInfo() {
        return { urls: state.tabs.map((t) => t.url), active: state.active };
      },
      /** AI 컨텍스트용: 활성 탭 페이지의 본문 글자를 뽑아온다 */
      pageText: async () => {
        const t = cur();
        if (!t || !t.url) return '';
        try {
          const txt = await t.view.executeJavaScript('document.body ? document.body.innerText : ""');
          return String(txt || '').slice(0, 12000);
        } catch (e) {
          return '';
        }
      },
      go,
      newTab: (url) => newTab(url),
      focus: () => (start.classList.contains('hidden') ? urlInput.focus() : startInput.focus()),
      dispose: () => {
        for (const t of state.tabs) if (t.wcId) wcRegistry.delete(t.wcId);
        root.remove();
      }
    };
  }

  return { create, toUrl };
})();
