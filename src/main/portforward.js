'use strict';

/**
 * 포트 포워딩 — 서버에서 열린 포트를 내 PC 로 끌어온다.
 *
 * VS Code 의 포트 전달과 같은 원리다(`ssh -L`). 새로 접속하지 않고, 이미 붙어
 * 있는 그 SSH 연결에 실어 보낸다.
 *
 *   내 PC 브라우저 → 127.0.0.1:<로컬포트>   (여기서 여는 리스너)
 *                      ↓ 열려 있는 SSH 연결
 *                  서버의 127.0.0.1:<원격포트>
 *
 * 리스너는 반드시 127.0.0.1 에만 연다. 0.0.0.0 으로 열면 같은 네트워크의 다른
 * 기기가 사장님 개발 서버에 들어올 수 있게 된다.
 */

const net = require('net');
const ssh = require('./ssh');

/** 열려 있는 전달: id → { id, sessionId, localPort, remotePort, remoteHost, server } */
const forwards = new Map();
let nextId = 1;

/** 이 포트로 로컬 리스너를 열 수 있는지 */
function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * 쓸 수 있는 로컬 포트를 고른다.
 * 원격과 같은 번호를 쓰는 게 기억하기 좋으므로 그것부터 시도하고,
 * 이미 쓰는 중이면 8000 번대에서 빈 자리를 찾는다.
 */
async function pickLocalPort(want) {
  if (await canListen(want)) return want;
  for (let p = 18000; p < 18100; p++) {
    if (await canListen(p)) return p;
  }
  return 0; // 0 이면 OS 가 아무 빈 포트나 준다
}

/**
 * 전달 시작.
 * @returns {{ id, localPort, remotePort, url }}
 */
async function start(sessionId, remotePort, remoteHost, wantLocal) {
  if (ssh.isLocal(sessionId)) throw new Error('로컬 터미널은 전달할 것이 없습니다.');
  const host = remoteHost || '127.0.0.1';

  // 이미 같은 것을 전달 중이면 그걸 그대로 돌려준다
  for (const f of forwards.values()) {
    if (f.sessionId === sessionId && f.remotePort === remotePort && f.remoteHost === host) {
      return describe(f);
    }
  }

  const localPort = await pickLocalPort(Number(wantLocal) || Number(remotePort));
  const id = `f${nextId++}`;

  const live = new Set(); // 지금 붙어 있는 소켓들 (중지할 때 같이 끊는다)
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    // 연결 하나마다 SSH 채널을 하나 연다 (ssh -L 과 같다)
    ssh.forwardOut(sessionId, host, remotePort, sock.remoteAddress || '127.0.0.1', sock.remotePort || 0)
      .then((stream) => {
        sock.pipe(stream).pipe(sock);
        const bye = () => {
          try {
            stream.end();
          } catch (e) {
            /* noop */
          }
        };
        sock.on('error', bye);
        sock.on('close', bye);
        stream.on('error', () => sock.destroy());
      })
      .catch(() => sock.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, '127.0.0.1', resolve); // 바깥에는 열지 않는다
  });

  const f = {
    id,
    sessionId,
    remoteHost: host,
    remotePort: Number(remotePort),
    localPort: server.address().port,
    server,
    live
  };
  forwards.set(id, f);
  return describe(f);
}

const describe = (f) => ({
  id: f.id,
  sessionId: f.sessionId,
  remoteHost: f.remoteHost,
  remotePort: f.remotePort,
  localPort: f.localPort,
  url: `http://localhost:${f.localPort}`
});

/** 전달 중지 */
function stop(id) {
  const f = forwards.get(id);
  if (!f) return false;
  try {
    f.server.close(); // 새 연결을 막고
  } catch (e) {
    /* noop */
  }
  // 이미 붙어 있는 연결도 끊는다. close() 만으로는 keep-alive 로 붙어 있는
  // 브라우저가 계속 쓸 수 있어서 "중지했는데 여전히 열린다" 가 된다.
  for (const sock of f.live) {
    try {
      sock.destroy();
    } catch (e) {
      /* noop */
    }
  }
  f.live.clear();
  forwards.delete(id);
  return true;
}

/** 그 세션의 전달을 모두 정리 (연결이 끊겼을 때) */
function stopForSession(sessionId) {
  const gone = [];
  for (const f of [...forwards.values()]) {
    if (f.sessionId !== sessionId) continue;
    gone.push(describe(f));
    stop(f.id);
  }
  return gone;
}

/** 지금 열려 있는 전달 목록 */
function list(sessionId) {
  return [...forwards.values()]
    .filter((f) => !sessionId || f.sessionId === sessionId)
    .map(describe);
}

function stopAll() {
  for (const id of [...forwards.keys()]) stop(id);
}

module.exports = { start, stop, stopForSession, list, stopAll };
