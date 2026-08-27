/*
 * 판 상태 판정 회귀 시험 — `npm run test:panestate`
 *
 * 탭 앞의 스피너/초록 느낌표는 두 층으로 정해진다.
 *   아래층: 서버가 2초마다 알려 주는 관찰 결과(paneprobe) — 어느 창에서 무엇이 도는지
 *   위층 : Claude Code 훅(OSC 6789) — 폴링으로는 "생각 중" 과 "입력 대기" 가
 *          똑같이 `claude` 로만 보이므로 그 구간만 훅이 정한다
 *
 * 아래 표의 (cmd, argv) 조합은 전부 실제 tmux 에서 측정해 얻은 값이다.
 * 규칙을 손볼 때 이 표가 깨지면 무엇이 어떻게 바뀌는지 먼저 확인할 것.
 */
const os = require('os'); const fs = require('fs'); const path = require('path');
const { app, BrowserWindow, dialog } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'armux-panestate-')));
dialog.showMessageBox = async () => ({ response: 1 });
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//  [설명, cmd, argv, 훅신호, 기대값]
const T = [
  ['프롬프트',                 'bash',    '-bash',                    null, 'idle'],
  ['zsh 프롬프트',             'zsh',     'zsh',                      null, 'idle'],
  ['sleep 실행',               'sleep',   'sleep 40',                 null, 'busy'],
  ['python3 REPL',             'python3', 'python3 -q',               null, 'idle'],
  ['python3 -c 작업',          'python3', 'python3 -c import time',   null, 'busy'],
  ['python3 스크립트',          'python3', 'python3 bt.py',            null, 'busy'],
  ['python3 파이프라인',        'python3', 'grep --color=auto -a zz',  null, 'busy'],
  ['argv 를 못 받은 python3',   'python3', '',                         null, 'busy'],
  ['node 맨몸 REPL',           'node',    'node',                     null, 'idle'],
  ['node 스크립트',             'node',    'node server.js',           null, 'busy'],
  ['vim',                      'vim',     'vim',                      null, 'idle'],
  ['less 페이저',              'less',    'less /etc/services',       null, 'idle'],
  ['git log (페이저)',          'git',     '/usr/bin/pager',           null, 'idle'],
  ['git clone (작업)',          'git',     'git clone https://x',      null, 'busy'],
  ['sudo -i (루트 셸)',         'sudo',    'sudo -i',                  null, 'idle'],
  ['sudo su',                  'sudo',    'sudo su',                  null, 'idle'],
  ['sudo 실제 작업',            'sudo',    'sudo sleep 40',            null, 'busy'],
  ['sudo -u 로 명령',           'sudo',    'sudo -u nobody whoami',    null, 'busy'],
  ['su - (셸로 바뀜)',          'bash',    '-bash',                    null, 'idle'],
  ['nohup 작업',               'nohup',   'nohup python3 bt.py',      null, 'busy'],
  ['watch',                    'watch',   'watch -n1 date',           null, 'idle'],
  ['tail -f 로그 감시',         'tail',    'tail -f /var/log/x',       null, 'idle'],
  ['tail 로 앞부분만',          'tail',    'tail -n 100 /var/log/x',   null, 'busy'],
  ['파이프라인 cat|grep',       'cat',     'grep --color=auto -a zz',  null, 'busy'],
  ['중첩 tmux',                'tmux',    'tmux -L inner new',        null, 'idle'],
  ['중첩 ssh',                 'ssh',     'ssh other-host',           null, 'idle'],
  ['make',                     'make',    'make -j8',                 null, 'busy'],
  ['rsync',                    'rsync',   'rsync -a a b',             null, 'busy'],
  ['이름을 못 읽음',            '',        '',                         null, 'idle'],
  ['claude 켜짐, 훅 없음',      'claude',  'claude',                   null,    'idle'],
  ['claude 작업중(훅)',         'claude',  'claude',                   'busy',  'busy'],
  ['claude 완료(훅)',           'claude',  'claude',                   'idle',  'idle'],
  ['claude 입력대기(훅)',        'claude',  'claude',                   'alert', 'alert'],
  ['이름이 뭐든 훅이 있으면',     'mytool',  'mytool',                   'busy',  'busy'],
  ['★ 죽은 뒤 낡은 훅 busy',    'bash',    '-bash',                    'busy',  'idle']
];

app.whenReady().then(async () => {
  await sleep(1600);
  const win = BrowserWindow.getAllWindows()[0];
  const res = await win.webContents.executeJavaScript(`(()=>{
    const cases = ${JSON.stringify(T)};
    const out = [];
    for (const [name, cmd, argv, sig, want] of cases) {
      const leaf = { hookByPane: Object.create(null) };
      if (sig) leaf.hookByPane['%9'] = sig;
      const got = classifyPane(leaf, { id: '%9', cmd, argv, visible: true });
      out.push([name, cmd, argv, sig, want, got, leaf.hookByPane['%9'] || '-']);
    }
    return out;
  })()`, true);

  let bad = 0;
  console.log(`${'설명'.padEnd(24)} ${'cmd'.padEnd(9)} ${'기대'.padEnd(6)} ${'결과'.padEnd(6)} 훅잔재`);
  console.log('-'.repeat(72));
  for (const [name, cmd, argv, sig, want, got, left] of res) {
    const pass = want === got;
    if (!pass) bad++;
    console.log(`${pass ? '  ' : '✗ '}${name.padEnd(22)} ${cmd.padEnd(9)} ${want.padEnd(6)} ${got.padEnd(6)} ${left}`);
  }
  // 낡은 훅이 실제로 지워졌는지
  const stale = res.find((r) => r[0].includes('낡은 훅'));
  const cleaned = stale && stale[6] === '-';
  if (!cleaned) bad++;
  console.log(`${cleaned ? '  ' : '✗ '}낡은 훅 상태가 지워졌다`);
  console.log(`\n${bad === 0 ? `모두 통과 (${res.length + 1}건)` : bad + ' 건 실패'}`);
  setTimeout(() => app.exit(bad ? 1 : 0), 200);
});
