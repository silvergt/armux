/*
 * 하단바 사용량 표시 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-usage.js
 *
 * 사용량이 안 뜨는 이유는 여러 가지다(로그인 안 됨 · 토큰 만료 · 권한 없음 · 접속 불가 ·
 * 팀 계정 · 조회 제한). 어떤 경우든 "왜" 가 화면에 남아야 한다 — 예전에는 아무것도
 * 안 보여서 서버에 문제가 있는지조차 알 수 없었다. 창이 좁아도 가려지면 안 된다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-usage-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};

// [이름, 하단바에 넣을 값, 화면에 보여야 할 말]
const CASES = [
  ['정상(막대 두 개)', { loggedIn: true, email: 'me@example.com', plan: 'Max', session: { pct: 12, resetsAt: null }, week: { pct: 40, resetsAt: null } }, null],
  ['팀 계정', { loggedIn: true, email: 't@team.com', plan: 'claude team', usageFailed: true, usageNote: '이 계정은 사용량을 알려 주지 않습니다 (팀·기업 계정)' }, '팀·기업'],
  ['토큰 만료', { loggedIn: true, email: 'x@y.z', usageFailed: true, usageNote: '토큰이 만료됐습니다 (claude 로그인 다시)' }, '만료'],
  ['접속 불가', { loggedIn: true, email: 'x@y.z', usageFailed: true, usageNote: 'api.anthropic.com 에 접속하지 못했습니다' }, '접속하지'],
  ['조회 제한', { loggedIn: true, email: 'x@y.z', usageFailed: true, rateLimited: true }, '제한'],
  ['로그인 안 됨(claude 는 있음)', { loggedIn: false, reason: 'no-credentials', dir: '/root/.claude' }, '로그인 필요'],
  ['조회 자체가 실패', { loggedIn: false, reason: 'probe-failed', probeError: '명령 실행 시간 초과' }, '조회 실패'],
  ['claude 자체가 없음', { loggedIn: false, reason: 'no-claude' }, null] // 숨겨야 한다
];

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1200, 700);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js('createLocalGroup(); true');
  await sleep(1500);

  const show = async (info) => {
    await js(`(() => { const g = activeGroup(); g.claudeInfo = ${JSON.stringify(info)}; g.codexInfo = null; renderClaudeStatus(); return true })()`);
    await sleep(200);
    return js("(() => { const b = el.statusClaude; return { hidden: b.classList.contains('hidden'), text: b.textContent.trim(), bars: b.querySelectorAll('.usage-track').length, noteShown: [...b.querySelectorAll('.usage-note')].some(n => getComputedStyle(n).display !== 'none') } })()");
  };

  for (const [name, info, must] of CASES) {
    const r = await show(info);
    if (name === 'claude 자체가 없음') {
      ok(name + ' → 숨긴다', r.hidden, JSON.stringify(r.text));
    } else if (must === null) {
      ok(name, !r.hidden && r.bars === 2, `막대 ${r.bars}개`);
    } else {
      ok(name, !r.hidden && r.text.includes(must) && r.noteShown, JSON.stringify(r.text.slice(0, 60)));
    }
  }

  // 창이 좁아도 이유가 가려지면 안 된다
  win.setSize(700, 600);
  await sleep(600);
  const narrow = await show({ loggedIn: true, email: 'x@y.z', usageFailed: true, usageNote: '토큰이 만료됐습니다 (claude 로그인 다시)' });
  ok('좁은 창에서도 이유가 보인다', narrow.noteShown && narrow.text.includes('만료'), JSON.stringify(narrow.text.slice(0, 60)));

  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
