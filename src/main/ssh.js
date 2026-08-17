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
