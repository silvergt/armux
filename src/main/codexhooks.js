'use strict';

/**
 * Codex 가 "턴을 끝냈다 / 승인을 기다린다" 를 우리 터미널에 알리게 만든다.
 *
 * codex 는 config.toml 의 `notify` 항목에 적힌 프로그램을 이벤트마다 실행한다.
 * 마지막 인자로 JSON 을 하나 넘겨 주는데, 우리가 쓰는 종류는 세 가지다.
 *   agent-turn-complete → 작업 완료   → idle  (초록 느낌표)
 *   approval-request    → 승인 대기   → alert
 *   plan-mode-prompt    → 사용자 확인 → alert
 *
 * 알림을 터미널로 흘리는 방법(조상 프로세스의 tty 를 찾아 OSC 를 쓰는 것)은
 * Claude 쪽과 똑같으므로 ~/.armux/notify.sh 를 그대로 다시 쓴다.
 * 그래서 이 모듈은 claudehooks 의 notify.sh 설치에 기대고 있다.
 *
 * config.toml 은 TOML 이라 "맨 위(첫 [테이블] 앞)" 에 넣어야 최상위 키가 된다.
 * 끝에 붙이면 마지막 테이블의 하위 키가 되어 버린다.
 */

const ssh = require('./ssh');
const claudehooks = require('./claudehooks');

const MARKER = 'armux'; // 우리가 넣은 notify 인지 알아보는 표시(경로에 들어 있다)

/** codex 가 부를 알림 스크립트 (POSIX sh). JSON 을 보고 상태만 골라 넘긴다. */
function codexNotifyScript() {
  return `#!/bin/sh
# Armux 상태 알림 — codex 의 notify 가 호출한다. (자동 생성 파일)
# 마지막 인자가 이벤트 JSON 이다.
J=""
for a in "$@"; do J="$a"; done
[ -n "$J" ] || exit 0

# 공백을 없애 "type": "x" 와 "type":"x" 를 같이 잡는다
C=$(printf '%s' "$J" | tr -d ' \\t\\n')
case "$C" in
  *'"type":"agent-turn-complete"'*) S=idle ;;
  *'"type":"approval-request"'*)    S=alert ;;
  *'"type":"plan-mode-prompt"'*)    S=alert ;;
  *) exit 0 ;;
esac

[ -f "$HOME/.armux/notify.sh" ] || exit 0
sh "$HOME/.armux/notify.sh" "$S"
exit 0
`;
}

/**
 * 설치 스크립트 (POSIX sh).
 * node 없이 동작해야 한다 — codex 만 쓰는 서버에는 node 가 없을 수 있다.
 */
function buildInstallScript() {
  const b64 = Buffer.from(codexNotifyScript(), 'utf8').toString('base64');
  // 터미널로 신호를 쏘는 notify.sh 는 Claude 쪽과 공용이다. 다만 그쪽 설치는
  // node 를 쓰므로, codex 만 있고 node 가 없는 서버를 위해 여기서도 심는다.
  const nb64 = Buffer.from(claudehooks.notifyScript(), 'utf8').toString('base64');
  return `
set -e
mkdir -p "$HOME/.armux" "$HOME/.codex"
DEC() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 --decode 2>/dev/null; }

# 1) 알림 스크립트 설치 (codex 전용 + 터미널로 쏘는 공용 스크립트)
DEC ${b64} > "$HOME/.armux/codex-notify.sh"
chmod 755 "$HOME/.armux/codex-notify.sh" 2>/dev/null || true
DEC ${nb64} > "$HOME/.armux/notify.sh"
chmod 755 "$HOME/.armux/notify.sh" 2>/dev/null || true

# 2) config.toml 의 최상위에 notify 넣기
CFG="$HOME/.codex/config.toml"
[ -f "$CFG" ] || : > "$CFG"
[ -f "$CFG.armux-backup" ] || cp "$CFG" "$CFG.armux-backup" 2>/dev/null || true

# 첫 [테이블] 앞(=최상위)에 이미 notify 가 있는지 본다
EXIST=$(awk 'BEGIN{t=0} /^[[:space:]]*\\[/{t=1} (!t && /^[[:space:]]*notify[[:space:]]*=/){print}' "$CFG")
case "$EXIST" in
  '')        ;;                                    # 없음 — 넣는다
  *${MARKER}*) ;;                                  # 우리가 넣은 것 — 새로 쓴다
  *) echo 'ARMUX_CODEX_HOOKS:foreign-notify'; exit 0 ;;  # 남의 설정은 건드리지 않는다
esac

LINE='notify = ["sh", "'"$HOME"'/.armux/codex-notify.sh"]'
awk -v line="$LINE" 'BEGIN{t=0; print line}
  /^[[:space:]]*\\[/{t=1}
  (!t && /^[[:space:]]*notify[[:space:]]*=/){next}
  {print}
' "$CFG" > "$CFG.armux-tmp" && mv "$CFG.armux-tmp" "$CFG"
echo 'ARMUX_CODEX_HOOKS:installed'
`.trim();
}

const UNINSTALL = `
CFG="$HOME/.codex/config.toml"
[ -f "$CFG" ] || exit 0
awk 'BEGIN{t=0}
  /^[[:space:]]*\\[/{t=1}
  (!t && /^[[:space:]]*notify[[:space:]]*=/ && /armux/){next}
  {print}
' "$CFG" > "$CFG.armux-tmp" && mv "$CFG.armux-tmp" "$CFG"
rm -f "$HOME/.armux/codex-notify.sh"
echo 'ARMUX_CODEX_HOOKS:removed'
`.trim();

/** base64 로 감싸 따옴표 충돌 없이 원격 sh 로 실행 */
async function runRemoteSh(sessionId, script, timeoutMs = 15000) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const remote = `S=${b64}; { printf %s "$S" | base64 -d 2>/dev/null || printf %s "$S" | base64 --decode 2>/dev/null; } | sh`;
  return ssh.exec(sessionId, remote, timeoutMs);
}

/** 살아 있는 세션에 codex 알림을 설치한다. */
async function install(sessionId) {
  const { stdout } = await runRemoteSh(sessionId, buildInstallScript());
  const out = String(stdout);
  if (out.includes('ARMUX_CODEX_HOOKS:installed')) return true;
  // 사용자가 이미 자기 notify 를 쓰고 있으면 손대지 않는다
  return false;
}

/** config.toml 에서 우리 notify 만 뺀다. */
async function uninstall(sessionId) {
  const { stdout } = await runRemoteSh(sessionId, UNINSTALL);
  return String(stdout).includes('ARMUX_CODEX_HOOKS:removed');
}

module.exports = { install, uninstall, MARKER, buildInstallScript, UNINSTALL };
