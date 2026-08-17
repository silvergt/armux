#!/bin/bash
# macOS 에서 더블클릭하면 dmg 를 만들어 주는 스크립트
set -u
cd "$(dirname "$0")"

echo "============================================"
echo "  Armux Terminal - macOS 설치본 빌드"
echo "============================================"
echo

if ! command -v npm >/dev/null 2>&1; then
  echo "[!] Node.js 가 설치되어 있지 않습니다."
  echo "    https://nodejs.org 에서 LTS 를 설치하거나, brew install node 후 다시 실행하세요."
  echo
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."
  exit 1
fi

echo "[1/2] 의존성 설치 중... (최초 1회는 몇 분 걸립니다)"
if ! npm install; then
  echo
  echo "[!] npm install 실패."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."
  exit 1
fi

echo
echo "[2/2] dmg 빌드 중..."
if ! npm run dist:mac; then
  echo
  echo "[!] 빌드 실패. 위 로그를 확인하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."
  exit 1
fi

echo
echo "============================================"
echo "  완료! dist 폴더의 dmg 를 열어 Applications 로 드래그하세요."
echo
echo "  서명하지 않은 앱이라 처음 실행할 때 경고가 뜹니다. 그때는:"
echo "    xattr -dr com.apple.quarantine \"/Applications/Armux Terminal.app\""
echo "  또는 시스템 설정 > 개인정보 보호 및 보안 > '확인 없이 열기'"
echo "============================================"
open dist
