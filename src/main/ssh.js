'use strict';

/**
 * SSH 세션 관리자.
 * 세션 1개 = ssh2 Client 1개 + shell stream 1개 = 렌더러의 터미널 페인 1개.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { buildConnectConfig } = require('./sshconfig');

const sessions = new Map(); // sessionId -> { client, stream, meta }

/**
 * 새 SSH 세션을 연다.
 * @param {object} profile 접속 정보(비밀번호 포함)
 * @param {object} size    { cols, rows } 최초 터미널 크기
 * @param {object} handlers { onData, onExit, onError, onReady }
 * @returns {string} sessionId
 */
function open(profile, size, handlers) {
  const sessionId = crypto.randomUUID();
  const client = new Client();
  const meta = { profile: { ...profile, password: undefined, passphrase: undefined }, closed: false };
  sessions.set(sessionId, { client, stream: null, meta });

  /*
   * 왜 끝났는지를 구분해서 알린다.
   *  - clean  : 사용자가 exit/logout 을 쳐서 셸이 정상적으로 끝났다.
   *  - 그 외  : 연결이 끊어진 것이다(네트워크). 이때만 앱이 스스로 다시 붙는다.
   * 이 구분이 없으면 exit 를 쳐도 자꾸 다시 접속되어 판을 닫을 수가 없다.
   */
  let shellExited = false; // 서버가 exit-status 를 보냈다 = 셸이 스스로 끝났다

  const fail = (err) => {
    if (meta.closed) return;
    meta.closed = true;
    handlers.onError(sessionId, err && err.message ? err.message : String(err), {
      // 접속 자체가 안 된 것(인증 실패 등)인지, 붙어 있다가 끊긴 것인지
      wasConnected: Boolean(sessions.get(sessionId) && sessions.get(sessionId).stream),
      code: (err && err.code) || (err && err.level) || ''
    });
    try {
      client.end();
    } catch (e) {
      /* noop */
    }
    sessions.delete(sessionId);
  };

  client
    .on('ready', () => {
      client.shell(
        {
          term: 'xterm-256color',
          cols: (size && size.cols) || 80,
          rows: (size && size.rows) || 24
        },
        (err, stream) => {
          if (err) return fail(err);
          const s = sessions.get(sessionId);
          if (!s) {
            stream.end();
            return;
          }
          s.stream = stream;
          handlers.onReady(sessionId);

          stream.on('data', (data) => handlers.onData(sessionId, data));
          stream.stderr.on('data', (data) => handlers.onData(sessionId, data));
          const gone = (err) => {
            if (meta.closed) return;
            meta.closed = true;
            handlers.onExit(sessionId, { clean: shellExited && !err });
            try {
              client.end();
            } catch (e) {
              /* noop */
            }
            sessions.delete(sessionId);
          };
          // 셸이 스스로 끝나면 서버가 exit-status 를 보낸다. 끊긴 경우엔 오지 않는다.
          stream.on('exit', () => {
            shellExited = true;
          });
          /*
           * error 리스너가 없으면 Node 가 예외를 던져 메인 프로세스가 통째로 죽는다.
           * 이건 터미널 본체 스트림이라 늘 열려 있고, 연결이 험하게 끊기면 여기서
           * 난다. 죽는 대신 "이 판만 끊긴 것" 으로 처리한다.
           */
          stream.on('error', (e) => gone(e || new Error('stream error')));
          stream.stderr.on('error', () => {});
          stream.on('close', () => gone());
        }
      );
    })
    .on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      // 비밀번호 방식 서버가 keyboard-interactive 로 물어보는 경우 같은 비밀번호로 응답
      finish(prompts.map(() => profile.password || ''));
    })
    .on('error', fail)
    .on('end', () => {
      if (meta.closed) return;
      meta.closed = true;
      handlers.onExit(sessionId, { clean: shellExited });
      sessions.delete(sessionId);
    });

  try {
    client.connect(buildConnectConfig(profile));
  } catch (err) {
    // connect 전 단계(키 파일 없음 등) 오류는 비동기 이벤트가 아니라 여기서 발생
    setImmediate(() => fail(err));
  }

  return sessionId;
}

/**
 * 이미 열려 있는 SSH 연결에서 명령을 하나 실행한다.
 * 셸(터미널)과는 별도의 채널이라 화면에 아무 영향이 없다.
 */
function exec(sessionId, command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const s = sessions.get(sessionId);
    if (!s) return reject(new Error('세션이 없습니다.'));
    if (s.local) return reject(new Error('로컬 터미널에서는 지원하지 않는 기능입니다.'));
    let done = false;
    let channel = null;
    const settle = (fn, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      /*
       * 시간이 지나면 채널도 닫는다. 예전에는 거부만 하고 열어 둬서, 느린 서버에서
       * 조회가 반복 실패하면 exec 채널이 계속 쌓였다. SSH 채널에는 한도가 있어
       * 가득 차면 사용량·포트 목록·AI 가 한꺼번에 조용히 멈춘다.
       */
      if (channel) {
        try {
          channel.close();
        } catch (e) {
          /* 이미 닫혔으면 그만 */
        }
      }
      settle(reject, new Error('명령 실행 시간 초과'));
    }, timeoutMs);

    s.client.exec(command, (err, stream) => {
      if (err) return settle(reject, err);
      channel = stream;
      let out = '';
      let errOut = '';
      stream.on('data', (d) => {
        out += d.toString('utf8');
      });
      stream.stderr.on('data', (d) => {
        errOut += d.toString('utf8');
      });
      /*
       * error 리스너가 없으면 Node 가 예외를 던져 메인 프로세스가 통째로 죽는다.
       * (연결이 끊기는 순간 등) 그러면 열려 있던 터미널이 전부 날아간다.
       */
      stream.on('error', (e) => settle(reject, e));
      stream.stderr.on('error', () => {});
      stream.on('close', (code) => settle(resolve, { stdout: out, stderr: errOut, code }));
    });
  });
}

/**
 * 로컬 터미널 세션. SSH 대신 이 PC 의 셸을 PTY 로 띄운다.
 * 같은 sessions 맵에 넣어 write/resize/close/count 가 그대로 통한다.
 */
/*
 * 맥에서 node-pty 는 셸을 띄울 때 spawn-helper 라는 보조 실행 파일을 쓴다.
 * 그런데 npm 으로 배포되는 프리빌드에 이 파일의 실행 권한이 빠져 있어(644),
 * 패키징을 거쳐도 그대로 644 라 posix_spawnp failed 로 죽는다. 띄우기 직전에
 * 권한을 바로잡는다 — 이미 설치된 앱도 앱 갱신만으로 구제된다.
 */
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  try {
    const base = path.dirname(require.resolve('node-pty/package.json'));
    for (const cand of [
      path.join(base, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(base, 'build', 'Release', 'spawn-helper')
    ]) {
      // 패키징된 앱에서는 실제 파일이 app.asar.unpacked 아래에 있다 (node-pty 도 그리 찾는다)
      const real = cand.replace('app.asar', 'app.asar.unpacked');
      if (!fs.existsSync(real)) continue;
      const mode = fs.statSync(real).mode;
      if (!(mode & 0o111)) fs.chmodSync(real, 0o755);
    }
  } catch (e) {
    /* 권한을 못 고쳐도 일단 시도는 해 본다 — 실패하면 원래 오류가 그대로 보인다 */
  }
}

function openLocal(size, handlers) {
  const pty = require('node-pty'); // 네이티브 모듈 — 실제로 쓸 때만 로드
  ensureSpawnHelperExecutable();
  const sessionId = crypto.randomUUID();
  const isWin = process.platform === 'win32';
  // 사용자의 기본 셸: win 은 PowerShell, 그 외는 $SHELL (없으면 bash/zsh)
  const shell = isWin
    ? 'powershell.exe'
    : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const meta = { profile: { local: true, shell }, closed: false, local: true };

  const term = pty.spawn(shell, isWin ? [] : ['-l'], {
    name: 'xterm-256color',
    cols: (size && size.cols) || 80,
    rows: (size && size.rows) || 24,
    cwd: process.env.HOME || process.env.USERPROFILE || undefined,
    env: process.env
  });
  sessions.set(sessionId, { local: true, term, meta });

  term.onData((d) => handlers.onData(sessionId, d));
  term.onExit(({ exitCode }) => {
    if (meta.closed) return;
    meta.closed = true;
    sessions.delete(sessionId);
    // 로컬 셸이 끝난 것은 언제나 "사용자가 끝낸 것" 이다 (네트워크와 무관)
    handlers.onExit(sessionId, { clean: true, code: exitCode || 0 });
  });
  // PTY 는 즉시 준비된다
  setTimeout(() => handlers.onReady(sessionId), 0);
  return sessionId;
}

function write(sessionId, data) {
  const s = sessions.get(sessionId);
  if (s && s.local) return s.term.write(data);
  if (s && s.stream) s.stream.write(data);
}

function resize(sessionId, cols, rows) {
  const s = sessions.get(sessionId);
  if (s && s.local) {
    try {
      s.term.resize(cols, rows);
    } catch (e) {
      /* noop */
    }
    return;
  }
  if (s && s.stream) {
    try {
      s.stream.setWindow(rows, cols, 0, 0);
    } catch (e) {
      /* noop */
    }
  }
}

function close(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.meta.closed = true;
  try {
    if (s.local) s.term.kill();
    else {
      if (s.stream) s.stream.end();
      s.client.end();
    }
  } catch (e) {
    /* noop */
  }
  sessions.delete(sessionId);
}

/**
 * exec 를 스트리밍으로 실행한다. 출력 조각이 올 때마다 onData(chunk) 를 부른다.
 * AI 응답을 실시간으로 흘려보내는 용도.
 */
function execStream(sessionId, command, timeoutMs, onData, onClose) {
  const s = sessions.get(sessionId);
  if (!s) {
    onClose(new Error('세션이 없습니다.'));
    return () => {};
  }
  if (s.local) {
    onClose(new Error('로컬 세션은 별도 경로로 실행합니다.'));
    return () => {};
  }
  let done = false;
  let cancelled = false;
  let channel = null;
  const finish = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onClose(err || null);
  };
  /*
   * 채널을 확실히 놓아 준다. SSH 연결 하나가 열 수 있는 채널 수는 서버의
   * MaxSessions(기본 10)로 제한되고, 한도에 걸린 연결은 그 뒤로 exec 이 계속
   * 실패한다(실측: 닫아도 곧바로 회복되지 않았다). 그래서 close 만 부르지 않고
   * end/destroy 까지 시도한다.
   */
  const release = () => {
    if (!channel) return;
    for (const m of ['close', 'end', 'destroy']) {
      try {
        if (typeof channel[m] === 'function') channel[m]();
      } catch (e) {
        /* 이미 닫혔으면 그만 */
      }
    }
    channel = null;
  };
  const timer = setTimeout(() => {
    release(); // 시간 초과면 채널도 놓아 준다 (안 놓으면 쌓인다)
    finish(new Error('실행 시간 초과'));
  }, timeoutMs || 300000);
  s.client.exec(command, (err, stream) => {
    if (err) return finish(err);
    if (cancelled) {
      // 채널이 열리기 전에 취소된 경우 — 열리자마자 놓아 준다
      channel = stream;
      release();
      return finish(new Error('취소됨'));
    }
    channel = stream;
    stream.on('data', (d) => onData(d.toString('utf8')));
    stream.stderr.on('data', () => {});
    // error 리스너가 없으면 Node 가 던져서 메인 프로세스가 죽는다
    stream.on('error', (e) => finish(e));
    stream.stderr.on('error', () => {});
    stream.on('close', () => finish(null));
  });

  /** 부르는 쪽에서 언제든 끊을 수 있게 해 준다 (관찰기의 감시견이 쓴다) */
  return () => {
    cancelled = true;
    release();
    finish(new Error('취소됨'));
  };
}

/** 이 세션이 로컬 PTY 인지 (AI 질문을 로컬에서 실행할지 판단용) */
function isLocal(sessionId) {
  const s = sessions.get(sessionId);
  return Boolean(s && s.local);
}

/** 현재 열려 있는 터미널 세션 수 */
function count() {
  return sessions.size;
}

function closeAll() {
  for (const id of Array.from(sessions.keys())) close(id);
}

/**
 * 포트 포워딩용 채널 하나를 연다 (ssh -L 이 하는 일).
 * 이미 붙어 있는 연결에 실어 보내므로 새로 접속하지 않는다.
 */
function forwardOut(sessionId, remoteHost, remotePort, srcHost, srcPort) {
  return new Promise((resolve, reject) => {
    const s = sessions.get(sessionId);
    if (!s) return reject(new Error('세션이 없습니다.'));
    if (s.local) return reject(new Error('로컬 터미널에서는 지원하지 않는 기능입니다.'));
    s.client.forwardOut(srcHost || '127.0.0.1', srcPort || 0, remoteHost, remotePort, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

module.exports = { open, openLocal, exec, execStream, write, resize, close, closeAll, count, isLocal,
  forwardOut
};
