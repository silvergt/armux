/*
 * 파일 드래그 안내("여기에 놓으면 서버로 올라갑니다") 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-filedrop.js
 *
 * 파일을 끌고 들어오면 파란 안내가 떠야 하고, 끌고 나가거나 손을 놓으면 사라져야 한다.
 * 브라우저는 자식 요소(터미널 글자 영역) 사이를 옮겨 다닐 때도 dragleave 를 주고,
 * 창 밖에서 손을 놓으면 아무 이벤트도 오지 않기도 한다 — 그래서 끝나는 길마다 본다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-drop-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};

// 파일을 끌고 있는 것처럼 보이는 이벤트를 만든다
const FIRE = (type, targetExpr, relatedExpr) => `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'a.txt', { type: 'text/plain' }));
  const ev = new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget: ${relatedExpr || 'null'} });
  (${targetExpr}).dispatchEvent(ev);
  return true;
})()`;

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1200, 700);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js('createLocalGroup(); true');
  await sleep(1700);

  const pane = "activeLeaf().el";
  const child = "(activeLeaf().el.querySelector('.xterm-screen') || activeLeaf().el.querySelector('.pane-term'))";
  const shown = () => js("document.querySelectorAll('.file-drop').length");

  // 1) 끌고 들어오면 안내가 뜬다
  await js(FIRE('dragover', pane));
  await sleep(150);
  ok('파일을 끌고 오면 안내가 뜬다', (await shown()) === 1, `표시 ${await shown()}개`);

  // 2) 글자 영역(자식) 위로 옮겨도 그대로 떠 있어야 한다
  await js(FIRE('dragleave', child, child + '.firstElementChild || ' + pane));
  await js(FIRE('dragover', child));
  await sleep(150);
  ok('판 안에서 움직이는 동안에는 유지된다', (await shown()) === 1, `표시 ${await shown()}개`);

  // 3) 글자 영역 위에서 판 밖으로 빠져나가면 사라진다 (이번에 고친 버그)
  await js(FIRE('dragleave', child, 'document.getElementById("statusbar")'));
  await sleep(200);
  ok('자식 요소 위에서 밖으로 나가면 사라진다', (await shown()) === 0, `표시 ${await shown()}개`);

  // 4) 창 밖으로 끌고 나가는 경우 (relatedTarget 이 없다)
  await js(FIRE('dragover', pane));
  await sleep(100);
  await js(FIRE('dragleave', 'document'));
  await sleep(200);
  ok('창 밖으로 나가면 사라진다', (await shown()) === 0, `표시 ${await shown()}개`);

  // 5) 아무 이벤트도 못 받고 드래그가 끝난 경우 — 감시가 치운다
  await js(FIRE('dragover', pane));
  await sleep(100);
  ok('(준비) 안내가 떠 있다', (await shown()) === 1);
  await sleep(900); // dragover 가 끊기면 0.4초 뒤 정리된다
  ok('이벤트가 끊겨도 저절로 사라진다', (await shown()) === 0, `표시 ${await shown()}개`);

  // 6) 놓으면 사라진다
  await js(FIRE('dragover', pane));
  await sleep(100);
  await js(FIRE('drop', pane));
  await sleep(300);
  ok('놓으면 사라진다', (await shown()) === 0, `표시 ${await shown()}개`);

  // 7) 창이 다른 데로 넘어가도 사라진다
  await js(FIRE('dragover', pane));
  await sleep(100);
  await js("window.dispatchEvent(new Event('blur')); true");
  await sleep(200);
  ok('창에서 포커스가 빠지면 사라진다', (await shown()) === 0, `표시 ${await shown()}개`);

  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
