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
  const { stdout } = await ssh.exec(sessionId, PROBE, 20000);
  const line = String(stdout).trim().split('\n').pop();
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { loggedIn: false, error: '응답을 해석하지 못했습니다.' };
  }
  return normalize(parsed);
}

module.exports = { fetchInfo };
