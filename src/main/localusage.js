'use strict';

/**
 * 윈도우 로컬 터미널의 Claude / Codex 사용량 조회.
 *
 * 원격(리눅스·맥 서버)과 맥·리눅스 로컬은 claudeinfo / codexinfo 의 셸(sh) 스크립트로
 * 조회한다. 윈도우에는 sh 가 없으므로(로컬 명령은 PowerShell 로 돈다) 같은 일을
 * 여기서 Node 로 직접 한다. 돌려주는 모양은 셸 스크립트의 출력과 같아서, 정리는
 * 각 모듈의 normalize 를 그대로 쓴다.
 *
 *   Claude — %USERPROFILE%\.claude\.credentials.json 의 토큰으로 사용량 API 호출
 *   Codex  — `codex app-server`(JSON-RPC, 표준입출력)에 계정·사용량을 묻는다
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOME = os.homedir();

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

/* ------------------------------- Claude ------------------------------- */

async function getJson(url, headers) {
  let fetchFn = global.fetch;
  try {
    // 전자(electron) net 은 시스템 프록시 설정을 따른다 — 회사망에서도 동작하게
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') fetchFn = net.fetch.bind(net);
  } catch (e) {
    /* electron 밖(시험)에서는 전역 fetch */
  }
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return null;
  }
}

/** claudeinfo 의 셸 스크립트가 내는 것과 같은 모양: { loggedIn, email, profile, usage } */
async function claudeRaw() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  const cred = readText(path.join(dir, '.credentials.json'));
  if (!cred) return { loggedIn: false };
  let token = '';
  try {
    const j = JSON.parse(cred);
    token = (j.claudeAiOauth && j.claudeAiOauth.accessToken) || '';
  } catch (e) {
    const m = cred.match(/"accessToken"\s*:\s*"([^"]+)"/);
    token = m ? m[1] : '';
  }
  if (!token) return { loggedIn: false };

  let email = '';
  const cfg = readText(path.join(HOME, '.claude.json'));
  if (cfg) {
    const m = cfg.match(/"emailAddress"\s*:\s*"([^"]*)"/);
    if (m) email = m[1];
  }

  const headers = { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' };
  const [profile, usage] = await Promise.all([
    getJson('https://api.anthropic.com/api/oauth/profile', headers),
    getJson('https://api.anthropic.com/api/oauth/usage', headers)
  ]);
  return { loggedIn: true, email, profile, usage };
}

/* -------------------------------- Codex -------------------------------- */

/** PATH 와 흔한 설치 위치에서 codex 실행 파일을 찾는다 (npm 전역 설치는 codex.cmd) */
function findCodex() {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  dirs.push(path.join(HOME, '.local', 'bin'), path.join(HOME, '.codex', 'bin'));
  for (const d of dirs) {
    for (const ext of ['.exe', '.cmd', ...exts.map((e) => e.toLowerCase())]) {
      const p = path.join(d, 'codex' + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (e) {
        /* 없으면 다음 */
      }
    }
  }
  return null;
}

/** 프로세스와 그 자식까지 끝낸다 (.cmd 는 cmd.exe → node 로 한 겹 더 있다) */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try {
      child.kill();
    } catch (e) {
      /* 이미 끝남 */
    }
    return;
  }
  try {
    cp.execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } catch (e) {
    try {
      child.kill();
    } catch (e2) {
      /* 이미 끝남 */
    }
  }
}

/**
 * codexinfo 의 셸 스크립트가 내는 것과 같은 것: 'ARMUX_CODEX:absent' 또는 JSON-RPC 응답 줄들.
 * @returns {Promise<string>}
 */
function codexText(timeoutMs = 30000) {
  const exe = findCodex();
  if (!exe) return Promise.resolve('ARMUX_CODEX:absent');

  return new Promise((resolve) => {
    // .cmd/.bat 는 셸을 거쳐야 실행된다(최신 Node 는 그냥 띄우기를 막는다)
    const viaShell = /\.(cmd|bat)$/i.test(exe);
    const child = viaShell
      ? cp.spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" app-server`], {
          windowsHide: true,
          windowsVerbatimArguments: true
        })
      : cp.spawn(exe, ['app-server'], { windowsHide: true });

    let buf = '';
    const lines = [];
    let got2 = false;
    let got3 = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end(); // 입력을 닫으면 app-server 가 스스로 끝난다
      } catch (e) {
        /* 이미 닫힘 */
      }
      setTimeout(() => killTree(child), 1500);
      resolve(lines.join('\n'));
    };
    const timer = setTimeout(finish, timeoutMs);

    child.on('error', finish);
    child.on('exit', finish);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        if (/"id"\s*:\s*2\b/.test(line)) {
          lines.push(line);
          got2 = true;
        } else if (/"id"\s*:\s*3\b/.test(line)) {
          lines.push(line);
          got3 = true;
        }
        if (got2 && got3) return finish();
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {}); // 먼저 끝나 버리면 쓰기가 EPIPE 로 실패한다 — 무시

    const send = (o) => {
      try {
        child.stdin.write(JSON.stringify(o) + '\n');
      } catch (e) {
        /* 이미 끝났으면 finish 가 처리 */
      }
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'armux', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'account/read', params: {} });
  });
}

module.exports = { claudeRaw, codexText, findCodex };
