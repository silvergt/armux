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

# 6. 돌고 있으면 종료
if pgrep -f "/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1; then
  say "실행 중인 Armux Terminal 을 종료합니다…"
  osascript -e 'quit app "Armux Terminal"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 1
  done
fi

# 7. 옛 것을 치우고 새 것을 넣는다.
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
say "설치했습니다: $TARGET"
say "실행합니다…"
open "$TARGET"
