'use strict';

/**
 * 빌드 시각/버전/커밋을 src/buildinfo.json 에 기록한다.
 * "정보 > 버전" 창에서 보여 주고, 업데이트 확인에도 쓴다.
 * dist 스크립트들이 실행 전에 자동으로 호출한다.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch (e) {
  commit = '';
}

const info = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  commit
};

const out = path.join(root, 'src', 'buildinfo.json');
fs.writeFileSync(out, JSON.stringify(info, null, 2), 'utf8');
console.log('buildinfo:', JSON.stringify(info));
