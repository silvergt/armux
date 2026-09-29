/*
 * 터미널로 나가는 키 신호 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-keys.js
 *
 * `cat -v` 를 띄워 놓고 키를 눌러, 셸에 실제로 도착한 바이트를 눈에 보이는 꼴로 읽는다.
 * (리눅스·윈도우는 Ctrl, 맥은 ⌘ 가 같은 자리다 — hasMod 가 갈라 준다. 여기서는
 *  리눅스로 돌리므로 Ctrl 쪽을 확인한다)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-keys-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};

// [이름, 키, 조합키, 기대하는 바이트(cat -v 표기)]
const CASES = [
  ['Ctrl+↑ = PageUp', 'Up', ['control'], '^[[5~'],
  ['Ctrl+↓ = PageDown', 'Down', ['control'], '^[[6~'],
  ['PageUp 키 자체', 'PageUp', [], '^[[5~'],
  ['PageDown 키 자체', 'PageDown', [], '^[[6~'],
  ['그냥 ↑ (히스토리)', 'Up', [], '^[[A'],
  ['그냥 ↓', 'Down', [], '^[[B'],
  ['Alt+← (한 단어 뒤로)', 'Left', ['alt'], '^[b'],
  ['Alt+→ (한 단어 앞으로)', 'Right', ['alt'], '^[f'],
  ['Shift+↑ (그대로)', 'Up', ['shift'], '^[[1;2A'],
  ['Ctrl+Alt+↑ (판 이동 — 터미널로 안 감)', 'Up', ['control', 'alt'], '']
];

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1000, 500);
  const js = (c) => win.webContents.executeJavaScript(c, true);

  await js('createLocalGroup(); true');
  await sleep(1500);
  await js("api.ssh.write(activeLeaf().sessionId, 'clear; cat -v\\n'); true");
  await sleep(900);

  for (const [name, keyCode, modifiers, want] of CASES) {
    await js('activeLeaf().term.focus(); true');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(350);
    const got = await js(`(() => {
      const b = activeLeaf().term.buffer.active;
      const l = b.getLine(b.cursorY);
      return l ? l.translateToString(true).trim() : '';
    })()`);
    await js("api.ssh.write(activeLeaf().sessionId, '\\n'); true");
    await sleep(200);
    ok(name, got === want, `받은 것 ${JSON.stringify(got)}${got === want ? '' : ' / 기대 ' + JSON.stringify(want)}`);
  }

  await js("api.ssh.write(activeLeaf().sessionId, '\\x03'); true");
  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'} (${CASES.length}건)`);
  setTimeout(() => app.exit(bad ? 1 : 0), 300);
});
