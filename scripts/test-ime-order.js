/*
 * 한글(IME) 조합 직후에 커서 이동 키를 눌렀을 때의 "순서" 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-ime-order.js
 *
 * xterm 은 조합이 끝나면 글자를 곧바로 보내지 않고 0밀리초 뒤에 보낸다.
 * 그 사이에 우리가 ⌥←(한 단어 뒤로) 같은 신호를 먼저 보내 버리면, 방금 친 단어가
 * 커서가 옮겨 간 자리에 가서 붙는다 — 맥에서 "단어가 순간이동" 하던 문제.
 *
 * 그래서 셸에 `cat -v` 를 띄워 놓고, 도착한 차례를 그대로 읽어 확인한다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-imeorder-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};

// [이름, 조합해서 친 글자, 누른 키, 그 키가 보내는 신호(cat -v 표기)]
const CASES = [
  ['⌥← (한 단어 뒤로)', 'abc', { key: 'ArrowLeft', altKey: true }, '^[b'],
  ['⌥→ (한 단어 앞으로)', 'abc', { key: 'ArrowRight', altKey: true }, '^[f'],
  ['Ctrl/⌘+↑ (PageUp)', 'abc', { key: 'ArrowUp', ctrlKey: true }, '^[[5~'],
  ['한글 조합 + ⌥←', '한글', { key: 'ArrowLeft', altKey: true }, '^[b']
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

  for (const [name, text, key, seq] of CASES) {
    /*
     * 맥 IME 가 하는 일을 그대로 흉내 낸다.
     *   조합 시작 → 입력칸에 글자가 들어감 → 조합 끝(=xterm 이 0ms 뒤 전송 예약)
     *   → 곧바로 방향키 누름
     */
    await js(`(() => {
      const t = activeLeaf().term;
      const ta = t.textarea;
      t.focus();
      ta.value = '';
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ${JSON.stringify(text)}, bubbles: true }));
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: ${JSON.stringify(text)}, bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(key)})));
      return true;
    })()`);
    await sleep(600);

    const line = await js(`(() => {
      const b = activeLeaf().term.buffer.active;
      const l = b.getLine(b.cursorY);
      return l ? l.translateToString(true).trim() : '';
    })()`);
    await js("api.ssh.write(activeLeaf().sessionId, '\\n'); true");
    await sleep(250);

    // 친 글자가 먼저, 이동 신호가 그다음이어야 한다
    // cat -v 는 한글을 그대로 찍기도 하고 바이트 표기(M-…)로 찍기도 한다 — 둘 다 받아 준다
    const iText = line.indexOf(text) >= 0 ? line.indexOf(text) : line.indexOf('M-');
    const iSeq = line.indexOf(seq);
    const pass = iText >= 0 && iSeq >= 0 && iText < iSeq;
    ok(name, pass, `셸이 받은 차례: ${JSON.stringify(line)}`);
  }

  await js("api.ssh.write(activeLeaf().sessionId, '\\x03'); true");
  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'} (${CASES.length}건)`);
  setTimeout(() => app.exit(bad ? 1 : 0), 300);
});
