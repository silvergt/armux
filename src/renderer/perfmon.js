'use strict';

/*
 * 성능 기록기 — "느려졌다" 를 증거로 바꾸는 장치.
 *
 * 느려지는 순간을 붙잡기가 어렵다. 그래서 평소에 아주 가벼운 지표만 계속 모아
 * 두고(최근 60초), 느려졌을 때 메뉴에서 "성능 기록 복사" 한 번이면 그 60초가
 * 그대로 나오게 한다.
 *
 * 모으는 것 (전부 이벤트 기반이라 평소 부담이 없다)
 *   - 입력→화면: 키를 눌러서 그 글자가 화면에 반영되기까지 (판별로)
 *   - 멈춤: 메인 스레드가 50ms 넘게 막힌 횟수와 길이 (PerformanceObserver)
 *   - 들어온 출력량: 초당 바이트·조각 수 (판별로)
 *   - 판 상태: 크기, GPU/CPU 그리기 여부
 *   - 메인 프로세스 CPU: 메인 쪽에서 2초마다 재 둔 것을 보고서 만들 때 가져온다
 *
 * 일부러 안 하는 것: 매 프레임 도는 감시(requestAnimationFrame 반복). 그 자체가
 * 화면을 계속 깨워서 배터리와 CPU 를 쓴다. 멈춤은 longtask 로 충분히 잡힌다.
 */
(function () {
  const WINDOW_SEC = 60;
  const leaves = new Map(); // leaf.id → 기록
  const seconds = []; // 초 단위 통계 (최근 WINDOW_SEC 개)
  let cur = newSecond(Math.floor(Date.now() / 1000));
  let longTotal = 0;
  let longCount = 0;
  let longMax = 0;

  function newSecond(t) {
    return { t, keys: 0, echo: [], bytes: 0, chunks: 0, longMs: 0, longN: 0, longMax: 0 };
  }

  function roll() {
    const t = Math.floor(Date.now() / 1000);
    if (t === cur.t) return;
    seconds.push(cur);
    while (seconds.length > WINDOW_SEC) seconds.shift();
    cur = newSecond(t);
  }

  try {
    new PerformanceObserver((list) => {
      roll();
      for (const e of list.getEntries()) {
        const d = Math.round(e.duration);
        cur.longMs += d;
        cur.longN += 1;
        if (d > cur.longMax) cur.longMax = d;
        longTotal += d;
        longCount += 1;
        if (d > longMax) longMax = d;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {
    /* 이 환경에서 longtask 를 못 재면 나머지 지표만 모은다 */
  }

  /** 판 하나를 기록 대상에 올린다 (판을 만들 때 부른다) */
  function watch(leaf) {
    if (!leaf || !leaf.term || leaves.has(leaf.id)) return;
    const rec = { leaf, keys: 0, echoSum: 0, echoN: 0, worst: 0 };
    leaves.set(leaf.id, rec);
    let pressedAt = null;
    leaf.term.onData(() => {
      roll();
      cur.keys += 1;
      rec.keys += 1;
      if (pressedAt == null) pressedAt = performance.now();
    });
    leaf.term.onWriteParsed(() => {
      if (pressedAt == null) return;
      const d = performance.now() - pressedAt;
      pressedAt = null;
      roll();
      cur.echo.push(d);
      rec.echoSum += d;
      rec.echoN += 1;
      if (d > rec.worst) rec.worst = d;
    });
  }

  /** 서버에서 글자가 들어왔다 (ssh:data 받는 곳에서 부른다) */
  function noteData(bytes) {
    roll();
    cur.chunks += 1;
    cur.bytes += bytes || 0;
  }

  const pct = (arr, q) => {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
  };

  /** 지금까지 모은 것을 사람이 읽는 글로 (메뉴에서 복사할 때 쓴다) */
  async function report() {
    roll();
    const rows = seconds.concat([cur]);
    const span = rows.length;
    const echo = [].concat(...rows.map((r) => r.echo));
    const keys = rows.reduce((n, r) => n + r.keys, 0);
    const bytes = rows.reduce((n, r) => n + r.bytes, 0);
    const chunks = rows.reduce((n, r) => n + r.chunks, 0);
    const lMs = rows.reduce((n, r) => n + r.longMs, 0);
    const lN = rows.reduce((n, r) => n + r.longN, 0);
    const lMax = rows.reduce((n, r) => Math.max(n, r.longMax), 0);

    const out = [];
    out.push(`[armux 성능 기록] ${new Date().toLocaleString('ko-KR')}`);
    out.push(`버전 ${(window.appInfo && appInfo.version) || '?'} · ${api.platform} · 화면배율 ${devicePixelRatio}`);
    out.push(`최근 ${span}초 · 친 글자 ${keys}개 · 들어온 출력 ${(bytes / 1024).toFixed(0)}KB / ${chunks}조각`);
    out.push(
      echo.length
        ? `입력→화면: 중앙 ${pct(echo, 0.5).toFixed(0)}ms · 상위10% ${pct(echo, 0.9).toFixed(0)}ms · 최대 ${Math.max(...echo).toFixed(0)}ms (${echo.length}회)`
        : '입력→화면: 이 동안 친 글자가 없습니다'
    );
    out.push(`화면 멈춤(50ms+): ${lN}회 · 합계 ${lMs}ms · 최대 ${lMax}ms   [앱 켠 뒤 누적 ${longCount}회/${longTotal}ms/최대 ${longMax}ms]`);

    // 메인 프로세스 쪽 CPU (2초마다 재 둔 것)
    try {
      const m = await api.win.perfMain();
      if (m && m.length) {
        const last = m[m.length - 1];
        const peak = m.reduce((a, b) => (b.total > a.total ? b : a), m[0]);
        out.push(`프로세스 CPU: 지금 ${last.parts} (합 ${last.total.toFixed(0)}%) · 최근 최고 ${peak.total.toFixed(0)}%`);
      }
    } catch (e) {
      /* 메인 쪽을 못 읽어도 나머지는 보여 준다 */
    }

    out.push('판별:');
    for (const [, rec] of leaves) {
      const l = rec.leaf;
      if (!l.el || !l.el.isConnected) continue;
      const g = state.groups.find((x) => x.id === l.groupId);
      const name = `${l.connect && l.connect.local ? '로컬' : (g && g.host && g.host.name) || 'SSH'}${l.title ? '·' + String(l.title).slice(0, 16) : ''}`;
      const avg = rec.echoN ? (rec.echoSum / rec.echoN).toFixed(0) + 'ms' : '-';
      out.push(
        `  ${name} ${l.term.cols}x${l.term.rows} ${l._webgl ? 'GPU' : 'CPU' + (l._webglLostAt ? '(GPU 잃음)' : '')}` +
          ` · ${l.mode}/${l.status} · 친글자 ${rec.keys} · 입력→화면 평균 ${avg} 최대 ${rec.worst ? rec.worst.toFixed(0) + 'ms' : '-'}`
      );
    }

    // 나빴던 순간 (멈춤이 길거나 입력→화면이 느렸던 초)
    const bad = rows
      .map((r) => ({ r, worst: Math.max(r.longMax, r.echo.length ? Math.max(...r.echo) : 0) }))
      .filter((x) => x.worst >= 50)
      .sort((a, b) => b.worst - a.worst)
      .slice(0, 8);
    if (bad.length) {
      out.push('나빴던 순간(초 단위):');
      for (const { r } of bad) {
        out.push(
          `  ${new Date(r.t * 1000).toLocaleTimeString('ko-KR')} · 멈춤 ${r.longN}회/${r.longMs}ms(최대 ${r.longMax}) · ` +
            `입력→화면 최대 ${r.echo.length ? Math.max(...r.echo).toFixed(0) : '-'}ms · 출력 ${(r.bytes / 1024).toFixed(0)}KB/${r.chunks}조각`
        );
      }
    }
    return out.join('\n');
  }

  window.armuxPerf = { watch, noteData, report };
})();
