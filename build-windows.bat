@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Armux Terminal - Windows installer build
echo ============================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 설치되어 있지 않습니다.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

echo [1/2] 의존성 설치 중... ^(최초 1회는 몇 분 걸립니다^)
call npm install
if errorlevel 1 goto error

echo.
echo [2/2] 설치본 빌드 중...
call npm run dist:win
if errorlevel 1 goto error

echo.
echo ============================================
echo   완료! dist 폴더에 결과물이 있습니다.
echo     - Armux Terminal Setup x.y.z.exe  : 설치본
echo     - Armux Terminal x.y.z.exe        : 포터블 (설치 불필요)
echo     - Armux Terminal-x.y.z-win.zip    : 압축본
echo ============================================
start "" "%cd%\dist"
pause
exit /b 0

:error
echo.
echo [!] 빌드에 실패했습니다. 위의 로그를 확인하세요.
pause
exit /b 1
