'use strict';

/**
 * 원격 서버에 로그인되어 있는 Codex(OpenAI) 계정 정보와 사용량을 읽어온다.
 *
 * Claude 와 달리 조회용 HTTP 엔드포인트를 직접 부르지 않는다. codex 는
 * `codex app-server` 라는 JSON-RPC(표준입출력) 서버를 갖고 있고, 그쪽에
 *   account/read           → 계정(이메일·요금제)
 *   account/rateLimits/read → 사용량(주기별 %)
 * 를 물어보면 된다. 토큰은 서버 밖으로 나오지 않는다.
 *
 * app-server 는 표준입력이 닫히면 답을 주기 전에 종료하므로, 답이 다 올
 * 때까지 입력을 열어 두었다가(임시 파일을 신호로) 바로 끊는다.
 */

const ssh = require('./ssh');

/** codex 실행 파일 찾기 (SSH exec 는 로그인 셸이 아닐 수 있다) */
const FIND_CODEX = [
  'CODEX="$(command -v codex 2>/dev/null)"',
  'if [ -z "$CODEX" ]; then',
  '  for c in "$HOME"/.local/bin/codex /usr/local/bin/codex /opt/homebrew/bin/codex "$HOME"/.codex/bin/codex; do',
  '    [ -x "$c" ] && CODEX="$c" && break',
  '  done',
  'fi'
].join('\n');

const PROBE = `
${FIND_CODEX}
if [ -z "$CODEX" ]; then echo 'ARMUX_CODEX:absent'; exit 0; fi
[ -f "$HOME/.codex/auth.json" ] || { echo 'ARMUX_CODEX:logged-out'; exit 0; }
M=$(mktemp 2>/dev/null || echo "$HOME/.armux-codex-probe.$$")
: > "$M"
{
  printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"armux","version":"1"}}}'
  printf '%s\\n' '{"jsonrpc":"2.0","method":"initialized","params":{}}'
  printf '%s\\n' '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}'
  printf '%s\\n' '{"jsonrpc":"2.0","id":3,"method":"account/read","params":{}}'
  i=0
  while [ $i -lt 20 ] && [ ! -s "$M" ]; do sleep 1; i=$((i+1)); done
} | timeout 30 "$CODEX" app-server 2>/dev/null | awk -v m="$M" '
  /"id":2/ { print; a=1 }
  /"id":3/ { print; b=1 }
  a && b { print "done" > m; close(m); exit }
'
rm -f "$M"
`.trim();

/** 사용량 창(window) 하나를 화면에서 쓰는 모양으로 */
function pickWindow(w) {
  if (!w || typeof w.usedPercent !== 'number') return null;
  return {
    pct: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
    // codex 는 초 단위 유닉스 시각을 준다. 화면 쪽은 Date 로 파싱하므로 ISO 로 맞춘다.
    resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
    windowMins: w.windowDurationMins || null
  };
}

/**
 * 응답 두 줄(JSON-RPC)에서 필요한 값만 뽑는다.
 * 사용량 창은 계정마다 다르게 온다(5시간짜리만 오기도, 주간만 오기도 한다).
 * 그래서 "창 길이" 로 세션/주간을 가른다 — 하루 이하면 세션, 그보다 길면 주간.
 */
function normalize(lines) {
  let limits = null;
  let account = null;
  for (const line of lines) {
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (!msg || !msg.result) continue;
    if (msg.id === 2) limits = msg.result;
    else if (msg.id === 3) account = msg.result;
  }
  if (!limits && !account) return { loggedIn: false };

  const acct = (account && account.account) || {};
  const rl = (limits && limits.rateLimits) || {};
  const windows = [pickWindow(rl.primary), pickWindow(rl.secondary)].filter(Boolean);

  let session = null;
  let week = null;
  for (const w of windows) {
    const isShort = w.windowMins != null && w.windowMins <= 1440; // 하루 이하 = 세션
    if (isShort && !session) session = w;
    else if (!isShort && !week) week = w;
    else if (!session) session = w;
    else if (!week) week = w;
  }

  const plan = acct.planType || rl.planType || null;
  return {
    loggedIn: Boolean(acct.email) || windows.length > 0,
    email: acct.email || '',
    plan: plan ? String(plan).replace(/_/g, ' ') : null,
    session,
    week,
    // 사용량은 왔는데 창이 하나도 없으면 "못 받아옴" 으로 본다
    usageFailed: windows.length === 0,
    credits:
      rl.credits && rl.credits.hasCredits
        ? { unlimited: Boolean(rl.credits.unlimited), balance: rl.credits.balance || null }
        : null
  };
}

/**
 * @param {string} sessionId 살아 있는 터미널 세션 (그 연결에 exec 채널을 하나 더 연다)
 */
async function fetchInfo(sessionId) {
  const { stdout } = await ssh.exec(sessionId, PROBE, 40000);
  const text = String(stdout || '');
  if (text.includes('ARMUX_CODEX:absent')) return { loggedIn: false, absent: true };
  if (text.includes('ARMUX_CODEX:logged-out')) return { loggedIn: false };
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  if (!lines.length) return { loggedIn: false, usageFailed: true };
  return normalize(lines);
}

module.exports = { fetchInfo, FIND_CODEX };
