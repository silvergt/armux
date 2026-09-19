#!/bin/bash
#
# Armux Terminal — 맥 설치 / 업데이트
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/silvergt/armux/main/scripts/install-mac.sh)"
#
# 왜 이 스크립트가 있나
#   브라우저로 받은 앱에는 macOS 가 "격리(com.apple.quarantine)" 딱지를 붙인다.
#   서명·공증되지 않은 앱에 그 딱지가 붙어 있으면 첫 실행 때 열리지 않고,
#   시스템 설정 → 개인정보 보호 및 보안 → "확인 없이 열기" 를 눌러 줘야 한다.
#
#   딱지는 "받은 프로그램" 이 붙이는 것이라 curl 로 받으면 처음부터 붙지 않는다.
#   그래서 이 스크립트로 설치하면 그 과정이 통째로 없어진다.
#
set -euo pipefail

REPO="silvergt/armux"
APP_NAME="Armux Terminal.app"

say() { printf '%s\n' "$*"; }
die() { printf '오류: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "이 스크립트는 macOS 전용입니다."

# 1. 어느 맥인지
case "$(uname -m)" in
  arm64)  SUFFIX="mac-arm64" ;;  # 애플 실리콘
  x86_64) SUFFIX="mac-x64" ;;    # 인텔
  *) die "지원하지 않는 기종입니다: $(uname -m)" ;;
esac

# 2. 최신 버전 알아내기
say "최신 버전을 확인합니다…"
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$TAG" ] || die "릴리스를 찾지 못했습니다."
VER="${TAG#v}"
URL="https://github.com/$REPO/releases/download/$TAG/Armux-Terminal-$VER-$SUFFIX.zip"

# 3. 어디에 넣을지 (/Applications 에 못 쓰면 개인 폴더로)
DEST="/Applications"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  say "※ /Applications 에 쓸 수 없어 $DEST 에 설치합니다."
fi
TARGET="$DEST/$APP_NAME"

# 4. 받기 — curl 로 받으므로 격리 딱지가 붙지 않는다 (이게 핵심)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Armux Terminal $VER ($SUFFIX) 를 내려받습니다…"
curl -fL --progress-bar -o "$TMP/armux.zip" "$URL" || die "내려받기에 실패했습니다: $URL"

# 5. 풀기 — ditto 를 쓴다. unzip 은 .app 안의 심볼릭 링크와 서명 구조를 망가뜨린다.
say "압축을 풉니다…"
ditto -x -k "$TMP/armux.zip" "$TMP/out" || die "압축을 풀지 못했습니다."
[ -d "$TMP/out/$APP_NAME" ] || die "받은 파일 안에 $APP_NAME 이 없습니다."

# 6. 지금 돌고 있는 Armux 찾기
#    pgrep 은 쓰지 않는다 — 맥의 pgrep 은 "자기 조상 프로세스" 를 기본으로 빼 버려서,
#    Armux 의 로컬 터미널 안에서 이 스크립트를 돌리면 Armux 본체를 못 찾는다.
#    ps 로 본체(…/Contents/MacOS/Armux Terminal)만 골라 pid 와 앱 경로를 얻는다.
find_running() {
  ps -axo pid=,command= | while read -r pid cmd; do
    case "$cmd" in
      */Contents/Frameworks/*) ;;  # 도우미(Helper) 프로세스는 본체가 아니다
      */Contents/MacOS/"Armux Terminal"|*/Contents/MacOS/"Armux Terminal "*)
        printf '%s\t%s\n' "$pid" "${cmd%%/Contents/MacOS/*}" ;;
    esac
  done
}

# 이 셸이 Armux 안(로컬 터미널)에서 돌고 있는지 — 조상을 거슬러 올라가 본다
is_ancestor() {
  local p=$$ n=0
  while [ "$p" -gt 1 ] && [ $n -lt 64 ]; do
    [ "$p" = "$1" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$p" ] || return 1
    n=$((n + 1))
  done
  return 1
}

RUNNING="$(find_running || true)"
RUN_PID="$(printf '%s\n' "$RUNNING" | head -1 | cut -f1)"
RUN_APP="$(printf '%s\n' "$RUNNING" | head -1 | cut -f2)"
INSIDE=0
[ -n "$RUN_PID" ] && is_ancestor "$RUN_PID" && INSIDE=1

# 7. 옛 것을 치우고 새 것을 넣는다.
#    돌고 있는 앱의 묶음을 지워도 맥에서는 안전하다(떠 있는 프로세스는 옛 파일을 계속 쥐고
#    있다). 그래서 앱을 먼저 끄지 않는다 — Armux 안에서 돌리면 앱을 끄는 순간 이 스크립트도
#    같이 죽기 때문이다. 재시작은 설치가 끝난 뒤에 한다.
#    지우는 대상은 "$DEST/Armux Terminal.app" 한 곳뿐이다. 경로를 밖에서 받지 않고,
#    실제로 그 이름의 앱 묶음(디렉터리)일 때만 지운다 — 엉뚱한 것을 지우지 않게.
if [ -e "$TARGET" ]; then
  case "$TARGET" in
    "/Applications/$APP_NAME"|"$HOME/Applications/$APP_NAME") ;;
    *) die "예상치 못한 설치 경로입니다: $TARGET" ;;
  esac
  [ -d "$TARGET" ] || die "$TARGET 이 앱 묶음이 아닙니다. 직접 확인해 주세요."
  [ -L "$TARGET" ] && die "$TARGET 이 심볼릭 링크입니다. 직접 확인해 주세요."
  say "기존 버전을 교체합니다…"
  rm -rf "$TARGET"
fi
ditto "$TMP/out/$APP_NAME" "$TARGET" || die "설치에 실패했습니다."

# 8. 혹시 붙어 있다면 격리 딱지를 뗀다 (curl 로 받았으면 애초에 없다)
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

say ""
say "설치했습니다: $TARGET ($VER)"

# 지금 쓰던 앱이 다른 곳에 있으면, 그걸 다시 켜면 옛 버전이 뜬다 — 알려 준다.
if [ -n "$RUN_APP" ] && [ "$RUN_APP" != "$TARGET" ]; then
  say ""
  say "※ 지금 실행 중인 Armux 는 다른 위치에 있습니다:"
  say "     $RUN_APP"
  case "$RUN_APP" in
    /Volumes/*) say "   설치 디스크(dmg)에서 바로 실행한 앱입니다. 디스크를 꺼내고," ;;
    */AppTranslocation/*) say "   macOS 가 임시 위치로 옮겨 실행한 앱입니다(받은 폴더에서 바로 연 경우)." ;;
    *) say "   Dock·Launchpad 가 이쪽을 가리키면 계속 옛 버전이 열립니다. 그 앱은 지우고," ;;
  esac
  say "   앞으로는 $TARGET 을 여세요 (Dock 아이콘도 새로 고정)."
fi

# 9. 새 버전으로 (재)시작
#    이미 떠 있는데 그냥 open 하면 맥은 떠 있는 "옛" 창을 앞으로 가져오기만 한다.
#    그래서 옛 프로세스가 끝날 때까지 기다렸다가 여는 도우미를 따로 띄우고, 앱에 종료를 청한다.
if [ -n "$RUN_PID" ]; then
  # 앱이 꺼지면 이 셸도 같이 끊기므로(Armux 안에서 돌린 경우) 도우미는 끊김 신호를 무시하고
  # 출력도 터미널에 매지 않는다.
  nohup /bin/sh -c '
    i=0
    while kill -0 "$1" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.5; i=$((i+1)); done
    kill -0 "$1" 2>/dev/null && exit 0   # 5분 안에 안 꺼졌으면(종료 취소) 아무것도 안 한다
    sleep 1
    open "$2"
  ' armux-relaunch "$RUN_PID" "$TARGET" >/dev/null 2>&1 &
  say ""
  if [ "$INSIDE" = 1 ]; then
    say "Armux 를 다시 시작합니다 — 이 창도 같이 닫힙니다."
  else
    say "실행 중인 Armux 를 다시 시작합니다…"
  fi
  say "열린 세션 종료 확인 창이 뜨면 '종료' 를 눌러 주세요. 꺼지면 새 버전이 자동으로 열립니다."
  osascript -e 'quit app "Armux Terminal"' >/dev/null 2>&1 &
else
  say "실행합니다…"
  open "$TARGET"
fi
