'use strict';

/*
 * 한글 입력 회귀 시험.   실행:  npx electron scripts/test-ime.js
 *
 * 여기는 두 번 깨진 자리다. 두 번 다 "고치려고 넣은 코드" 가 원인이었다.
 *   1차: 우리가 가로챈 ⌥←/⌘← 에 preventDefault 가 없어 브라우저가 xterm 의
 *        숨은 입력칸 캐럿을 옮겼다 → 옛 글자가 반복됐다("너너너").
 *   2차: 그걸 막겠다고 조합이 끝날 때마다 그 입력칸을 비웠더니, xterm 이
 *        나중에 잘라내 보낼 것이 사라져 글자가 통째로 씹혔다.
 *
 * 그래서 이 시험은 두 가지를 본다.
 *   A. 지금 코드로 한글을 치면 친 그대로 나가는가.
 *   B. 그 훅을 다시 넣으면 실제로 깨지는가 (시험이 살아 있는지 확인).
 *   C. renderer 에 입력칸을 건드리는 코드가 다시 들어오지 않았는가.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const DEL = String.fromCharCode(127);
const show = (s) => JSON.stringify(s).split(DEL).join('<DEL>').split('\\r').join('<CR>');

let failed = 0;
const check = (name, pass, note) => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '  — ' + note : ''}`);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600 });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const load = async () => {
    await win.loadFile(path.join(__dirname, 'ime-test', 'page.html'));
    await new Promise((r) => setTimeout(r, 700));
  };

  await load();
  const now = await js('__runAll(false)');
  await load(); // 훅은 한 번 달면 못 떼므로 새로 읽어서 훅을 단 채로
  const withHack = await js('__runAll(true)');

  console.log('— 지금 코드로 한글 치기 —');
  for (const [name, r] of Object.entries(now)) {
    check(name, r.got === r.want, r.got === r.want ? show(r.got) : `${show(r.got)} (기대 ${show(r.want)})`);
  }

  const broke = Object.values(withHack).filter((r) => r.got !== r.want).length;
  console.log('\n— 걷어낸 훅을 되돌리면 —');
  check('입력칸을 비우는 훅을 넣으면 글자가 씹힌다 (시험이 살아 있다)', broke > 0, `${broke}개 경우에서 깨짐`);

  console.log('\n— 코드에 훅이 다시 들어오지 않았는지 —');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  check('renderer 가 xterm 의 숨은 입력칸 값을 건드리지 않는다', !/textarea\s*\.\s*value\s*=/.test(src));
  check('renderer 에 compositionend 훅이 없다', !/compositionend/.test(src));
  check('가로챈 키에 preventDefault 가 걸려 있다', /const send = \(seq\) => \{[\s\S]{0,400}?e\.preventDefault\(\);/.test(src));
  check('조합키 + 이동키의 기본 동작을 막는 방어막이 있다', /NAV\.includes\(e\.key\)\) e\.preventDefault\(\)/.test(src));

  console.log(failed ? `\n실패 ${failed}건` : '\n전부 통과');
  app.exit(failed ? 1 : 0);
});
