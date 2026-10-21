/*
 * 글자 그리기(GPU 캐시) 안전장치 검사.
 *
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox \
 *     --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader scripts/test-glyphs.js
 *
 * 그래픽 드라이버가 글자 캐시를 망가뜨리면 글자가 빠지거나 엉뚱한 조각이 섞인다.
 * 깨졌다는 사실은 프로그램이 알 수 없으므로 (1) 깨질 만한 순간마다 알아서 다시 만들고
 * (2) 사람이 메뉴로 고칠 수 있고 (3) 아예 GPU 를 안 쓰는 선택지를 둔다 — 이 셋을 본다.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-glyphs-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (name, pass, note) => {
  if (!pass) bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note !== undefined ? '   [' + note + ']' : ''}`);
};
const SAMPLE = '가나다라마바사아자차카타파하 한글 ABC 123\r\n';

app.whenReady().then(async () => {
  await sleep(1800);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1100, 560);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js('createLocalGroup(); true');
  await sleep(1800);
  await js(`activeLeaf().term.write(${JSON.stringify(SAMPLE)}); true`);
  await sleep(600);

  const gpu = await js('!!activeLeaf()._webgl');
  if (!gpu) {
    // GPU 가 없는 환경(헤드리스·원격 데스크톱 등)에서는 GPU 관련 검사를 건너뛴다.
    // 그래도 "복구가 안전하게 동작하는지" 는 그대로 본다.
    console.log('SKIP  이 환경에는 WebGL 이 없습니다 — GPU 관련 검사는 건너뜁니다');
  } else {
    ok('판이 GPU 로 그려진다', true, 'WebGL ON');
  }

  // 1) 수동 복구
  await js('redrawGlyphs(); true');
  await sleep(500);
  ok('메뉴 복구가 동작한다', /다시 그렸습니다/.test(await js('el.statusLeft.textContent')), await js('el.statusLeft.textContent'));
  ok('복구해도 화면 내용이 남는다', await js(`(()=>{const b=activeLeaf().term.buffer.active;let s='';for(let i=0;i<b.length;i++){const l=b.getLine(i);if(l)s+=l.translateToString(true)}return s.includes('가나다라마바사')})()`));

  // 2) 자동 복구 — 메인이 보내는 신호
  const before = await js('el.statusLeft.textContent');
  await js(`window.__cleared=0; const o=redrawGlyphs; window.redrawGlyphs=function(q){window.__cleared++; return o.apply(this,arguments)}; true`);
  BrowserWindow.getAllWindows()[0].webContents.send('ui:glyphsStale', { why: '시험' });
  await sleep(600);
  ok('절전 복귀·GPU 재시작 신호를 받으면 알아서 다시 만든다', (await js('window.__cleared')) >= 1, `호출 ${await js('window.__cleared')}회`);
  ok('자동 복구는 상태줄을 바꾸지 않는다', (await js('el.statusLeft.textContent')) === before);

  // 3) 설정으로 GPU 끄기/켜기
  await js(`setPref('gpuRender', false); true`);
  await sleep(700);
  if (gpu) ok('설정을 끄면 모든 판이 GPU 를 놓는다', await js(`leavesOf(activeTab().root).every(l=>!l._webgl && !l._webglAddon)`));
  ok('꺼도 화면 내용은 그대로다', await js(`(()=>{const b=activeLeaf().term.buffer.active;let s='';for(let i=0;i<b.length;i++){const l=b.getLine(i);if(l)s+=l.translateToString(true)}return s.includes('가나다라마바사')})()`));
  // 끈 상태에서 새로 만든 판도 GPU 를 쓰지 않아야 한다
  win.webContents.send('menu:split-vertical');
  await sleep(900);
  await js("document.getElementById('modal-backdrop').classList.add('hidden');true");
  await js("[...document.querySelectorAll('.launcher-list')].pop().children[0].click();true");
  await sleep(1600);
  ok('꺼 둔 뒤 새로 만든 판도 GPU 를 안 쓴다', await js(`leavesOf(activeTab().root).every(l=>!l._webgl)`));
  await js(`setPref('gpuRender', true); true`);
  await sleep(900);
  if (gpu) ok('다시 켜면 GPU 로 돌아온다', await js(`leavesOf(activeTab().root).some(l=>!!l._webgl)`),
    `GPU 판 ${await js(`leavesOf(activeTab().root).filter(l=>!!l._webgl).length`)}개`);

  // 4) 분할로 만든 판도 GPU 로 그린다 (예전에는 '빈 판' 으로 생겨 영영 CPU 였다)
  if (gpu) ok('분할해서 만든 터미널도 GPU 로 그린다',
    await js(`leavesOf(activeTab().root).filter(l=>l.mode==='terminal').every(l=>!!l._webgl)`),
    await js(`JSON.stringify(leavesOf(activeTab().root).map(l=>l.mode+':'+(l._webgl?'GPU':'CPU')))`));

  // 5) 파일·웹 판은 터미널을 그리지 않으므로 GPU 를 쓰지 않아야 한다
  win.webContents.send('menu:split-horizontal');
  await sleep(900);
  await js("document.getElementById('modal-backdrop').classList.add('hidden');true");
  await js("[...document.querySelectorAll('.launcher-list')].pop().children[1].click();true"); // 웹페이지
  await sleep(2000);
  ok('웹 판은 GPU 를 쓰지 않는다',
    await js(`leavesOf(activeTab().root).filter(l=>l.mode==='web').every(l=>!l._webgl)`),
    await js(`JSON.stringify(leavesOf(activeTab().root).map(l=>l.mode+':'+(l._webgl?'GPU':'CPU')))`));

  // 6) 비용 — 자주 불려도 괜찮은가
  const cost = await js(`(()=>{const t=performance.now(); for(let i=0;i<5;i++) redrawGlyphs(true); return (performance.now()-t)/5})()`);
  ok('복구 비용이 작다 (한 번에 20ms 미만)', cost < 20, `${cost.toFixed(1)}ms`);

  console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
