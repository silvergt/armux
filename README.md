# Armux Terminal

iTerm 스타일의 크로스플랫폼(Windows / macOS) SSH 터미널 클라이언트. Electron + xterm.js + ssh2 로 만들어졌다.

## 화면 구성

```
┌──────────────────────────────────────────────────────────┐
│  ● server-A (2)  │  ● server-B  │  ● server-C   │    +   │  ← 메인탭 = 세로 열(호스트별 그룹)
│                  └ + (탭에 마우스 올리면 아래에 뜸)        │
├──────────────────────────────────────────────────────────┤
│  1 root@a: ~  │  2 root@a: /var/log  │  +               │  ← 서브탭 = 가로 줄(같은 호스트의 다른 셸)
├──────────────────────────────────────────────────────────┤
│                                                          │
│   (까만 터미널 화면)                                       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ root@a:22 · 연결됨          149×43 · 13px · 메인 1/3 · 서브 1/2 │
└──────────────────────────────────────────────────────────┘
```

- **메인탭(세로 열)** — 상단 탭바의 항목. 탭바 오른쪽 끝 `+` 로 추가하며, 새 SSH 접속 하나가 하나의 그룹이 된다.
- **서브탭(가로 줄)** — 메인탭에 마우스를 올리면 탭 **아래에 뜨는 `+`** (또는 서브탭바 끝의 `+`)로 추가. 같은 호스트에 새 셸 세션을 연다. 결과적으로 탭이 n × n 격자로 쌓인다.

## 단축키

| 키 | 동작 |
| --- | --- |
| `Ctrl` + `1`~`9` | 서브탭(가로 줄) 이동 |
| `Ctrl` + `Shift` + `1`~`9` | 메인탭(세로 열) 이동 |
| `Ctrl/⌘` + `N` | 새 메인탭(새 SSH 접속) |
| `Ctrl/⌘` + `T` | 현재 그룹에 서브탭 추가 |
| `Ctrl/⌘` + `W` | 현재 서브탭 닫기 |
| `⌘C` / `⌘V` (mac), `Ctrl+Shift+C` / `Ctrl+Shift+V` (win) | 복사 / 붙여넣기 |
| `Ctrl/⌘` + `F` | 화면 내 검색 |
| `Ctrl/⌘` + `+` / `-` / `0` | 글자 크기 확대 / 축소 / 초기화 |

그 밖에: 드래그로 선택하면 자동 복사, 우클릭으로 붙여넣기, 탭 휠클릭으로 닫기.
연결이 끊긴 탭에서 `Enter` 를 누르면 같은 정보로 재접속한다.

## 접속 다이얼로그

`+` 를 누르면 뜬다.

- **왼쪽** — 저장된 접속 목록. 클릭하면 폼에 채워지고, 더블클릭하면 바로 접속한다. `삭제` 로 제거.
- **오른쪽** — 새 접속 정보. 인증 방식은 `비밀번호` / `개인키 파일` / `SSH Agent` 세 가지.
  - `접속 정보 저장` 을 켜면 호스트/포트/사용자/인증방식이 저장된다.
  - `비밀번호도 저장(암호화)` 을 켜면 OS 키체인 기반 `safeStorage` 로 암호화해서 저장한다. 암호화를 쓸 수 없는 환경에서는 이 옵션이 비활성화되며, **비밀번호를 평문으로 저장하지 않는다.**
- 저장하지 않은 접속이라도, 같은 그룹에 서브탭을 추가할 때는 앱이 켜져 있는 동안 메모리에 남는 자격증명을 재사용하므로 비밀번호를 다시 묻지 않는다.
- 메인탭의 `+` 를 **Shift+클릭** 하면 그 그룹에 *다른* 호스트로 서브탭을 열 수 있다.

저장 위치: `<userData>/hosts.json`
(Windows: `%APPDATA%\Armux Terminal\hosts.json`, macOS: `~/Library/Application Support/Armux Terminal/hosts.json`)

## 개발

```bash
npm install
npm start        # 앱 실행
npm run dev      # 개발자도구를 띄운 채 실행
npm run vendor   # xterm 버전을 올린 뒤 src/renderer/vendor 갱신
```

## 배포 빌드

```bash
npm run dist:win      # → 설치본 exe + 포터블 exe + zip (윈도우 또는 wine 필요)
npm run dist:win-zip  # → zip 만. wine 없이 mac/Linux 에서도 바로 됨
npm run dist:mac      # → dmg (x64 / arm64). macOS 에서만 가능
```

아이콘은 `build/icon.ico`(win) / `build/icon.png`(mac) 이며 `python3 scripts/make-icon.py` 로 다시 만들 수 있다.

### 윈도우 배포본 만드는 3가지 방법

**① 윈도우 PC에서 직접 (가장 단순)**

1. [nodejs.org](https://nodejs.org) 에서 Node.js LTS 설치
2. 프로젝트 폴더를 윈도우로 복사 (`node_modules`, `dist` 는 빼고)
3. ```
   npm install
   npm run dist:win
   ```
4. `dist\` 에 설치본 exe 와 포터블 exe 가 생긴다.

**② mac / Linux 에서 크로스 빌드**

- **zip 배포본은 wine 없이 바로 된다.**

  ```bash
  npm run dist:win-zip     # → dist/Armux Terminal-<ver>-win.zip
  ```

  받는 쪽에서 압축을 풀고 `Armux Terminal.exe` 를 실행하면 끝(설치 불필요). `dist/win-unpacked/` 폴더를 통째로 복사해도 같다.

- **설치본(nsis) / 포터블 exe 는 wine 이 필요하다.** NSIS 가 만드는 실행 파일이 32비트라서, 64비트 wine 만으로는 안 되고 32비트 지원이 있어야 한다.

  ```bash
  # macOS
  brew install --cask wine-stable && npm run dist:win

  # Ubuntu / Debian
  sudo dpkg --add-architecture i386
  sudo apt update && sudo apt install -y wine wine32:i386
  npm run dist:win

  # 도커로 (호스트에 wine 설치 없이)
  docker run --rm -v "$PWD":/project -w /project electronuserland/builder:wine npm run dist:win
  ```

  > electron-builder 의 `build.toolsets.wine` 번들 wine 은 32비트 PE 모듈이 없어 NSIS 단계에서 실패한다. 시스템 wine(32비트 포함)을 쓰는 편이 확실하다.

**③ GitHub Actions 로 자동 빌드**

`.github/workflows/build.yml`:

```yaml
name: build
on:
  push:
    tags: ['v*']
jobs:
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run dist:win
      - uses: actions/upload-artifact@v4
        with:
          name: windows
          path: dist/*.exe
```

### 아키텍처 / 설치 형태

- 기본은 x64. ARM 윈도우까지 필요하면 `package.json` 의 `build.win.target` 에 `"arch": ["x64", "arm64"]` 을 추가한다.
- 설치본은 `oneClick: false`, `perMachine: false` 라서 관리자 권한 없이 사용자 폴더에 설치되고 설치 경로를 고를 수 있다.
- 설치 없이 쓰려면 포터블 exe 나 `dist/win-unpacked/` 폴더째로 복사해도 실행된다.

### 코드 서명

서명하지 않은 exe 는 실행 시 Windows SmartScreen 이 "알 수 없는 게시자" 경고를 띄운다(추가 정보 → 실행 으로 진행 가능).
없애려면 코드 서명 인증서(OV/EV)를 구입한 뒤 빌드 시 환경변수로 넘긴다:

```bash
CSC_LINK=/path/to/cert.pfx CSC_KEY_PASSWORD=... npm run dist:win
```

macOS 도 마찬가지로 서명·공증(notarization) 없이 만든 dmg 는 Gatekeeper 경고가 뜬다.

## 구조

```
src/
  main/
    main.js     # Electron 메인 프로세스: 창, 메뉴, IPC
    ssh.js      # ssh2 기반 SSH 세션(접속/셸/리사이즈/종료) 관리
    store.js    # 접속 프로필 저장소 (safeStorage 로 비밀번호 암호화)
  preload/
    preload.js  # contextBridge 로 렌더러에 노출하는 안전한 API
  renderer/
    index.html  # 탭바 / 서브탭바 / 터미널 / 접속 다이얼로그 마크업
    renderer.js # 2단계 탭 상태 관리, xterm 인스턴스, 단축키
    styles.css  # 다크 테마 UI
    vendor/     # xterm.js 배포 파일 (npm run vendor 로 갱신)
scripts/
  sync-vendor.js  # xterm 배포 파일 복사
  make-icon.py    # build/icon.png, build/icon.ico 생성
build/
  icon.png        # mac/linux 아이콘 원본 (1024px)
  icon.ico        # windows 아이콘 (멀티 사이즈)
```

보안 설정: `contextIsolation: true`, `nodeIntegration: false`, 렌더러에는 CSP 적용. SSH 자격증명은 메인 프로세스 밖으로 나가지 않는다.
