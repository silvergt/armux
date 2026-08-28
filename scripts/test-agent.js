/*
 * 실제 Claude 로 탭 표시를 검증한다 — `npm run test:agent`
 *
 * 왜 이 시험이 따로 있나
 * ----------------------
 * 표 시험(test-panestate)은 합성 입력으로 분류기만 검사한다. 그래서 세 가지를
 * 못 보고 지나쳤다: ESC 로 끊으면 Stop 훅이 안 오는 것, 도구를 돌릴 때 관찰기가
 * 자식 프로세스를 오판하는 것, Claude 업데이트로 상태줄 문구가 바뀐 것.
 * 이 시험은 진짜 Claude 를 tmux 안에서 띄우고, 도구를 쓰게 하고, ESC 로 끊고,
 * raiseAlert 가 언제 불리는지 추적한다. 판정기의 어느 층이 바뀌어도 여기서 걸린다.
 *
 * 필요한 것
 *   - 이 PC 에서 127.0.0.1:22 로 SSH 접속 (ARMUX_TEST_KEY 에 개인키 경로, 기본 ~/.ssh/id_ed25519)
 *   - 서버에 tmux, 로그인된 claude (토큰을 조금 쓴다)
 *   - claude 의 훅이 설치돼 있을 것 (앱이 접속하면서 심는다)
 *   - ARMUX_TEST_WRAP=script 를 주면 세션 녹화 서버처럼 녹화기 안에서 tmux 를 쓴다
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-agent-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const KEY = process.env.ARMUX_TEST_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
// ARMUX_TEST_WRAP=script 면 세션 녹화 서버처럼 "녹화기 → 셸 → tmux" 로 겹쳐서 돌린다
const WRAP = process.env.ARMUX_TEST_WRAP || '';
const USER = process.env.ARMUX_TEST_USER || os.userInfo().username;
const SESS = 'armux_test_agent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, c) => w.webContents.executeJavaScript(c, true);
const tq = (...a) => {
  try {
    return cp.execFileSync('tmux', a, { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
};
let bad = 0;
const ok = (n, p, note) => {
  if (!p) bad++;
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${note !== undefined ? '   [' + note + ']' : ''}`);
};

// 도구를 여러 번 쓰고, 본문에 "1. Yes" 같은 미끼 문구도 넣게 한다
const TOOL_PROMPT =
  "Your very first output must be exactly these four lines: 'Options:' then '1. Yes' then '2. No' then 'Do you want to proceed?'. " +
  'Then use the Bash tool to run `sleep 8`, then Bash `sleep 8` again, then Bash `ls /`. Finally write one sentence.';
const LONG_PROMPT = 'write 500 words about kimchi, slowly';

async function startClaude(t) {
  tq('send-keys', '-t', t, 'claude', 'Enter');
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const sc = tq('capture-pane', '-p', '-t', t);
    if (/trust this folder/.test(sc)) {
      // 기본 선택이 "No, exit" 일 수 있다 — 강조된 줄이 Yes 가 아니면 아래로
      const hl = sc.split('\n').find((l) => /❯/.test(l)) || '';
      if (!/Yes/.test(hl)) tq('send-keys', '-t', t, 'Down');
      await sleep(300);
      tq('send-keys', '-t', t, 'Enter');
      continue;
    }
    if (/Try "/.test(sc) && !/trust/.test(sc)) return true;
  }
  return false;
}
const ask = async (t, p) => {
  tq('send-keys', '-t', t, p);
  await sleep(1000);
  tq('send-keys', '-t', t, 'Enter');
};

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  const snap = () =>
    js(
      win,
      `(()=>{const l=activeLeaf();return{busy:!!l.busy,alert:!!l.alert,
      hooks:Object.keys(l.hookByPane).map(k=>k+'='+l.hookByPane[k]),
      panes:(l.probe&&l.probe.panes||[]).map(p=>({win:p.win,cmd:p.cmd,vis:p.visible,W:p.working,Z:p.idle}))}})()`
    );
  const waitFor = async (pred, secs) => {
    for (let i = 0; i < secs * 2; i++) {
      await sleep(500);
      if (pred(await snap())) return i / 2;
    }
    return -1;
  };
  const clear = () => js(win, `clearAlert(activeLeaf()); window.__alerts=[]; true`);
  try {
    tq('kill-session', '-t', SESS);
    tq('new-session', '-d', '-s', SESS, '-x', '100', '-y', '30', '-c', os.homedir());
    tq('new-window', '-d', '-t', `${SESS}:1`, '-c', os.homedir());
    await js(win, `document.getElementById('new-group-btn').click(); true`);
    await sleep(500);
    await js(
      win,
      `(()=>{const set=(i,v)=>{const e=document.getElementById(i);e.value=v;e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'));};
      set('f-host','127.0.0.1');set('f-port','22');set('f-user',${JSON.stringify(USER)});set('f-name','AGENT');set('f-auth','key');set('f-key',${JSON.stringify(KEY)});
      document.getElementById('modal-connect').click();return true})()`
    );
    await sleep(5000);
    ok('SSH 접속', await js(win, `activeLeaf().status==='ready'`));
    if (WRAP === 'script') {
      // 녹화기 흉내: 이 안에서 tmux 를 붙이면 tmux 클라이언트가 안쪽 pty 에 놓인다
      await js(win, `api.ssh.write(activeLeaf().sessionId,'script -q /dev/null'+String.fromCharCode(10)); true`);
      await sleep(2000);
      console.log('  (녹화기 script 안에서 진행)');
    }
    await js(win, `api.ssh.write(activeLeaf().sessionId,'tmux attach -t ${SESS}'+String.fromCharCode(10)); true`);
    ok('tmux 에 붙었다', (await waitFor((s) => s.panes.length >= 2, 15)) >= 0);
    // raiseAlert 호출을 전부 기록한다 — "언제·어디서" 느낌표가 올라가는지
    await js(
      win,
      `(()=>{ window.__alerts=[]; const orig=raiseAlert;
      raiseAlert=function(leaf,force,ni){ window.__alerts.push({t:Date.now(), force:!!force,
        st:new Error().stack.split('\\n').slice(2,4).map(s=>s.trim().replace(/^at /,'').replace(/\\(.*renderer\\.js:/,'(:')).join(' < ')});
        return orig.call(this,leaf,force,ni); }; return true })()`
    );

    console.log('\n■ 안 보이는 창에서 도구를 쓰는 작업 — 중간에 느낌표가 올라가면 안 된다');
    ok('claude 준비 (창1)', await startClaude(`${SESS}:1`));
    tq('select-window', '-t', `${SESS}:0`);
    await sleep(7000);
    await clear();
    const t0 = Date.now();
    await ask(`${SESS}:1`, TOOL_PROMPT);
    let sawZ = false;
    let sawW = false;
    let lostBusy = false;
    let firstBusyAt = -1;
    let done = -1;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const s = await snap();
      const p = s.panes.find((x) => x.win === '1') || {};
      if (p.Z) sawZ = true;
      if (p.W === true) sawW = true;
      if (s.busy && firstBusyAt < 0) firstBusyAt = i;
      if (firstBusyAt >= 0 && !s.busy && !s.hooks.includes(`${Object.keys(s.hooks)[0]}`) && !s.hooks.some((h) => h.endsWith('=idle'))) lostBusy = true;
      if (s.hooks.some((h) => h.endsWith('=idle'))) {
        done = i;
        break;
      }
    }
    const alerts = await js(win, `window.__alerts.map(a=>({t:a.t, force:a.force, st:a.st}))`);
    const early = alerts.filter((a) => done < 0 || a.t - t0 < done * 1000 - 1500);
    ok('작업 중 스피너가 켜진다', firstBusyAt >= 0, `${firstBusyAt}초`);
    ok('★ 도구가 돌 때 관찰기가 "대기(Z)" 로 오판하지 않는다', !sawZ);
    ok('★ 안 보이는 창의 상태줄을 관찰기가 읽는다 (W)', sawW);
    ok('★ 작업 중 스피너가 꺼졌다 켜지지 않는다', !lostBusy);
    ok('★ 작업 중(완료 전)에는 느낌표가 올라가지 않는다', early.length === 0, early.map((a) => `+${((a.t - t0) / 1000).toFixed(1)}s ${a.st}`).join(' / ') || '없음');
    ok('완료되면 느낌표', (await snap()).alert === true && done >= 0, `${done}초`);
    await clear();

    console.log('\n■ 보이는 창에서 ESC');
    tq('select-window', '-t', `${SESS}:1`);
    await sleep(3000);
    await clear();
    await ask(`${SESS}:1`, LONG_PROMPT);
    t = await waitFor((s) => s.busy, 10);
    ok('작업 중 스피너', t >= 0, `${t}초`);
    await sleep(3000);
    // ESC 는 우리 앱을 거쳐야 한다 (tmux 로 직접 보내면 앱이 볼 수 없다) — 진짜 키처럼 xterm 에 넣는다
    await js(win, `activeLeaf().term.input(String.fromCharCode(27)); true`);
    t = await waitFor((s) => !s.busy, 15);
    ok('★ ESC 뒤 스피너가 꺼진다 (Stop 훅 없이)', t >= 0, t >= 0 ? `${t}초 만에` : '안 꺼짐');
    ok('   낡은 busy 훅이 지워졌다', !(await snap()).hooks.some((h) => h.endsWith('=busy')));
    ok('   보고 있었으니 느낌표 없음', (await snap()).alert === false);
    // 끊은 뒤 Claude 가 정말 멈췄는지 (다시 busy 로 돌아오면 안 된다)
    await sleep(6000);
    ok('   끊은 뒤 스피너가 다시 켜지지 않는다', (await snap()).busy === false);
  } catch (e) {
    bad++;
    console.log('EXCEPTION', e && e.stack);
  } finally {
    tq('send-keys', '-t', `${SESS}:1`, '/quit', 'Enter');
    await sleep(1000);
    tq('kill-session', '-t', SESS);
    console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
    setTimeout(() => app.exit(bad ? 1 : 0), 300);
  }
});
