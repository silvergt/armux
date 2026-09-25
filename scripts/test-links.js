/*
 * 터미널 줄에서 링크를 제대로 잡는지 검사한다.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-links.js
 *
 * 특히 이모지처럼 자바스크립트 문자열에서 두 자리를 차지하는 글자가 앞에 있으면
 * 링크 위치가 밀려 통째로 사라지던 문제(🐊 … https://…)를 막는다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-links-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = 'https://claude.ai/code/artifact/6355d552-8e29-49ee-85d5-ed66a5ebd68d';
const SHORT = 'https://example.com/a';

// [이름, 화면에 그릴 줄, 기대하는 링크들]
const CASES = [
  ['URL 만', U, [U]],
  ['⧉ 기호 뒤', `⧉ ${U}`, [U]],
  ['이모지 뒤', `🐊 ${U}`, [U]],
  ['이모지+한글+기호', `🐊 caiman 리서치 플로우 — ⧉ ${U}`, [U]],
  ['이모지 여러 개', `🐊🚀✅ ${U}`, [U]],
  ['한글 뒤', `리서치 플로우 ${U}`, [U]],
  ['이모지 사이 두 개', `🐊 ${SHORT} 그리고 🚀 ${SHORT}`, [SHORT, SHORT]],
  ['괄호 안', `🐊 (${SHORT})`, [SHORT]],
  ['링크 없음', '🐊 caiman 리서치 플로우 — 링크는 없다', []]
];

// 실제 Claude 로그인 URL (프로그램이 제 폭대로 잘라 여러 줄에 그린다)
const LONG =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code' +
  '+user%3Amcp_servers+user%3Afile_upload&code_challenge=vwdrL_W24uZr11epDGJn21OZSv2gDvj_rex620xdypA' +
  '&code_challenge_method=S256&state=S3TV0Fyc27K407UZdFY5wrI3dKFq7qZKPl8mdPnc-KI';

const chunks = (s, w) => {
  const out = [];
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
  return out;
};

let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1400, 600);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js('createLocalGroup(); true');
  await sleep(1600);

  for (const [name, line, want] of CASES) {
    await js(`api.ssh.write(activeLeaf().sessionId, ${JSON.stringify(`clear; printf '%s\\n' ${JSON.stringify(line)}\r`)}); true`);
    await sleep(800);
    const got = await js(`new Promise((res) => {
      const t = activeLeaf().term, b = t.buffer.active;
      // 화면에 그려진 줄(명령을 되비추는 줄이 아니라 마지막에 출력된 줄)을 찾는다
      let row = -1;
      for (let i = b.length - 1; i >= 0; i--) {
        const s = b.getLine(i) && b.getLine(i).translateToString(true);
        if (!s) continue;
        if (s.includes('printf')) continue; // 명령 줄은 건너뛴다
        if (s.includes('http') || s.includes('링크는 없다')) { row = i; break }
      }
      if (row < 0) return res({ error: '줄을 못 찾음' });
      makeUrlLinkProvider(t, () => {}).provideLinks(row - b.viewportY + 1, (links) => {
        const t2 = t.buffer.active;
        res({
          links: (links || []).map((l) => ({
            text: l.text,
            // 링크 시작 칸에 정말 그 URL 의 첫 글자가 있는지 (위치가 밀리지 않았는지)
            atStart: (t2.getLine(l.range.start.y - 1).getCell(l.range.start.x - 1) || {}).getChars
              ? t2.getLine(l.range.start.y - 1).getCell(l.range.start.x - 1).getChars()
              : '',
            atEnd: (t2.getLine(l.range.end.y - 1).getCell(l.range.end.x - 1) || {}).getChars
              ? t2.getLine(l.range.end.y - 1).getCell(l.range.end.x - 1).getChars()
              : ''
          }))
        });
      });
    })`);
    if (got.error) {
      ok(name, false, got.error);
      continue;
    }
    const texts = got.links.map((l) => l.text);
    const same = texts.length === want.length && texts.every((t, i) => t === want[i]);
    const posOk = got.links.every((l) => l.atStart === 'h' && l.atEnd === l.text[l.text.length - 1]);
    ok(name, same && posOk, same ? (posOk ? `${texts.length}개` : '위치가 밀림: ' + JSON.stringify(got.links[0])) : JSON.stringify(texts));
  }

  /*
   * 긴 URL — tmux 나 TUI 는 제 폭대로 URL 을 잘라 여러 줄에 그린다.
   * 어느 줄을 눌러도 전체 주소가 나와야 한다(마지막 꼬리 줄을 빼먹지 않는지).
   */
  let longBad = 0;
  for (const w of [110, 98, 90, 74, 60, 47]) {
    const parts = chunks(LONG, w);
    const cmd = `clear; printf '%s\\n' ${parts.map((c) => JSON.stringify(c)).join(' ')}\r`;
    await js(`api.ssh.write(activeLeaf().sessionId, ${JSON.stringify(cmd)}); true`);
    await sleep(900);
    const lens = await js(`new Promise(async (res) => {
      const t = activeLeaf().term, b = t.buffer.active;
      const rows = [];
      for (let i = 0; i < b.length; i++) {
        const s = b.getLine(i) && b.getLine(i).translateToString(true);
        const v = s ? s.trim() : '';
        // URL 조각 줄만: 공백·프롬프트(@, #) 가 없고 URL 글자로만 된 줄
        if (v.length >= 4 && !v.includes('printf') && /^[A-Za-z0-9%&=?:/._~+-]+$/.test(v)) rows.push(i);
      }
      const ask = (row) => new Promise((r2) =>
        makeUrlLinkProvider(t, () => {}).provideLinks(row - b.viewportY + 1, (ls) => r2(ls && ls.length ? ls[0].text.length : 0)));
      const out = [];
      for (const r of rows) out.push(await ask(r));
      res(out);
    })`);
    const allFull = lens.length >= parts.length && lens.every((n) => n === LONG.length);
    if (!allFull) longBad++;
    ok(`긴 URL — ${w}칸씩 ${parts.length}줄`, allFull, allFull ? `${parts.length}줄 모두 ${LONG.length}자` : `줄별 길이 ${JSON.stringify(lens)} (기대 ${LONG.length})`);
  }

  // 링크 블록 바로 뒤에 다른 줄이 붙어 있어도 그것까지 링크에 넣으면 안 된다
  {
    const parts = chunks(LONG, 60);
    const cmd = `clear; printf '%s\\n' ${parts.map((c) => JSON.stringify(c)).join(' ')} ${JSON.stringify('done')}\r`;
    await js(`api.ssh.write(activeLeaf().sessionId, ${JSON.stringify(cmd)}); true`);
    await sleep(900);
    const len = await js(`new Promise((res) => {
      const t = activeLeaf().term, b = t.buffer.active;
      let row = -1;
      for (let i = 0; i < b.length; i++) { const s = b.getLine(i) && b.getLine(i).translateToString(true); if (s && s.includes('claude.com/cai')) { row = i; break } }
      makeUrlLinkProvider(t, () => {}).provideLinks(row - b.viewportY + 1, (ls) => res(ls && ls.length ? ls[0].text : ''));
    })`);
    ok('링크 뒤의 다른 줄은 안 붙인다', len === LONG, len === LONG ? `${len.length}자` : `끝부분 ${JSON.stringify(String(len).slice(-24))}`);
  }

  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
