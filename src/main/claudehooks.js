'use strict';

/**
 * Claude 상태를 화면 추측이 아니라 "Claude Code 훅"으로 정확히 받아온다.
 *
 * 원격 서버의 ~/.claude/settings.json 에 훅을 심어(비파괴적 병합),
 * Claude 가 작업을 시작/끝내거나 입력을 기다릴 때 터미널로 우리만 아는 OSC
 * 시퀀스를 쏘게 한다. 그 시퀀스는 PTY 를 통해 우리 xterm 으로 흘러 들어오고,
 * 앱이 그것을 받아 스피너/느낌표 상태를 정확히 정한다.
 *
 * 중요: Claude Code 는 훅을 "제어 터미널이 없는" 자식 프로세스로 실행한다.
 * (stdin=소켓, stdout=파이프, `tty` → not a tty) 그래서 예전처럼 /dev/tty 로
 * 쓰면 조용히 실패해서 아이콘이 전혀 바뀌지 않았다. 대신 조상 프로세스를 거슬러
 * 올라가 Claude 본체의 터미널 장치(/dev/pts/N 등)를 찾아 그리로 직접 쓴다.
 * 그 로직은 원격에 설치하는 ~/.armux/notify.sh 안에 들어 있다.
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

const NOTIFY_PATH = '$HOME/.armux/notify.sh'; // 원격에 설치할 알림 스크립트

/**
 * 원격에 설치할 알림 스크립트(POSIX sh).
 *
 * 훅 프로세스에는 제어 터미널이 없어 /dev/tty 가 열리지 않는다. 그래서 부모부터
 * 조상 쪽으로 거슬러 올라가며 실제 터미널 장치를 찾아 그리로 OSC 를 쓴다.
 *   - 리눅스: /proc/<pid>/fd/1 이 가리키는 /dev/pts/N
 *   - 그 외(맥 등): ps -o tty= 결과를 /dev/... 경로로 바꿔 쓴다 (맥은 s012 → /dev/ttys012)
 * tmux 안이면 tmux 가 모르는 OSC 를 삼키므로 passthrough(ESC Ptmux; …)로 감싼다.
 */
function notifyScript() {
  return `#!/bin/sh
# Armux 상태 알림 — Claude Code 훅이 호출한다. (자동 생성 파일)
S="$1"
[ -n "$S" ] || exit 0

find_tty() {
  P="$PPID"
  i=0
  while [ -n "$P" ] && [ "$i" -lt 8 ]; do
    if [ -r "/proc/$P/fd/1" ] || [ -e "/proc/$P/fd/1" ]; then
      D=$(readlink "/proc/$P/fd/1" 2>/dev/null)
      case "$D" in
        /dev/pts/*|/dev/tty*) echo "$D"; return 0 ;;
      esac
    fi
    T=$(ps -o tty= -p "$P" 2>/dev/null | tr -d ' ')
    case "$T" in
      ''|'?'|'??')      ;;
      /dev/*)   echo "$T";        return 0 ;;
      pts/*)    echo "/dev/$T";   return 0 ;;
      tty*)     echo "/dev/$T";   return 0 ;;
      s[0-9]*)  echo "/dev/tty$T"; return 0 ;;
    esac
    P=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
  return 1
}

T=$(find_tty 2>/dev/null) || T=""
[ -n "$T" ] && [ -w "$T" ] || T=/dev/tty

if [ -n "$TMUX" ]; then
  # tmux 3.3+ 는 passthrough 가 기본 off 라 켜 준다("all" 이면 안 보이는 창에서도 통과).
  # -t 로 대상을 반드시 명시한다. 빼면 "지금 보이는 창" 에 걸려서, 다른 창에서 돌던
  # Claude 의 신호가 그 창에서는 계속 off 인 채로 tmux 에 삼켜진다.
  if [ -n "$TMUX_PANE" ]; then
    tmux set -p -t "$TMUX_PANE" allow-passthrough all >/dev/null 2>&1 ||
      tmux set -p -t "$TMUX_PANE" allow-passthrough on >/dev/null 2>&1
  else
    tmux set -p allow-passthrough all >/dev/null 2>&1 ||
      tmux set -p allow-passthrough on >/dev/null 2>&1
  fi
  # 래핑 안에서는 ESC 를 두 번 써야 tmux 가 한 번 벗겨서 바깥으로 내보낸다.
  # 상태 뒤에 pane 이름표($TMUX_PANE, 예: %3)를 붙인다 — 창마다 상태를 따로 들기 위해.
  printf '\\033Ptmux;\\033\\033]${OSC};${MARKER};%s;%s\\007\\033\\\\' "$S" "$TMUX_PANE" > "$T" 2>/dev/null
else
  printf '\\033]${OSC};${MARKER};%s;\\007' "$S" > "$T" 2>/dev/null
fi
exit 0
`;
}

/** 원격에서 실행할 설치 스크립트 (node 소스). 알림 스크립트를 쓰고 settings.json 을 병합한다. */
function buildMergeScript() {
  // 훅은 알림 스크립트만 부른다(설정 파일을 짧고 읽기 쉽게 유지).
  const cmd = (state) => `sh ${NOTIFY_PATH} ${state}`;

  return `
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1) 알림 스크립트 설치
const adir = path.join(os.homedir(), '.armux');
fs.mkdirSync(adir, { recursive: true });
const notify = path.join(adir, 'notify.sh');
fs.writeFileSync(notify, Buffer.from(${JSON.stringify(
    Buffer.from(notifyScript(), 'utf8').toString('base64')
  )}, 'base64').toString('utf8'));
try { fs.chmodSync(notify, 0o755); } catch (e) {}

// 2) settings.json 에 훅 병합
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
  // 우리가 예전에 넣은 것만 제거(사용자 훅은 보존). 옛 버전은 /dev/tty 를 직접 썼다.
  const kept = list.filter((g) => {
    const t = JSON.stringify(g);
    return t.indexOf(MARK) === -1 && t.indexOf('armux/notify.sh') === -1;
  });
  kept.push({ matcher: '', hooks: [{ type: 'command', command: entries[ev] }] });
  s.hooks[ev] = kept;
}
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('ARMUX_HOOKS:installed');
`.trim();
}

/**
 * node 스크립트를 원격에서 실행한다.
 * SSH exec 채널은 비로그인 셸이라 nvm 등으로 설치한 node 가 PATH 에 없을 수
 * 있으므로, 로그인 셸(bash -l)로 돌리고 그래도 없으면 잘 알려진 위치를 뒤진다.
 */
async function runRemoteNode(sessionId, nodeScript, timeoutMs = 15000) {
  const b64 = Buffer.from(nodeScript, 'utf8').toString('base64');
  const shell = `
N="$(command -v node 2>/dev/null)"
if [ -z "$N" ]; then
  for c in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node "$HOME"/.local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && N="$c"
  done
fi
if [ -z "$N" ]; then echo ARMUX_HOOKS:no-node; exit 0; fi
ARMUX_HK=${b64} "$N" -e 'eval(Buffer.from(process.env.ARMUX_HK,"base64").toString("utf8"))'
`.trim();
  const sb64 = Buffer.from(shell, 'utf8').toString('base64');
  // base64 는 안전한 문자만 있으므로 따옴표 충돌이 없다. 디코드는 GNU(-d)/BSD(--decode)
  // 어느 쪽이든 되는 쪽 결과를 한 번만 bash -l 로 흘린다.
  const remote = `S=${sb64}; { printf %s "$S" | base64 -d 2>/dev/null || printf %s "$S" | base64 --decode 2>/dev/null; } | bash -l`;
  return ssh.exec(sessionId, remote, timeoutMs);
}

/** 살아 있는 세션에 훅을 설치(병합)한다. */
async function install(sessionId) {
  const { stdout } = await runRemoteNode(sessionId, buildMergeScript());
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
  if(Array.isArray(s.hooks[ev])) s.hooks[ev]=s.hooks[ev].filter(g=>{
    const t=JSON.stringify(g);
    return t.indexOf(MARK)===-1 && t.indexOf('armux/notify.sh')===-1;
  });
  if(!s.hooks[ev].length) delete s.hooks[ev];
}
try{ fs.unlinkSync(path.join(os.homedir(),'.armux','notify.sh')); }catch(e){}
fs.writeFileSync(file, JSON.stringify(s,null,2));
console.log('ARMUX_HOOKS:removed');
`.trim();
  const { stdout } = await runRemoteNode(sessionId, script);
  return String(stdout).includes('ARMUX_HOOKS:removed');
}

module.exports = { install, uninstall, OSC, MARKER, notifyScript };
