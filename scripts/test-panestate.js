/*
 * 판 상태 판정 회귀 시험 — `npm run test:panestate`
 *
 * 탭 앞의 스피너/초록 느낌표는 두 층으로 정해진다.
 *   아래층: 서버가 2초마다 알려 주는 관찰 결과(paneprobe) — 어느 창에서 무엇이 도는지
 *   위층 : Claude Code 훅(OSC 6789) — 폴링으로는 "생각 중" 과 "입력 대기" 가
 *          똑같이 `claude` 로만 보이므로 그 구간만 훅이 정한다
 *
 * 아래 표의 (cmd, argv, chain) 조합은 전부 실제 tmux 에서 측정해 얻은 값이다.
 * 규칙을 손볼 때 이 표가 깨지면 무엇이 어떻게 바뀌는지 먼저 확인할 것.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-panestate-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//  [설명, cmd, argv, chain(자식 사슬), 훅신호, 기대값, 관찰기가 '대기'라고 못박았는지]
const T = [
  // ── 기본 ──────────────────────────────────────────────────────────────
  ['프롬프트',                'bash',    '-bash',                   ['bash'],                  null, 'idle'],
  ['zsh 프롬프트',            'zsh',     'zsh',                     ['zsh'],                   null, 'idle'],
  ['sleep 실행',              'sleep',   'sleep 40',                ['sleep'],                 null, 'busy'],
  ['이름을 못 읽음',           '',        '',                        [],                        null, 'idle'],

  // ── REPL 과 스크립트 실행 가르기 ───────────────────────────────────────
  ['python3 REPL',           'python3', 'python3 -q',              ['python3'],               null, 'idle'],
  ['python3 -c 작업',         'python3', 'python3 -c import time',  ['python3'],               null, 'busy'],
  ['python3 스크립트',         'python3', 'python3 bt.py',           ['python3'],               null, 'busy'],
  ['python3 파이프라인',       'python3', 'grep --color=auto -a zz', ['python3'],               null, 'busy'],
  ['argv 를 못 받은 python3',  'python3', '',                        ['python3'],               null, 'busy'],
  ['node 맨몸 REPL',          'node',    'node',                    ['node'],                  null, 'idle'],
  ['node 스크립트',            'node',    'node server.js',          ['node'],                  null, 'busy'],

  // ── 전체화면 앱 · 페이저 ───────────────────────────────────────────────
  ['vim',                    'vim',     'vim',                     ['vim'],                   null, 'idle'],
  ['less 페이저',             'less',    'less /etc/services',      ['less'],                  null, 'idle'],
  ['★ git log — 자식이 페이저', 'git',    'git log',                 ['git', 'pager'],          null, 'idle'],
  ['git clone (작업)',         'git',     'git clone https://x',     ['git'],                   null, 'busy'],
  ['중첩 tmux',               'tmux',    'tmux -L inner new',       ['tmux'],                  null, 'idle'],
  ['중첩 ssh',                'ssh',     'ssh other-host',          ['ssh'],                   null, 'idle'],

  // ── 감싸 실행하는 것들(사슬로 가른다) ──────────────────────────────────
  ['★ sudo -i — 자식이 셸',    'sudo',    'sudo -i',                 ['sudo', 'sudo', 'bash'],  null, 'idle'],
  ['★ sudo sleep — 진짜 작업', 'sudo',    'sudo sleep 40',           ['sudo', 'sudo', 'sleep'], null, 'busy'],
  ['★ sudo make — 진짜 작업',  'sudo',    'sudo make -j8',           ['sudo', 'sudo', 'make'],  null, 'busy'],
  ['★ sudo -i 로 연 셸 안에서 작업', 'sudo', 'sudo -i',              ['sudo', 'sudo', 'bash', 'sleep'], null, 'busy'],
  ['★ sudo -i 셸이 다시 프롬프트로', 'sudo', 'sudo -i',              ['sudo', 'sudo', 'bash'],  null, 'idle'],
  ['nohup 작업',              'nohup',   'nohup python3 bt.py',     ['nohup', 'python3'],      null, 'busy'],
  ['su - (셸로 바뀜)',         'bash',    '-bash',                   ['bash'],                  null, 'idle'],

  // ── 자식이 셸이어도 작업인 경우 (사슬 규칙이 과하면 여기서 깨진다) ──────
  ['★ make 가 sh 로 레시피 실행', 'make', 'make -j8',                ['make', 'sh'],            null, 'busy'],
  ['★ 스크립트가 서브셸을 띄움',  'python3', 'python3 bt.py',        ['python3', 'bash'],       null, 'busy'],

  // ── 따라가기(감시) ─────────────────────────────────────────────────────
  ['tail -f 로그 감시',        'tail',    'tail -f /var/log/x',      ['tail'],                  null, 'idle'],
  ['tail 로 앞부분만',         'tail',    'tail -n 100 /var/log/x',  ['tail'],                  null, 'busy'],

  // ── 파이프라인 · 기타 작업 ─────────────────────────────────────────────
  ['파이프라인 cat|grep',      'cat',     'grep --color=auto -a zz', ['cat'],                   null, 'busy'],
  ['make',                   'make',    'make -j8',                ['make'],                  null, 'busy'],
  ['rsync',                  'rsync',   'rsync -a a b',            ['rsync'],                 null, 'busy'],

  // ── 에이전트: 훅이 정한다 (사슬 규칙보다 먼저) ─────────────────────────
  ['claude 켜짐, 훅 없음',     'claude',  'claude',                  ['claude'],                null,    'idle'],
  ['claude 작업중(훅)',        'claude',  'claude',                  ['claude'],                'busy',  'busy'],
  ['claude 완료(훅)',          'claude',  'claude',                  ['claude'],                'idle',  'idle'],
  ['claude 입력대기(훅)',       'claude',  'claude',                  ['claude'],                'alert', 'alert'],
  ['★ claude 가 자식 셸을 띄움', 'claude', 'claude',                  ['claude', 'bash'],        'busy',  'busy'],
  ['★ claude 가 자식 vim 을 띄움', 'claude', 'claude',                ['claude', 'vim'],         'busy',  'busy'],
  ['이름이 뭐든 훅이 있으면',    'mytool',  'mytool',                  ['mytool'],                'busy',  'busy'],
  ['★ 죽은 뒤 낡은 훅 busy',    'bash',    '-bash',                   ['bash'],                  'busy',  'idle'],

  // ── 세션 녹화처럼 셸을 감싸는 것 (관찰기가 안쪽 pty 까지 보고 Z 를 준다) ──
  ['★ 녹화 래퍼, 프롬프트 대기',  'script',  '',                        [],                        null,   'idle', true],
  ['★ 녹화 래퍼 + 낡은 훅 busy',  'script',  '',                        [],                        'busy', 'idle', true],
  ['★ 녹화 안에서 작업 중',       'script',  'sleep 120',               ['sleep'],                 null,   'busy'],
  ['★ 이름 모를 셸, 프롬프트 대기', 'myshell', '',                       [],                        null,   'idle', true],

  // ── 사슬을 못 받은 서버(ps 폴백)에서도 예전 규칙으로 동작해야 한다 ─────
  ['[폴백] 프롬프트',          'bash',    '-bash',                   [],                        null, 'idle'],
  ['[폴백] sudo -i',          'sudo',    'sudo -i',                 [],                        null, 'idle'],
  ['[폴백] sudo sleep',       'sudo',    'sudo sleep 40',           [],                        null, 'busy'],
  ['[폴백] git log 페이저',    'git',     '/usr/bin/pager',          [],                        null, 'idle'],
  ['[폴백] python3 REPL',     'python3', 'python3 -q',              [],                        null, 'idle'],
  ['[폴백] 작업',              'sleep',   'sleep 40',                [],                        null, 'busy']
];

app.whenReady().then(async () => {
  await sleep(1600);
  const win = BrowserWindow.getAllWindows()[0];
  const res = await win.webContents.executeJavaScript(
    `(()=>{
    const cases = ${JSON.stringify(T)};
    const out = [];
    for (const [name, cmd, argv, chain, sig, want, idle] of cases) {
      const leaf = { hookByPane: Object.create(null) };
      if (sig) leaf.hookByPane['%9'] = sig;
      const got = classifyPane(leaf, { id: '%9', cmd, argv, chain, idle: !!idle, visible: true });
      out.push([name, cmd, want, got, leaf.hookByPane['%9'] || '-']);
    }
    return out;
  })()`,
    true
  );

  let bad = 0;
  console.log(`${'설명'.padEnd(30)} ${'cmd'.padEnd(9)} ${'기대'.padEnd(6)} ${'결과'.padEnd(6)} 훅잔재`);
  console.log('-'.repeat(78));
  for (const [name, cmd, want, got, left] of res) {
    const pass = want === got;
    if (!pass) bad++;
    console.log(`${pass ? '  ' : '✗ '}${name.padEnd(28)} ${cmd.padEnd(9)} ${want.padEnd(6)} ${got.padEnd(6)} ${left}`);
  }
  // 죽은 에이전트의 낡은 훅이 실제로 지워졌는지
  const stale = res.find((r) => r[0].includes('낡은 훅'));
  const cleaned = stale && stale[4] === '-';
  if (!cleaned) bad++;
  console.log(`${cleaned ? '  ' : '✗ '}낡은 훅 상태가 지워졌다`);

  /*
   * 판 단위 판정(evaluatePanes) — 관찰 결과가 어떤 모양이든 스피너가 갇히면 안 된다.
   * "봤는데 아무것도 없다"(빈 배열)와 "아직 못 봤다"(null)를 다르게 다루는지가 핵심이다.
   */
  console.log('');
  const ev = await win.webContents.executeJavaScript(
    `(()=>{
    const mk = () => ({ id:'L', mode:'terminal', alert:false, busy:false,
      hookByPane:Object.create(null), paneWas:Object.create(null), probe:null });
    const pane = (o) => Object.assign({ win:'0', visible:true, argv:'', chain:[] }, o);
    const out = {};

    // 관찰기가 아직 말이 없다 → 훅만으로 본다 (관찰기가 못 도는 서버에서도 살아 있게)
    let l = mk(); l.hookByPane['%1'] = 'busy';
    evaluatePanes(l); out.noProbe = l.busy;

    // 관찰기가 "봤는데 아무것도 없다" → 스피너를 켜지 않는다. 훅 기억은 남긴다.
    l = mk(); l.hookByPane['%1'] = 'busy';
    l.probe = { mode:'tmux', panes: [] };
    evaluatePanes(l); out.emptyBusy = l.busy; out.emptyHooks = Object.keys(l.hookByPane);

    // 창 목록이 돌아오면 없는 창의 기억은 정리된다
    l.probe = { mode:'tmux', panes: [pane({ id:'%2', cmd:'bash', argv:'-bash', chain:['bash'] })] };
    evaluatePanes(l); out.afterReal = l.busy; out.afterHooks = Object.keys(l.hookByPane);

    // Codex — 훅에 "시작" 이벤트가 없어서 생각 중은 화면으로 본다
    const codex = (o) => { const x = mk(); Object.assign(x, o);
      x.probe = { mode:'tmux', panes: [pane({ id:'%c', cmd:'codex', argv:'codex', chain:['codex'], visible: o.vis !== false })] };
      evaluatePanes(x); return x.busy; };
    out.codexQuiet   = codex({});                                   // 켜져만 있음 → 점
    out.codexWorking = codex({ screenBusyAt: Date.now() });         // 생각 중 → 스피너
    out.codexOldScreen = codex({ screenBusyAt: Date.now() - 60000 });// 오래된 화면 → 점
    out.codexHidden  = codex({ screenBusyAt: Date.now(), vis:false });// 안 보이는 창 → 화면은 안 씀
    let cx = mk(); cx.hookByPane['%c'] = 'alert';
    cx.probe = { mode:'tmux', panes: [pane({ id:'%c', cmd:'codex', argv:'codex', chain:['codex'] })] };
    evaluatePanes(cx); out.codexAlert = cx.alert;

    // 여러 창 중 하나만 돌아도 판 전체는 "돌고 있음"
    l = mk();
    l.probe = { mode:'tmux', panes: [
      pane({ id:'%1', cmd:'bash', argv:'-bash', chain:['bash'] }),
      pane({ id:'%2', cmd:'python3', argv:'python3 bt.py', chain:['python3'], visible:false })
    ] };
    evaluatePanes(l); out.anyBusy = l.busy;

    // 그 창이 끝나면 꺼진다
    l.probe = { mode:'tmux', panes: [
      pane({ id:'%1', cmd:'bash', argv:'-bash', chain:['bash'] }),
      pane({ id:'%2', cmd:'bash', argv:'-bash', chain:['bash'], visible:false })
    ] };
    evaluatePanes(l); out.thenIdle = l.busy;
    return out;
  })()`,
    true
  );
  const evChecks = [
    ['관찰기가 아직 말이 없으면 훅만으로 본다', ev.noProbe === true],
    ['★ 관찰 결과가 비면 스피너를 켜지 않는다', ev.emptyBusy === false],
    ['★ 그때 훅 기억은 남겨 둔다', ev.emptyHooks.includes('%1')],
    ['창 목록이 돌아오면 없는 창의 기억을 정리한다', ev.afterHooks.length === 0 && ev.afterReal === false],
    ['여러 창 중 하나만 돌아도 판은 돌고 있음', ev.anyBusy === true],
    ['그 창이 끝나면 꺼진다', ev.thenIdle === false],
    ['★ codex 켜져만 있으면 점', ev.codexQuiet === false],
    ['★ codex 생각 중이면 스피너 (화면으로 판단)', ev.codexWorking === true],
    ['★ 오래된 화면 흔적으로는 안 켜진다', ev.codexOldScreen === false],
    ['★ 안 보이는 창에는 화면 판단을 쓰지 않는다', ev.codexHidden === false],
    ['★ codex 승인 대기 → 느낌표', ev.codexAlert === true]
  ];
  for (const [name, pass] of evChecks) {
    if (!pass) bad++;
    console.log(`${pass ? '  ' : '✗ '}${name}`);
  }
  console.log(`\n${bad === 0 ? `모두 통과 (${res.length + 1 + evChecks.length}건)` : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
