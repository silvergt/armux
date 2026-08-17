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
    keepaliveInterval: 20000, // NAT/방화벽 타임아웃 방지
    keepaliveCountMax: 6,
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
