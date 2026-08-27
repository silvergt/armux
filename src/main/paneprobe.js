'use strict';

/**
 * 판 상태 관찰기 — "이 판에서 지금 무엇이 돌고 있는가" 를 서버에 직접 물어본다.
 *
 * 왜 이렇게 하는가
 * ----------------
 * 예전에는 화면을 읽어 추측하거나(스크래핑), 훅이 쏘는 신호 하나에만 의존했다.
 * 둘 다 "바뀌는 순간" 을 잡는 방식(엣지 트리거)이라, 한 번 놓치면 다음 신호가
 * 올 때까지 계속 틀린 상태로 남았다. 특히 tmux 는 창을 전환할 때 자기 버퍼에서
 * 글자만 다시 그리고 지나간 시퀀스를 다시 쏘지 않기 때문에, 창을 옮기는 순간
 * 앱이 들고 있는 상태와 화면이 어긋났다.
 *
 * 그래서 방향을 뒤집었다. 상태를 "언제든 읽을 수 있는 값" 으로 두고(레벨 트리거)
 * 주기적으로 물어본다. 무엇을 놓치든 한 틱 뒤에는 맞춰지므로, 틀린 상태의
 * 수명에 상한이 생긴다. 훅(OSC 6789)은 없애지 않고 체감 속도를 위해 그대로 둔다.
 *
 * 어떻게 이 판의 원격 tty 를 아는가
 * ---------------------------------
 * exec 채널과 셸 채널은 같은 SSH 연결(= 같은 sshd) 위에 있다. 그래서 조상 쪽으로
 * 거슬러 올라가 sshd 를 찾고, 그 sshd 의 자식 중 pts 를 가진 것을 고르면 그것이
 * 이 판의 터미널이다. 세션 1개 = Client 1개 = 셸 1개라 pts 도 하나뿐이다.
 *
 * tty 를 알면 나머지는 그냥 조회다.
 *   - 그 tty 가 tmux 클라이언트인가?  → `tmux list-clients` 의 client_tty 와 대조
 *   - tmux 안이면 그 세션의 모든 창 상태 → `tmux list-panes -s`
 *   - tmux 밖이면 그 tty 의 포그라운드 → `ps -t <tty>` 에서 STAT 에 '+' 가 붙은 것
 * 창 전환도, tmux 에서 나가는 것도 다음 틱에 저절로 반영된다.
 */

const ssh = require('./ssh');

const INTERVAL_SEC = 2; // 폴링 주기(초). 사람 눈에는 충분하고 서버에는 거의 공짜다.
const CHANNEL_MS = 60 * 60 * 1000; // exec 채널 수명. 끝나면 알아서 다시 연다.
const RESTART_MS = 3000; // 채널이 끊겼을 때 다시 열기까지

const probes = new Map(); // sessionId -> { stopped, timer, onState }

/**
 * 서버에서 돌 관찰 스크립트(POSIX sh).
 * 한 틱마다 아래 형식의 블록 하나를 뱉는다. 줄 앞 글자 하나가 종류다.
 *   B                                          블록 시작
 *   M tmux <세션이름>  |  M direct              이 판이 지금 무엇을 보고 있는지
 *   P <pane> <창번호> <보임0/1> <tty> <명령>     창 하나 (tmux 밖이면 #direct 하나)
 *   A <tty> <명령줄 전체>                        그 tty 포그라운드(그룹 대표)의 argv
 *   K <tty> <이름1> <이름2> …                   대표부터 내려간 자식 사슬
 *   E                                          블록 끝
 */
function script() {
  return `
sshd_pid() {
  p=$PPID
  i=0
  while [ -n "$p" ] && [ "$p" != 1 ] && [ "$i" -lt 8 ]; do
    n=$(ps -o comm= -p "$p" 2>/dev/null | tr -d ' ')
    case "$n" in
      sshd|sshd-session) echo "$p"; return 0 ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
  return 1
}

# 이 SSH 연결의 sshd 아래에서 pts 를 가진 자식 = 이 판의 셸. "<pid> <tty>" 를 준다.
find_shell() {
  s=$(sshd_pid) || return 1
  ps -A -o pid=,ppid=,tty= 2>/dev/null |
    awk -v p="$s" '$2 == p && $3 ~ /^(pts|ttys)/ { print $1, $3; exit }'
}

# 셸 pid 목록("<tty> <pid>" 줄들)을 받아, 각 tty 의 포그라운드 상태를 뱉는다.
#
# ps 로 전체 프로세스를 훑으면 이 서버 기준 17ms 가 걸린다(2초마다면 CPU 1.3%).
# /proc 을 직접 읽으면 0.5ms 다. 셸의 /proc/<pid>/stat 6번째 값(괄호 뒤 기준)이
# 그 터미널의 포그라운드 프로세스 그룹(tpgid)이고, 그룹 대표의 pid 와 같으므로
# /proc/<tpgid>/cmdline 을 그대로 읽으면 된다.
#
# 대표만으로는 부족한 경우가 있어 자식 사슬도 함께 보낸다.
#   git log   → 대표는 git 인데 화면을 잡고 있는 것은 자식 pager 다
#   sudo -i   → 대표는 sudo 인데 실제로는 그 아래 bash 가 프롬프트를 띄우고 있다
# /proc/<pid>/task/<pid>/children 을 따라 다섯 단계까지 이름을 모은다. 이 파일이
# 없는 커널이면 대표 하나만 담기고, 예전과 같은 판정으로 돌아간다.
args_via_proc() {
  awk '{
    f = "/proc/" $2 "/stat"
    if ((getline line < f) <= 0) next
    close(f)
    n = index(line, ") ")
    split(substr(line, n + 2), a, " ")
    g = a[6] + 0
    if (g <= 0) next
    chain = ""
    p = g
    for (i = 0; i < 5 && p > 0; i++) {
      cf = "/proc/" p "/comm"
      if ((getline c < cf) <= 0) { close(cf); break }
      close(cf)
      chain = chain " " c
      kf = "/proc/" p "/task/" p "/children"
      kids = ""
      if ((getline kids < kf) <= 0) { close(kf); break }
      close(kf)
      split(kids, k, " ")
      p = (k[1] == "") ? 0 : k[1] + 0
    }
    print $1, g, chain
  }' | while read -r T G REST; do
    printf 'A %s ' "$T"
    tr '\\0' ' ' < "/proc/$G/cmdline" 2>/dev/null
    echo
    [ -n "$REST" ] && echo "K $T $REST"
  done
}

# /proc 이 없는 서버(맥 등)용 폴백. 느리지만 결과는 같다.
args_via_ps() {
  L=$(cut -d' ' -f1 | sed 's|/dev/||' | tr '\\n' ',' | sed 's/,$//')
  [ -n "$L" ] || return 0
  ps -t "$L" -o tty=,stat=,args= 2>/dev/null |
    awk '$2 ~ /\\+/ { t = $1; $1 = ""; $2 = ""; sub(/^  */, ""); print "A /dev/" t " " $0 }'
}

if [ -r /proc/self/stat ]; then USE_PROC=1; else USE_PROC=0; fi

SH=$(find_shell 2>/dev/null)
SHPID=\${SH%% *}
TTY=\${SH##* }

while :; do
  if [ -z "$TTY" ] || [ -z "$SHPID" ]; then
    SH=$(find_shell 2>/dev/null); SHPID=\${SH%% *}; TTY=\${SH##* }
  fi
  SESS=""
  if [ -n "$TTY" ]; then
    SESS=$(tmux list-clients -F '#{client_tty} #{session_name}' 2>/dev/null |
      awk -v t="/dev/$TTY" '$1 == t { print $2; exit }')
  fi
  echo B
  if [ -n "$SESS" ]; then
    echo "M tmux $SESS"
    # 창 목록과 "tty pid" 짝을 한 번의 조회로 같이 얻는다
    PANES=$(tmux list-panes -s -t "$SESS" \
      -F '#{pane_id} #{window_index} #{window_active} #{pane_tty} #{pane_pid} #{pane_current_command}' 2>/dev/null)
    echo "$PANES" | awk 'NF >= 6 { c = $6; for (i = 7; i <= NF; i++) c = c " " $i; print "P", $1, $2, $3, $4, c }'
    if [ "$USE_PROC" = 1 ]; then
      echo "$PANES" | awk 'NF >= 5 { print $4, $5 }' | args_via_proc
    else
      echo "$PANES" | awk 'NF >= 4 { print $4 }' | args_via_ps
    fi
  else
    echo "M direct"
    if [ -n "$TTY" ]; then
      if [ "$USE_PROC" = 1 ]; then
        G=$(awk '{ n = index($0, ") "); split(substr($0, n + 2), a, " "); print a[6] }' \
          "/proc/$SHPID/stat" 2>/dev/null)
        C=$(cat "/proc/$G/comm" 2>/dev/null)
        echo "P #direct - 1 /dev/$TTY $C"
        echo "/dev/$TTY $SHPID" | args_via_proc
      else
        C=$(ps -t "$TTY" -o stat=,comm= 2>/dev/null | awk '$1 ~ /\\+/ { print $2 }' | tail -1)
        echo "P #direct - 1 /dev/$TTY $C"
        echo "/dev/$TTY" | args_via_ps
      fi
    fi
  fi
  echo E
  sleep ${INTERVAL_SEC}
done
`;
}

/** 한 블록(B…E)을 상태 객체로 바꾼다. */
function parseBlock(lines) {
  const out = { mode: 'unknown', session: '', panes: [], args: {}, chains: {} };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line[0];
    const rest = line.slice(2);
    if (kind === 'M') {
      const [mode, ...name] = rest.split(' ');
      out.mode = mode === 'tmux' ? 'tmux' : 'direct';
      out.session = name.join(' ');
    } else if (kind === 'P') {
      // "%3 1 0 /dev/pts/26 python3"
      //  pane 이름표 / 창번호 / 그 창이 보이는지 / 그 창의 tty / 돌고 있는 명령
      const p = rest.split(' ');
      if (p.length >= 5) {
        out.panes.push({
          id: p[0],
          win: p[1],
          visible: p[2] === '1',
          tty: p[3],
          cmd: p.slice(4).join(' ')
        });
      }
    } else if (kind === 'A') {
      // "/dev/pts/26 python3 -c import time;..." — 그 tty 포그라운드의 명령줄 전체
      const sp = rest.indexOf(' ');
      if (sp > 0) out.args[rest.slice(0, sp)] = rest.slice(sp + 1);
    } else if (kind === 'K') {
      // "/dev/pts/26 git pager" — 대표부터 내려간 자식 사슬
      const k = rest.split(/\s+/).filter(Boolean);
      if (k.length >= 2) out.chains[k[0]] = k.slice(1);
    }
  }
  // 창마다 명령줄과 자식 사슬을 붙여 준다 (없으면 빈 값)
  for (const pane of out.panes) {
    pane.argv = out.args[pane.tty] || '';
    pane.chain = out.chains[pane.tty] || [];
  }
  delete out.args;
  delete out.chains;
  return out;
}

/**
 * 세션 하나에 관찰기를 붙인다.
 * @param {string} sessionId
 * @param {(id: string, state: object) => void} onState 한 틱마다 호출
 */
function start(sessionId, onState) {
  if (probes.has(sessionId)) return;
  const p = { stopped: false, timer: null, onState };
  probes.set(sessionId, p);
  run(sessionId);
}

function run(sessionId) {
  const p = probes.get(sessionId);
  if (!p || p.stopped) return;

  let buf = '';
  let cur = null;

  const onData = (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (t === 'B') {
        cur = [];
      } else if (t === 'E') {
        if (cur) {
          const state = parseBlock(cur);
          cur = null;
          if (!p.stopped) {
            try {
              p.onState(sessionId, state);
            } catch (e) {
              /* 렌더러가 없어졌을 수 있다 */
            }
          }
        }
      } else if (cur) {
        cur.push(line);
      }
      if (buf.length > 64 * 1024) buf = ''; // 이상한 출력이 쌓이지 않게
    }
  };

  const onClose = () => {
    if (p.stopped) return;
    // 채널이 끝났다(수명 만료·네트워크). 잠시 뒤 다시 연다.
    p.timer = setTimeout(() => run(sessionId), RESTART_MS);
  };

  try {
    ssh.execStream(sessionId, script(), CHANNEL_MS, onData, onClose);
  } catch (e) {
    onClose();
  }
}

/** 세션이 닫히면 관찰기도 멈춘다. */
function stop(sessionId) {
  const p = probes.get(sessionId);
  if (!p) return;
  p.stopped = true;
  if (p.timer) clearTimeout(p.timer);
  probes.delete(sessionId);
}

function stopAll() {
  for (const id of [...probes.keys()]) stop(id);
}

module.exports = { start, stop, stopAll, INTERVAL_SEC };
