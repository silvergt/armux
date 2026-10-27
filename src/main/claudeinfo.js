'use strict';

/**
 * 원격 서버에 로그인되어 있는 Claude Code 계정 정보와 사용량을 읽어온다.
 *
 * 토큰(~/.claude/.credentials.json)은 서버 밖으로 나오지 않는다.
 * 조회용 curl 을 "서버에서" 실행하고, 그 결과 JSON 만 받아온다.
 *
 * 맥의 Claude Code 는 토큰을 파일이 아니라 키체인("Claude Code-credentials")에
 * 둔다. 파일이 없으면 security 로 키체인에서 읽는다(맥 로컬 터미널·맥 서버).
 */

const ssh = require('./ssh');
const localusage = require('./localusage');

/** 서버에서 실행할 조회 스크립트 (POSIX sh, jq/python 없이 동작) */
const PROBE = [
  // 설정 폴더는 CLAUDE_CONFIG_DIR 로 옮길 수 있다 (옮겼는데 기본 자리만 보면 "로그인 안 됨" 이 된다)
  'D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
  'C="$D/.credentials.json"',
  'RAW=""',
  'if [ -f "$C" ]; then RAW=$(cat "$C"); ' +
    'elif command -v security >/dev/null 2>&1; then ' +
    'RAW=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null); fi',
  // 자격증명이 어디에도 없으면 로그인 안 된 상태 — 왜 그런지 구분해 둔다
  'if [ -z "$RAW" ]; then ' +
    'if command -v claude >/dev/null 2>&1 || [ -d "$D" ]; then R=no-credentials; else R=no-claude; fi; ' +
    'printf \'{"loggedIn":false,"reason":"%s","dir":"%s"}\\n\' "$R" "$D"; exit 0; fi',
  'TOK=$(printf "%s" "$RAW" | tr -d " \\n" | sed -n \'s/.*"accessToken":"\\([^"]*\\)".*/\\1/p\')',
  '[ -n "$TOK" ] || { echo \'{"loggedIn":false,"reason":"no-token"}\'; exit 0; }',
  // ~/.claude.json 에서 이메일만 뽑아둔다 (curl 이 없거나 실패할 때의 대비)
  'EMAIL=$(grep -o \'"emailAddress":"[^"]*"\' "$D/../.claude.json" "$HOME/.claude.json" 2>/dev/null | head -1 | sed \'s/.*:"//; s/"$//\')',
  'command -v curl >/dev/null 2>&1 || { printf \'{"loggedIn":true,"email":"%s","profile":null,"usage":null,"reason":"no-curl"}\\n\' "$EMAIL"; exit 0; }',
  'H1="Authorization: Bearer $TOK"',
  'H2="anthropic-beta: oauth-2025-04-20"',
  // 응답 본문과 함께 HTTP 상태도 받아 둔다 — 못 받았을 때 "왜" 를 말해 줄 수 있어야 한다
  'PF=$(mktemp 2>/dev/null || echo "$HOME/.armux-claude-p.$$")',
  'UF=$(mktemp 2>/dev/null || echo "$HOME/.armux-claude-u.$$")',
  'PC=$(curl -s -m 8 -o "$PF" -w "%{http_code}" -H "$H1" -H "$H2" https://api.anthropic.com/api/oauth/profile 2>/dev/null)',
  'UC=$(curl -s -m 8 -o "$UF" -w "%{http_code}" -H "$H1" -H "$H2" https://api.anthropic.com/api/oauth/usage 2>/dev/null)',
  'P=$(cat "$PF" 2>/dev/null); U=$(cat "$UF" 2>/dev/null); rm -f "$PF" "$UF"',
  '[ -n "$P" ] || P=null',
  '[ -n "$U" ] || U=null',
  '[ -n "$PC" ] || PC=0',
  '[ -n "$UC" ] || UC=0',
  'printf \'{"loggedIn":true,"email":"%s","profile":%s,"usage":%s,"profileCode":%s,"usageCode":%s}\\n\' "$EMAIL" "$P" "$U" "$PC" "$UC"'
].join('; ');

/** JSON 에서 원하는 값만 골라 렌더러가 쓰기 좋은 형태로 정리 */
function normalize(raw) {
  if (!raw || !raw.loggedIn) return { loggedIn: false, reason: (raw && raw.reason) || '', dir: (raw && raw.dir) || '' };

  const profile = raw.profile || {};
  const account = profile.account || {};
  const org = profile.organization || {};
  const usage = raw.usage || {};
  // 사용량 엔드포인트는 호출이 잦으면 429(rate_limit_error)를 준다.
  // "제한에 걸림" 과 "그 밖의 이유로 못 받아옴" 은 대처가 다르므로 구분해서 알린다.
  const errType = usage && usage.error ? String(usage.error.type || '') : '';
  const rateLimited = errType.includes('rate_limit');
  const usageFailed = Boolean(usage && usage.error) || !raw.usage;

  /*
   * 사용량을 못 받은 이유. 화면에 "조회 불가" 라고만 뜨면 손쓸 방법을 알 수 없어서,
   * 무엇 때문인지 한 줄로 알려 준다.
   *   - HTTP 상태(401 토큰 만료 · 403 권한 없음 · 429 호출 제한 · 0 접속 불가)
   *   - 응답은 왔는데 사용량 항목이 없는 경우(팀·기업 계정에서 보인다)
   */
  let usageNote = '';
  if (usageFailed) {
    const code = Number(raw.usageCode || 0);
    if (raw.reason === 'no-curl') usageNote = '서버에 curl 이 없습니다';
    else if (code === 401) usageNote = '토큰이 만료됐습니다 (claude 로그인 다시)';
    else if (code === 403) usageNote = '이 계정은 사용량 조회 권한이 없습니다';
    else if (code === 429) usageNote = '조회 호출 제한';
    else if (code === 0) usageNote = 'api.anthropic.com 에 접속하지 못했습니다';
    else if (code >= 500) usageNote = `서버 오류 (HTTP ${code})`;
    else if (code && code !== 200) usageNote = `HTTP ${code}`;
  }

  const pick = (bucket) =>
    bucket && typeof bucket.utilization === 'number'
      ? { pct: Math.max(0, Math.min(100, Math.round(bucket.utilization))), resetsAt: bucket.resets_at || null }
      : null;

  let plan = null;
  if (account.has_claude_max) plan = 'Max';
  else if (account.has_claude_pro) plan = 'Pro';
  else if (org.organization_type) plan = String(org.organization_type).replace(/_/g, ' ');

  // 응답은 정상인데 사용량 칸이 하나도 없는 경우 (팀·기업 계정에서 보인다)
  const noBuckets = !usageFailed && !usage.five_hour && !usage.seven_day;

  return {
    loggedIn: true,
    rateLimited,
    usageFailed: usageFailed || noBuckets,
    usageNote: noBuckets ? '이 계정은 사용량을 알려 주지 않습니다 (팀·기업 계정)' : usageNote,
    usageError: usage && usage.error ? usage.error.message || '' : '',
    email: account.email || raw.email || '',
    name: account.display_name || account.full_name || '',
    plan,
    session: pick(usage.five_hour), // 5시간 세션 사용량
    week: pick(usage.seven_day), // 주간 사용량
    extra:
      usage.extra_usage && usage.extra_usage.is_enabled
        ? {
            pct: Math.round(usage.extra_usage.utilization || 0),
            used: usage.extra_usage.used_credits,
            limit: usage.extra_usage.monthly_limit
          }
        : null
  };
}

/**
 * @param {string} sessionId 살아 있는 터미널 세션 (그 연결에 exec 채널을 하나 더 연다)
 */
async function fetchInfo(sessionId) {
  // 윈도우 로컬 터미널에는 sh 가 없다 — 앱이 직접 조회한다
  if (process.platform === 'win32' && ssh.isLocal(sessionId)) return normalize(await localusage.claudeRaw());
  // curl 두 번(각 8초 상한) + 로그인 셸 시작까지 더하면 20초를 넘기는 서버가 있다.
  // 시간 초과로 던지면 화면에는 "정보 없음" 으로만 보이므로 넉넉히 준다.
  const { stdout } = await ssh.exec(sessionId, PROBE, 30000);
  // API 응답이 여러 줄로 정렬되어 올 수 있으므로 첫 '{' 부터 마지막 '}' 까지를 통째로 파싱한다
  const text = String(stdout);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { loggedIn: false, error: '응답이 비어 있습니다.' };
  let parsed = null;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { loggedIn: false, error: '응답을 해석하지 못했습니다.' };
  }
  return normalize(parsed);
}

module.exports = { fetchInfo };
