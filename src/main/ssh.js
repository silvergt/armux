'use strict';

/**
 * SSH 세션 관리자.
 * 세션 1개 = ssh2 Client 1개 + shell stream 1개 = 렌더러의 터미널 페인 1개.
 */

const crypto = require('crypto');
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

  const fail = (err) => {
    if (meta.closed) return;
    meta.closed = true;
    handlers.onError(sessionId, err && err.message ? err.message : String(err));
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
          const gone = () => {
            if (meta.closed) return;
            meta.closed = true;
            handlers.onExit(sessionId);
            try {
              client.end();
            } catch (e) {
              /* noop */
            }
            sessions.delete(sessionId);
          };
          /*
           * error 리스너가 없으면 Node 가 예외를 던져 메인 프로세스가 통째로 죽는다.
           * 이건 터미널 본체 스트림이라 늘 열려 있고, 연결이 험하게 끊기면 여기서
           * 난다. 죽는 대신 "이 판만 끊긴 것" 으로 처리한다.
           */
          stream.on('error', gone);
          stream.stderr.on('error', () => {});
          stream.on('close', gone);
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
      handlers.onExit(sessionId);
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
function openLocal(size, handlers) {
  const pty = require('node-pty'); // 네이티브 모듈 — 실제로 쓸 때만 로드
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
    handlers.onExit(sessionId, exitCode || 0);
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
  if (!s) return onClose(new Error('세션이 없습니다.'));
  if (s.local) return onClose(new Error('로컬 세션은 별도 경로로 실행합니다.'));
  let done = false;
  let channel = null;
  const finish = (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onClose(err || null);
  };
  const timer = setTimeout(() => {
    if (channel) {
      try {
        channel.close(); // 시간 초과면 채널도 닫는다 (안 닫으면 쌓인다)
      } catch (e) {
        /* 이미 닫혔으면 그만 */
      }
    }
    finish(new Error('실행 시간 초과'));
  }, timeoutMs || 300000);
  s.client.exec(command, (err, stream) => {
    if (err) return finish(err);
    channel = stream;
    stream.on('data', (d) => onData(d.toString('utf8')));
    stream.stderr.on('data', () => {});
    // error 리스너가 없으면 Node 가 던져서 메인 프로세스가 죽는다
    stream.on('error', (e) => finish(e));
    stream.stderr.on('error', () => {});
    stream.on('close', () => finish(null));
  });
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
