'use strict';

/**
 * Claude 상태를 화면 추측이 아니라 "Claude Code 훅"으로 정확히 받아온다.
 *
 * 원격 서버의 ~/.claude/settings.json 에 훅을 심어(비파괴적 병합),
 * Claude 가 작업을 시작/끝내거나 입력을 기다릴 때 제어 터미널(/dev/tty)로
 * 우리만 아는 OSC 시퀀스를 쏘게 한다. 그 시퀀스는 PTY 를 통해 우리 xterm 으로
 * 흘러 들어오고, 앱이 그것을 받아 스피너/느낌표 상태를 정확히 정한다.
 *
 * - UserPromptSubmit → busy  (작업 시작)
 * - Stop             → idle  (응답 완료)
 * - Notification     → alert (입력/권한 대기)
 *
 * 주의: Claude 는 시작할 때 settings.json 을 읽으므로, 이미 실행 중인 Claude 에는
 * 다음 실행부터 적용된다. node 는 Claude Code 를 돌리는 서버라면 반드시 있으므로
 * 병합도 node 로 한다(잠금·JSON 처리 안전).
 */

const ssh = require('./ssh');

const MARKER = 'armux-status'; // 우리 훅을 식별하는 표시
const OSC = 6789; // 우리 전용 OSC 번호

/** 원격에서 실행할 병합 스크립트 (node 소스). settings.json 을 안전하게 병합한다. */
function buildMergeScript() {
  // 훅 명령: /dev/tty 로 OSC 를 쏜다. printf 의 8진 이스케이프 사용.
  const cmd = (state) =>
    `printf '\\033]${OSC};${MARKER};${state}\\007' >/dev/tty 2>/dev/null; exit 0`;

  return `
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = path.join(os.homedir(), '.claude');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'settings.json');
let raw = '';
try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { raw = ''; }
let s = {};
if (raw.trim()) {
  try { s = JSON.parse(raw); }
  catch (e) { console.log('ARMUX_HOOKS:parse-error'); process.exit(0); } // 이상하면 건드리지 않음
}
// 처음 손댈 때 한 번 백업
const backup = file + '.armux-backup';
if (raw.trim() && !fs.existsSync(backup)) { try { fs.writeFileSync(backup, raw); } catch (e) {} }

s.hooks = s.hooks || {};
const MARK = ${JSON.stringify(MARKER)};
const entries = {
  UserPromptSubmit: ${JSON.stringify(cmd('busy'))},
  Stop: ${JSON.stringify(cmd('idle'))},
  Notification: ${JSON.stringify(cmd('alert'))}
};
for (const ev of Object.keys(entries)) {
  const list = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
  // 우리가 예전에 넣은 것만 제거(사용자 훅은 보존)
  const kept = list.filter((g) => JSON.stringify(g).indexOf(MARK) === -1);
  kept.push({ matcher: '', hooks: [{ type: 'command', command: entries[ev] }] });
  s.hooks[ev] = kept;
}
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('ARMUX_HOOKS:installed');
`.trim();
}

/** 살아 있는 세션에 훅을 설치(병합)한다. */
async function install(sessionId) {
  const b64 = Buffer.from(buildMergeScript(), 'utf8').toString('base64');
  // b64 는 안전한 문자만 있으므로 따옴표 충돌이 없다
  const remote = `ARMUX_HK=${b64} node -e 'eval(Buffer.from(process.env.ARMUX_HK,"base64").toString("utf8"))'`;
  const { stdout } = await ssh.exec(sessionId, remote, 15000);
  return String(stdout).includes('ARMUX_HOOKS:installed');
}

/** ~/.claude/settings.json 에서 우리 훅만 제거한다. */
async function uninstall(sessionId) {
  const script = `
const fs=require('fs'),os=require('os'),path=require('path');
const file=path.join(os.homedir(),'.claude','settings.json');
let s={}; try{ s=JSON.parse(fs.readFileSync(file,'utf8')); }catch(e){ process.exit(0); }
if(!s.hooks){ process.exit(0); }
const MARK=${JSON.stringify(MARKER)};
for(const ev of Object.keys(s.hooks)){
  if(Array.isArray(s.hooks[ev])) s.hooks[ev]=s.hooks[ev].filter(g=>JSON.stringify(g).indexOf(MARK)===-1);
  if(!s.hooks[ev].length) delete s.hooks[ev];
}
fs.writeFileSync(file, JSON.stringify(s,null,2));
console.log('ARMUX_HOOKS:removed');
`.trim();
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const remote = `ARMUX_HK=${b64} node -e 'eval(Buffer.from(process.env.ARMUX_HK,"base64").toString("utf8"))'`;
  const { stdout } = await ssh.exec(sessionId, remote, 15000);
  return String(stdout).includes('ARMUX_HOOKS:removed');
}

module.exports = { install, uninstall, OSC, MARKER };
