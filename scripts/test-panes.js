/*
 * 분할한 판의 크기 맞춤과 드래그 선택 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-panes.js
 *
 * 크기 맞춤(fit)이 판을 누를 때마다 줄 수를 바꾸면 xterm 이 선택을 지워서,
 * 분할한 판에서는 드래그 복사가 아예 안 됐다. 그래서 두 가지를 같이 본다.
 *   1) 판이 화면에 꼭 맞는가 (아래로 삐져나가지 않고, 한 줄 넘게 남기지도 않는가)
 *   2) 누르고 끌면 글자가 선택되는가 (판이 몇 번째든)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-panes-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1300, 700);
  const js = (c) => win.webContents.executeJavaScript(c, true);

  await js('createLocalGroup(); true');
  await sleep(1500);
  // 판 3개 (좌우 분할 → 오른쪽을 위아래로 분할)
  for (const cmd of ['menu:split-vertical', 'menu:split-horizontal']) {
    win.webContents.send(cmd);
    await sleep(900);
    await js("document.getElementById('modal-backdrop').classList.add('hidden');true");
    await js("[...document.querySelectorAll('.launcher-list')].pop().children[0].click();true");
    await sleep(1500);
  }
  const n = await js('leavesOf(activeTab().root).length');
  ok('판 3개 생성', n === 3, `${n}개`);

  await js(`(() => { for (const l of leavesOf(activeTab().root)) if (l.sessionId) api.ssh.write(l.sessionId, 'clear; echo ABCDEFGHIJKLMNOP\\n'); return true })()`);
  await sleep(1200);

  /** 판이 세로로 꼭 맞는지: 삐져나가지 않고, 남는 공간이 한 줄 미만 */
  const fitReport = () =>
    js(`leavesOf(activeTab().root).map((l) => {
      const host = l.el.querySelector('.pane-term');
      const screen = l.el.querySelector('.xterm-screen');
      const cs = getComputedStyle(host);
      const avail = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const drawn = screen.getBoundingClientRect().height;
      return { rows: l.term.rows, cols: l.term.cols, over: +(drawn - avail).toFixed(1), cell: l.term._core._renderService.dimensions.css.cell.height };
    })`);

  const checkFit = async (label) => {
    const rep = await fitReport();
    const pass = rep.every((r) => r.over <= 0.5 && r.over > -r.cell - 0.5);
    ok(label, pass, rep.map((r) => `${r.cols}x${r.rows}(남음 ${-r.over}px)`).join(' · '));
  };
  await checkFit('처음 크기 맞춤');

  /** 판 i 에서 드래그해 선택되는지 + 그 사이 크기가 바뀌지 않는지 */
  const drag = async (i) => {
    await js(`window.__rs = 0; leavesOf(activeTab().root)[${i}].term.onResize(() => window.__rs++); true`);
    const p = await js(`(() => {
      const l = leavesOf(activeTab().root)[${i}];
      const el = l.el.querySelector('.xterm-screen');
      const r = el.getBoundingClientRect();
      const d = l.term._core._renderService.dimensions.css.cell;
      l.term.clearSelection();
      return { x1: Math.round(r.left + 4), y: Math.round(r.top + d.height * 0.5), x2: Math.round(r.left + d.width * 12) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x1, y: p.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x1, y: p.y, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 6; k++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x1 + ((p.x2 - p.x1) * k) / 6), y: p.y, button: 'left', buttons: 1 });
      await sleep(60);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x2, y: p.y, button: 'left', clickCount: 1 });
    await sleep(400);
    return {
      sel: await js(`leavesOf(activeTab().root)[${i}].term.getSelection()`),
      resizes: await js('window.__rs')
    };
  };

  for (let i = 0; i < 3; i++) {
    const r = await drag(i);
    ok(`판 ${i + 1} 드래그 선택`, r.sel.length >= 8, JSON.stringify(r.sel));
    ok(`판 ${i + 1} 누를 때 크기 안 바뀜`, r.resizes === 0, `크기 변경 ${r.resizes}회`);
  }

  // 창 크기를 바꾼 뒤에도 꼭 맞아야 한다
  win.setSize(1000, 560);
  await sleep(1200);
  await checkFit('창 크기 변경 후');
  const after = await drag(1);
  ok('창 크기 변경 후에도 드래그 선택', after.sel.length >= 8, JSON.stringify(after.sel));

  // 글자 크기를 바꾼 뒤에도 꼭 맞아야 한다
  await js('setFontSize(16); true');
  await sleep(1000);
  await checkFit('글자 크기 변경 후');
  await js('setFontSize(13); true');
  await sleep(800);

  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
