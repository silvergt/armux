/*
 * 관찰기(paneprobe) 스크립트를 진짜 SSH·tmux 위에서 검증한다 — `npm run test:probe`
 *
 * 표 시험은 관찰기가 준 값을 입력으로 넣어 분류기만 본다. 그래서 관찰기 자체의
 * 구멍 — 세션 녹화 서버(sshd → 녹화기 → 셸 → tmux)에서 tmux 를 못 찾던 것 — 을
 * 놓쳤다. 이 시험은 관찰기 스크립트를 그대로 SSH 로 돌리고, 녹화기(script) 안에서
 * tmux 를 붙인 상태로 무엇을 보고하는지 확인한다.
 *
 * 필요한 것: 127.0.0.1 로 SSH (ARMUX_TEST_KEY / ARMUX_TEST_USER), tmux, script(util-linux)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { Client } = require('ssh2');

const KEY = process.env.ARMUX_TEST_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
const USER = process.env.ARMUX_TEST_USER || os.userInfo().username;
const SESS = 'armux_test_probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tq = (...a) => {
  try {
    return cp.execFileSync('tmux', a, { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
};
let bad = 0;
const ok = (n, p, note) => {
  if (!p) bad++;
  console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${note !== undefined ? '   [' + note + ']' : ''}`);
};

// 관찰기 스크립트를 모듈에서 그대로 꺼낸다
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'paneprobe.js'), 'utf8') + '\n;module.exports.__s = script;';
const m = { exports: {} };
new Function('module', 'exports', 'require', src)(m, m.exports, (x) => (x === './ssh' ? {} : require(x)));
const SCRIPT = m.exports.__s();

const c = new Client();
c.on('ready', () => {
  c.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, async (e, sh) => {
    if (e) throw e;
    sh.on('data', () => {});
    const blocks = [];
    let cur = null;
    c.exec(SCRIPT, (e2, st) => {
      if (e2) throw e2;
      let buf = '';
      st.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const L = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (L.trim() === 'B') cur = [];
          else if (L.trim() === 'E') {
            if (cur) blocks.push(cur);
            cur = null;
          } else if (cur) cur.push(L);
        }
      });
      st.stderr.on('data', () => {});
    });
    const last = () => blocks[blocks.length - 1] || [];
    const mode = () => ((last().find((l) => l.startsWith('M ')) || '').split(' ')[1] || '');
    const panes = () => last().filter((l) => l.startsWith('P '));
    try {
      tq('kill-session', '-t', SESS);
      tq('new-session', '-d', '-s', SESS, '-x', '90', '-y', '24');
      tq('new-window', '-d', '-t', `${SESS}:1`);
      await sleep(3000);
      ok('tmux 밖에서는 direct', mode() === 'direct', mode());
      ok('프롬프트는 대기(Z)', last().some((l) => l.startsWith('Z ')));

      console.log('\n■ 녹화기(script) 안에서 tmux');
      sh.write('script -q /dev/null\n');
      await sleep(2500);
      ok('녹화기만 떠 있으면 direct + 대기', mode() === 'direct' && last().some((l) => l.startsWith('Z ')), last().join(' | '));
      sh.write(`tmux attach -t ${SESS}\n`);
      await sleep(4500);
      ok('★ 녹화기 안에서 tmux 를 찾는다', mode() === 'tmux', mode());
      ok('   창 두 개가 모두 보인다', panes().length === 2, String(panes().length));
      tq('send-keys', '-t', `${SESS}:1`, 'sleep 30', 'Enter');
      await sleep(4500);
      ok('★ 안 보이는 창의 sleep 을 본다', panes().some((l) => / 1 0 .*sleep$/.test(l)), panes().join(' | '));
      tq('send-keys', '-t', `${SESS}:1`, 'C-c');
      await sleep(4500);
      ok('   끝나면 셸로 돌아온 것을 본다', panes().some((l) => / 1 0 .*bash$/.test(l)), panes().join(' | '));

      sh.write('\x02d'); // detach
      await sleep(4500);
      ok('★ detach 하면 다시 direct', mode() === 'direct', mode());
      sh.write('exit\n'); // 녹화기 종료
      await sleep(3000);
      ok('녹화기를 나가도 direct + 대기', mode() === 'direct' && last().some((l) => l.startsWith('Z ')));
    } catch (err) {
      bad++;
      console.log('EXCEPTION', err && err.stack);
    } finally {
      tq('kill-session', '-t', SESS);
      console.log(`\n${bad === 0 ? '모두 통과' : bad + ' 건 실패'}`);
      c.end();
      process.exit(bad ? 1 : 0);
    }
  });
});
c.on('error', (e) => {
  console.log('SSH 연결 실패:', e.message, '— ARMUX_TEST_KEY / ARMUX_TEST_USER 를 확인하세요');
  process.exit(1);
});
c.connect({ host: '127.0.0.1', port: 22, username: USER, privateKey: fs.readFileSync(KEY) });
