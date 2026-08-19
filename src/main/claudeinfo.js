'use strict';

/**
 * 원격 서버에 로그인되어 있는 Claude Code 계정 정보와 사용량을 읽어온다.
 *
 * 토큰(~/.claude/.credentials.json)은 서버 밖으로 나오지 않는다.
 * 조회용 curl 을 "서버에서" 실행하고, 그 결과 JSON 만 받아온다.
 */

const ssh = require('./ssh');

/** 서버에서 실행할 조회 스크립트 (POSIX sh, jq/python 없이 동작) */
const PROBE = [
  'C="$HOME/.claude/.credentials.json"',
  // 자격증명 파일이 없으면 로그인 안 된 상태
  '[ -f "$C" ] || { echo \'{"loggedIn":false}\'; exit 0; }',
  'TOK=$(tr -d " \\n" < "$C" | sed -n \'s/.*"accessToken":"\\([^"]*\\)".*/\\1/p\')',
  '[ -n "$TOK" ] || { echo \'{"loggedIn":false}\'; exit 0; }',
  // ~/.claude.json 에서 이메일만 뽑아둔다 (curl 이 없거나 실패할 때의 대비)
  'EMAIL=$(grep -o \'"emailAddress":"[^"]*"\' "$HOME/.claude.json" 2>/dev/null | head -1 | sed \'s/.*:"//; s/"$//\')',
  'command -v curl >/dev/null 2>&1 || { printf \'{"loggedIn":true,"email":"%s","profile":null,"usage":null}\\n\' "$EMAIL"; exit 0; }',
  'H1="Authorization: Bearer $TOK"',
  'H2="anthropic-beta: oauth-2025-04-20"',
  'P=$(curl -s -m 8 -H "$H1" -H "$H2" https://api.anthropic.com/api/oauth/profile 2>/dev/null)',
  'U=$(curl -s -m 8 -H "$H1" -H "$H2" https://api.anthropic.com/api/oauth/usage 2>/dev/null)',
  '[ -n "$P" ] || P=null',
  '[ -n "$U" ] || U=null',
  'printf \'{"loggedIn":true,"email":"%s","profile":%s,"usage":%s}\\n\' "$EMAIL" "$P" "$U"'
].join('; ');

/** JSON 에서 원하는 값만 골라 렌더러가 쓰기 좋은 형태로 정리 */
function normalize(raw) {
  if (!raw || !raw.loggedIn) return { loggedIn: false };

  const profile = raw.profile || {};
  const account = profile.account || {};
  const org = profile.organization || {};
  const usage = raw.usage || {};
  // 사용량 엔드포인트는 호출이 잦으면 429(rate_limit_error)를 준다.
  // "제한에 걸림" 과 "그 밖의 이유로 못 받아옴" 은 대처가 다르므로 구분해서 알린다.
  const errType = usage && usage.error ? String(usage.error.type || '') : '';
  const rateLimited = errType.includes('rate_limit');
  const usageFailed = Boolean(usage && usage.error) || !raw.usage;

  const pick = (bucket) =>
    bucket && typeof bucket.utilization === 'number'
      ? { pct: Math.max(0, Math.min(100, Math.round(bucket.utilization))), resetsAt: bucket.resets_at || null }
      : null;

  let plan = null;
  if (account.has_claude_max) plan = 'Max';
  else if (account.has_claude_pro) plan = 'Pro';
  else if (org.organization_type) plan = String(org.organization_type).replace(/_/g, ' ');

  return {
    loggedIn: true,
    rateLimited,
    usageFailed,
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
