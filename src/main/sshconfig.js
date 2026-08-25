'use strict';

/** 프로필 → ssh2 접속 옵션 변환. 셸 세션(ssh.js)과 SFTP(sftp.js) 가 함께 쓴다. */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** authType === 'key' 인데 경로를 안 준 경우 흔한 기본 키를 순서대로 찾는다 */
function findDefaultKey() {
  const dir = path.join(os.homedir(), '.ssh');
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** '~/.ssh/id_rsa' 의 ~ 를 홈 디렉토리로 확장 */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function buildConnectConfig(profile) {
  const cfg = {
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    /*
     * 살아 있다고 봐 주는 시간 = keepaliveInterval × (keepaliveCountMax + 1).
     *
     * 20초 × 7 = 2분 20초였는데, 인터넷이 그보다 조금만 오래 끊겨도 세션이
     * 죽었다(실측으로 130초는 살아남고 140.4초에 "Keepalive timeout").
     * SSH 는 끊긴 뒤에 같은 셸로 돌아갈 방법이 없으므로, 애초에 안 끊기는 것이
     * 가장 좋다. 그래서 유예를 10분으로 늘렸다.
     *
     * 막힌 동안 못 간 것은 TCP 가 알아서 다시 보내므로, 인터넷이 돌아오면
     * 재접속이 아니라 하던 작업이 그대로 이어진다.
     *
     * 대신 서버가 응답 없이 사라진 경우(FIN/RST 조차 못 받는 경우)에는 그만큼
     * 늦게 알아차린다. 그건 renderer 의 자동 재접속이 이어받는다.
     */
    keepaliveInterval: 20000, // NAT/방화벽 타임아웃 방지도 겸한다
    keepaliveCountMax: 30, // 20초 × 31 ≈ 10분
    readyTimeout: 30000,
    tryKeyboard: true
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

module.exports = { buildConnectConfig, findDefaultKey, expandHome };
