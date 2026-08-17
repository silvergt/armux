'use strict';

/**
 * SSH 세션 관리자.
 * 세션 1개 = ssh2 Client 1개 + shell stream 1개 = 렌더러의 터미널 탭 1개.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const sessions = new Map(); // sessionId -> { client, stream, meta }

/** authType === 'key' 인데 경로를 안 준 경우 흔한 기본 키를 순서대로 찾는다 */
function findDefaultKey() {
  const dir = path.join(os.homedir(), '.ssh');
  const candidates = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** '~/.ssh/id_rsa' 같은 경로의 ~ 를 홈 디렉토리로 확장 */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 프로필로부터 ssh2 접속 옵션을 만든다 */
function buildConnectConfig(profile) {
  const cfg = {
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    keepaliveInterval: 20000, // 20초마다 keepalive (NAT/방화벽 타임아웃 방지)
    keepaliveCountMax: 6,
    readyTimeout: 30000,
    tryKeyboard: true // 서버가 keyboard-interactive 만 허용하는 경우 대비
  };

  if (profile.authType === 'key') {
    const keyPath = expandHome(profile.privateKeyPath) || findDefaultKey();
    if (!keyPath) throw new Error('개인키 파일을 찾을 수 없습니다. 키 경로를 지정해 주세요.');
    if (!fs.existsSync(keyPath)) throw new Error(`개인키 파일이 없습니다: ${keyPath}`);
    cfg.privateKey = fs.readFileSync(keyPath);
    if (profile.passphrase) cfg.passphrase = profile.passphrase;
  } else if (profile.authType === 'agent') {
    cfg.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK;
    if (!cfg.agent) throw new Error('SSH agent 를 찾을 수 없습니다 (SSH_AUTH_SOCK 미설정).');
  } else {
    cfg.password = profile.password || '';
  }
  return cfg;
}

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
          stream.on('close', () => {
            meta.closed = true;
            handlers.onExit(sessionId);
            try {
              client.end();
            } catch (e) {
              /* noop */
            }
            sessions.delete(sessionId);
          });
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

function write(sessionId, data) {
  const s = sessions.get(sessionId);
  if (s && s.stream) s.stream.write(data);
}

function resize(sessionId, cols, rows) {
  const s = sessions.get(sessionId);
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
    if (s.stream) s.stream.end();
    s.client.end();
  } catch (e) {
    /* noop */
  }
  sessions.delete(sessionId);
}

function closeAll() {
  for (const id of Array.from(sessions.keys())) close(id);
}

module.exports = { open, write, resize, close, closeAll };
