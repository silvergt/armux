/*
 * HTML 파일 "웹으로 보기" 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/test-htmlpreview.js
 *
 * 뷰어에서 HTML 을 열면 코드만 보인다. 버튼 하나로 "그려진 쪽" 을 볼 수 있어야 한다.
 *   - armux 안의 웹 판으로 열기 (파일 판 오른쪽에 붙는다)
 *   - 이 PC 의 기본 브라우저로 열기
 * 로컬 파일은 원본을 그대로 열어 옆에 있는 css·이미지까지 살아 있어야 한다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-htmlprev-')));
dialog.showMessageBox = async () => ({ response: 1 });
const opened = [];
shell.openExternal = async (u) => { opened.push(u); };
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};
const FILE = '/tmp/armux-htmltest/page.html';

app.whenReady().then(async () => {
  await sleep(1700);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1300, 760);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  win.webContents.on('console-message', (e) => { const m = e && e.message !== undefined ? e.message : ''; if (m) console.log('[화면]', String(m).slice(0, 200)); });
  const step = (n) => console.log('…', n);
  await js('createLocalGroup(); true');
  await sleep(1600);

  step('파일 열기 시작');
  // 로컬 파일 탐색기의 sftp 세션을 열고, 그 파일을 뷰어로 연다
  const open = await js(`(async () => {
    const g = activeGroup();
    const res = await api.sftp.open({ local: true });
    window.__sftpId = res.sftpId; // 탐색기 객체를 흉내 내지 않고 id 만 넘긴다
    await openFileInPane(g, { name: 'page.html', path: ${JSON.stringify(FILE)} }, () => res.sftpId, activeLeaf());
    return true;
  })()`);
  step('파일 열기 호출 끝');
  await sleep(1800);
  const leafInfo = await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file'); return l ? { has: true, title: l.title } : { has: false } })()`);
  ok('HTML 파일이 뷰어로 열린다', leafInfo.has, JSON.stringify(leafInfo));

  const buttons = await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    return [...l.el.querySelectorAll('.fv-tools .fv-btn')].map(b => b.textContent.trim()) })()`);
  ok('"웹으로 보기" 버튼이 있다', buttons.includes('웹으로 보기'), JSON.stringify(buttons));
  ok('"브라우저" 버튼이 있다', buttons.includes('브라우저'), JSON.stringify(buttons));

  // 1) armux 안의 웹 판으로
  await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    [...l.el.querySelectorAll('.fv-tools .fv-btn')].find(b => b.textContent.trim() === '웹으로 보기').click(); return true })()`);
  await sleep(2500);
  const web = await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'web');
    return l ? { has: true, title: l.title } : { has: false } })()`);
  ok('웹 판이 열린다', web.has, JSON.stringify(web));

  const rendered = await js(`(async () => {
    const l = leavesOf(activeTab().root).find(x => x.mode === 'web');
    const v = l && l.el.querySelector('webview');
    if (!v) return { err: 'webview 없음' };
    for (let i = 0; i < 30 && !v.getURL(); i++) await new Promise(r => setTimeout(r, 200));
    try {
      const out = await v.executeJavaScript("JSON.stringify({ h: document.getElementById('h') && document.getElementById('h').textContent, bg: getComputedStyle(document.body).backgroundColor, color: document.querySelector('.p') && getComputedStyle(document.querySelector('.p')).color, ok: document.getElementById('h') && document.getElementById('h').dataset.ok })");
      return { url: v.getURL(), ...JSON.parse(out) };
    } catch (e) { return { err: String(e && e.message || e), url: v.getURL() } }
  })()`);
  ok('쪽이 실제로 그려진다 (코드가 아니라)', rendered.h === '웹으로 보기 테스트', JSON.stringify(rendered).slice(0, 160));
  ok('스크립트가 돈다', rendered.ok === '1', `data-ok=${rendered.ok}`);
  ok('옆에 있는 css 도 같이 불러온다', rendered.color === 'rgb(0, 170, 119)', `글자색 ${rendered.color}`);
  ok('로컬 파일은 원본을 연다', String(rendered.url || '').endsWith('/tmp/armux-htmltest/page.html'), rendered.url);

  // 같은 파일을 또 눌러도 판이 늘어나지 않는다
  await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    [...l.el.querySelectorAll('.fv-tools .fv-btn')].find(b => b.textContent.trim() === '웹으로 보기').click(); return true })()`);
  await sleep(1500);
  ok('다시 눌러도 판이 늘어나지 않는다', (await js(`leavesOf(activeTab().root).filter(l => l.mode === 'web').length`)) === 1,
    `웹 판 ${await js(`leavesOf(activeTab().root).filter(l => l.mode === 'web').length`)}개`);

  // 2) 바깥 브라우저로
  opened.length = 0;
  await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    [...l.el.querySelectorAll('.fv-tools .fv-btn')].find(b => b.textContent.trim() === '브라우저').click(); return true })()`);
  await sleep(1500);
  ok('브라우저로 열기가 동작한다', opened.length === 1 && opened[0].startsWith('file://'), JSON.stringify(opened));

  // 3) 저장하지 않은 수정이 있으면 "지금 내용" 으로 연다 (원본에는 그 내용이 없다)
  await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    const ta = l.el.querySelector('.fv-hledit textarea') || l.el.querySelector('textarea');
    ta.value = ta.value.replace('웹으로 보기 테스트', '고치는 중입니다');
    ta.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
  await sleep(300);
  console.log('… 수정 상태:', await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    const ta = l.el.querySelector('.fv-hledit textarea') || l.el.querySelector('textarea');
    return JSON.stringify({ dirty: l.file.isDirty(), hasEdit: ta.value.includes('고치는 중입니다') }) })()`));
  await js(`(() => { const l = leavesOf(activeTab().root).find(x => x.mode === 'file');
    [...l.el.querySelectorAll('.fv-tools .fv-btn')].find(b => b.textContent.trim() === '웹으로 보기').click(); return true })()`);
  await sleep(2500);
  const edited = await js(`(async () => {
    const l = leavesOf(activeTab().root).find(x => x.mode === 'web');
    const v = l && l.el.querySelector('webview');
    for (let i = 0; i < 30 && (!v || !v.getURL()); i++) await new Promise(r => setTimeout(r, 200));
    const out = await v.executeJavaScript("document.body.innerText.slice(0,40)");
    return { url: v.getURL(), text: out };
  })()`);
  ok('저장 안 한 수정이 화면에 반영된다', edited.text.includes('고치는 중입니다'), JSON.stringify(edited).slice(0, 140));
  ok('그때는 임시 파일로 연다', edited.url.includes('armux-html-preview'), edited.url);

  // 4) 원격 파일(로컬이 아닌 세션)은 지금 내용을 임시 파일로
  const remote = await js(`api.preview.html({ sftpId: 'no-such-session', filePath: '/srv/app/index.html', name: 'index.html', content: '<h1>원격</h1>' })`);
  ok('원격 파일은 임시 파일로 연다', remote && remote.url.includes('armux-html-preview') && remote.original === false, JSON.stringify(remote));

  // 5) html 이 아닌 파일에는 버튼이 없어야 한다
  await js(`(async () => { const g = activeGroup(); const id = window.__sftpId;
    await openFileInPane(g, { name: 'style.css', path: '/tmp/armux-htmltest/style.css' }, () => id, activeLeaf()); return true })()`);
  await sleep(1600);
  const cssButtons = await js(`(() => { const ls = leavesOf(activeTab().root).filter(x => x.mode === 'file');
    const l = ls[ls.length - 1]; return [...l.el.querySelectorAll('.fv-tools .fv-btn')].map(b => b.textContent.trim()) })()`);
  ok('HTML 이 아닌 파일에는 버튼이 없다', !cssButtons.includes('웹으로 보기'), JSON.stringify(cssButtons));

  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
