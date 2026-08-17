# Armux Terminal

iTerm 스타일의 크로스플랫폼(Windows / macOS) SSH 터미널 클라이언트. Electron + xterm.js + ssh2 로 만들어졌다.

## 화면 구성

```
┌───────────────────────────────────────────────────────────────┐
│  ● Alt1 server-A (3) ❗│ ● Alt2 server-B │        +  │ 도움 ▾ │  ← 메인탭(세로 열)
│                       └ + (탭에 마우스 올리면 아래에 뜸)         │
├───────────────────────────────────────────────────────────────┤
│ 📁 │ 1 배포서버 ⧉2 ❗│ 2 root@a: /var/log │  +                │  ← 서브탭(가로 줄)
├───────────────────────────────────────────────────────────────┤
│                              │                                │
│   (까만 터미널 화면)           │   (좌우/상하로 분할 가능)        │
│                              ├────────────────────────────────┤
│                              │                                │
├───────────────────────────────────────────────────────────────┤
│ root@a:22 · 연결됨     149×43 · 13px · 메인 1/2 · 서브 1/2 · 분할 2/3 │
└───────────────────────────────────────────────────────────────┘
```

- **메인탭(세로 열)** — 상단 탭바의 항목. 탭바 오른쪽 끝 `+` 로 추가하며, 새 SSH 접속 하나가 하나의 그룹이 된다.
- **탭 순서 바꾸기** — 메인탭·서브탭 모두 마우스로 끌어서 순서를 바꿀 수 있다. 끌면 놓일 자리에 파란 선이 표시되고, 순서를 바꾸면 `Ctrl+숫자` / `Ctrl+Alt+숫자` 번호도 새 순서를 따른다.
- **서브탭(가로 줄)** — 메인탭에 마우스를 올리면 탭 **아래에 뜨는 `+`** (또는 서브탭바 끝의 `+`)로 추가. 같은 호스트에 새 셸 세션을 연다. 결과적으로 탭이 n × n 격자로 쌓인다.
  - 서브탭을 **우클릭**하면 이름을 바꿀 수 있다. 기본 이름은 그 탭에서 돌아가는 세션의 제목(셸이 알려주는 `user@host: 경로`)이고, 비워서 저장하면 다시 기본값으로 돌아간다.
- **분할(페인)** — 탭 하나를 좌우/상하로 쪼갠다. 각 분할은 독립된 SSH 셸이고 개별로 닫을 수 있다. 페인에 마우스를 올리면 우상단에 분할/닫기 버튼이 뜨고, 경계선을 끌어 크기를 조절한다.
- **📁 파일 탐색기 탭** — 서브탭바 맨 왼쪽에 항상 있는 탭. 누르면 그 서버의 파일을 트리로 보여준다. 옆의 **📌** 를 누르면 왼쪽에 고정되어 터미널과 나란히 항상 보이고, 다시 누르면 필요할 때만 여는 방식으로 돌아간다. `Ctrl+\`` 로도 켜고 끌 수 있다.
- **탭 표시 우선순위** — 한 자리에 하나만 보여 준다.
  1. **❗ 초록 느낌표** — 응답 대기(Claude 가 물어보거나 작업을 끝냈는데 그 창을 안 보고 있을 때). 서브탭에 하나라도 있으면 메인탭에도 뜬다.
  2. **✳ Claude 스피너** — Claude Code 가 생각/작업 중 (화면에 `esc to interrupt` 가 있을 때).
  3. **원형 스피너** — 파이썬·셸 스크립트 등 프로그램이 도는 중, 또는 vim·htop 같은 전체화면 앱이 떠 있을 때.
  4. 아무것도 없으면 연결 상태 점. Claude 창이 떠 있어도 **입력 대기 중이면 아무 표시도 하지 않는다.**
- **❗ 초록 느낌표** — 그 탭의 Claude Code 등이 사용자의 응답을 기다리는 중이라는 표시. 서브탭에 뜨면 메인탭에도 함께 뜨고, 그 탭을 열어 확인하면 사라진다.

## 단축키

| 키 | 동작 |
| --- | --- |
| `Ctrl` + `1`~`9` | 서브탭(가로 줄) 이동 |
| `Ctrl` + `Alt` + `1`~`9` | 메인탭(세로 열) 이동 |
| `Ctrl/⌘` + `N` | 새 메인탭(새 SSH 접속) |
| `Ctrl/⌘` + `T` | 현재 그룹에 서브탭 추가 |
| `⌘D` (mac) / `Ctrl+Shift+D` (win) | 좌우로 분할 |
| `⌘⇧D` (mac) / `Ctrl+Shift+E` (win) | 위아래로 분할 |
| `Ctrl` + `` ` `` | 파일 탐색기 켜고 끄기 |
| `Alt` + 방향키 | 분할된 창 사이 이동 |
| `Ctrl/⌘` + `W` | 현재 분할 창 닫기 (마지막이면 탭이 닫힘) |
| `⌘C` / `⌘V` (mac), `Ctrl+Shift+C` / `Ctrl+Shift+V` (win) | 복사 / 붙여넣기 |
| `Ctrl/⌘` + `F` | 화면 내 검색 |
| `Ctrl/⌘` + `+` / `-` / `0` | 글자 크기 확대 / 축소 / 초기화 |

**닫을 때는 항상 확인 창이 뜬다** — 분할 창, 서브탭, 메인탭, 그리고 프로그램 종료 모두. 열려 있는 세션이 하나도 없으면 프로그램은 묻지 않고 그냥 닫힌다.

그 밖에: 드래그로 선택하면 자동 복사, 우클릭으로 붙여넣기, 탭 휠클릭으로 닫기.
연결이 끊긴 탭에서 `Enter` 를 누르면 같은 정보로 재접속한다.

## 접속 다이얼로그

`+` 를 누르면 뜬다.

- **왼쪽** — 저장된 접속 목록. 클릭하면 폼에 불러오고, 더블클릭하면 바로 접속한다. `+ 새로 만들기` 로 빈 폼을 연다.
- **오른쪽** — 접속 정보. 인증 방식은 `비밀번호` / `개인키 파일` / `SSH Agent` 세 가지.
- 아래 버튼 세 개의 역할이 다르다. **여러 서버를 각각 등록해 두려면 `새로 등록` 을 쓴다.**
  - `새로 등록` — 항상 **새 항목을 추가**한다 (기존 항목을 덮어쓰지 않는다).
  - 등록하지 않고 `접속` 만 해도, 목록에 없는 새 서버라면 **자동으로 저장**된다(같은 host/port/user 가 이미 있으면 중복 저장하지 않음).
  - `저장` — 왼쪽에서 고른 **그 항목만** 덮어쓴다.
  - `접속` — 저장하지 않고 접속만 한다.
  - `비밀번호도 저장(암호화)` 를 켜면 OS 키체인 기반 `safeStorage` 로 암호화해 저장한다. 암호화를 쓸 수 없는 환경에서는 비활성화되며 **평문으로 저장하지 않는다.**
- 저장하지 않은 접속이라도, 같은 그룹에 서브탭을 추가할 때는 앱이 켜져 있는 동안 메모리에 남는 자격증명을 재사용하므로 비밀번호를 다시 묻지 않는다.
- 메인탭의 `+` 를 **Shift+클릭** 하면 그 그룹에 *다른* 호스트로 서브탭을 열 수 있다.

저장 위치: `<userData>/hosts.json`
(Windows: `%APPDATA%\Armux Terminal\hosts.json`, macOS: `~/Library/Application Support/Armux Terminal/hosts.json`)

## 파일 탐색기 (SFTP)

서브탭 맨 왼쪽 **📁** 를 누르면 그 서버의 파일을 탐색기처럼 볼 수 있다. 터미널 세션과 별개의 SFTP 연결을 쓰므로 터미널 작업에 방해되지 않는다.

| 동작 | 방법 |
| --- | --- |
| 하위 항목 펼치기 | 폴더 앞 **▸** 클릭 또는 더블클릭 (경로를 옮기지 않고 그 자리에서 펼쳐진다) |
| 뒤로 / 앞으로 | 툴바 **←** / **→**, 마우스 뒤로·앞으로 버튼, `Backspace`. 기록이 없으면 ← 는 상위 폴더로 |
| 파일 내려받기 | 더블클릭 |
| 이름 변경 · 새 폴더 · 새 파일 · 업로드 · 다운로드 · 삭제 · 경로 복사 | 우클릭 메뉴 |
| 업로드 | 내 PC 탐색기/Finder 에서 파일·폴더를 끌어다 놓기 |
| 서버 안에서 이동 | 항목을 다른 폴더(또는 `..`) 위로 끌어다 놓기 |
| 내 PC 로 꺼내기 | `Alt` 를 누른 채 끌기 (내려받은 뒤 시스템 드래그가 시작된다) |
| 새로고침 / 상위 폴더 / 삭제 | `F5` / `Backspace` / `Delete` |

각 분할 창 오른쪽 위의 **⤒ / ⤓** 는 스크롤을 맨 위/맨 아래로 보낸다. **tmux 세션 안에서도 동작**한다(tmux 히스토리를 copy-mode 로 오가며, 기본 prefix 인 `Ctrl+B` 를 사용).

폴더는 재귀적으로 업로드·다운로드·삭제된다. 전송 중에는 목록 아래에 **큰 진행 카드**(파일명 · 진행 막대 · 받은 용량 / 전체 용량 · 큼직한 %)가 떠서 한눈에 보이고, 끝나면 잠시 뒤 사라진다.

## 메모장

왼쪽 위 **📝 메모** 버튼 또는 `Ctrl+Alt+``` 로 연다. 서버가 아니라 **내 PC 에 저장되는 개인 메모**다.

- 목록에 **이름 · 크기 · 만든 날짜 · 마지막 작성** 이 표시되고, 기본 정렬은 마지막 작성 최신순(열 제목을 누르면 정렬 기준 변경).
- `+ 새 메모` 로 새로 쓰거나 목록에서 클릭해 이어 쓴다. 편집기는 평범한 텍스트 편집기라 드래그 선택·복사·붙여넣기·되돌리기가 모두 OS 기본 동작 그대로다.
- `Ctrl/⌘+S` 로 저장하고, 입력을 멈추면 잠시 뒤 자동 저장된다. 이름 칸을 고치면 파일 이름도 함께 바뀐다.
- 저장 위치는 `<앱 데이터>/notes/*.md` (Windows: `%APPDATA%\Armux Terminal\notes`). 목록의 `📂 폴더 열기` 로 바로 열 수 있다.

## 세션 복원

앱을 끌 때의 탭 구성을 기억했다가 다시 켤 때 되살린다 — 메인탭/서브탭의 **순서**, 서브탭 **이름**, **분할 구조와 비율**, 활성 탭, 파일 탐색기 고정 여부와 패널 폭까지. 저장된 접속(자동 저장 포함)으로 열려 있던 탭은 다시 연결되고, 저장 정보가 없던 탭은 안내와 함께 남아 `Enter` 를 누르면 접속 창이 열린다.

## 상단 시계

상단 오른쪽에 **🇰🇷 한국 · 🇭🇰 홍콩 · 🇺🇸 미국 동부** 시간이 `국기 MM/DD HH:mm` 형식으로 표시된다(0.5초마다 갱신).

## 하단바의 Claude 사용량

접속한 서버에 Claude Code 가 로그인되어 있으면 하단바에 **계정 이메일 · 플랜 · 세션(5시간) 사용량 · 주간 사용량** 이 막대와 퍼센트로 표시된다. 로그인되어 있지 않으면 아무것도 표시하지 않는다.

조회는 **그 서버 안에서** 실행된다(서버의 `~/.claude/.credentials.json` 토큰으로 Anthropic API 를 호출). 토큰이 내 PC 로 넘어오지 않고, Armux 는 결과 수치만 받아 표시한다. 30초마다 갱신한다.

## 정보 · 자동 업데이트

프로그램 메뉴 막대(탭 · 편집 · 보기 · **정보** · 도움)의 **정보** 메뉴에 두 항목이 있다.

- **버전** — 아이콘, 버전(+커밋), 빌드 날짜, 개발자(Jun Yeol Yang), GitHub 바로가기.
- **업데이트** — GitHub Releases 에 더 새 버전이 있는지 확인하고, `내려받기` → `지금 설치하고 다시 시작` 순서로 업데이트한다. 진행률이 막대로 표시된다.

자동 업데이트가 **동작하는 조건**:

1. 배포본이 GitHub Releases 에 `latest.yml`(win) / `latest-mac.yml`(mac) 과 함께 올라가 있어야 한다 → 태그를 밀면 CI 가 알아서 올린다.
   ```bash
   npm version patch      # 0.4.0 → 0.4.1 (package.json 갱신 + 커밋 + 태그)
   git push && git push --tags
   ```
2. 설치해서 쓰는 형태여야 한다.
   - **Windows**: `Armux Terminal Setup x.y.z.exe` 로 설치한 경우 앱 안에서 내려받기 → 재시작 설치까지 된다. **zip 압축본은 자동 업데이트가 되지 않는다**(업데이트 메타데이터가 없다). 최초 1회만 설치본으로 설치하면 그 뒤로는 앱에서 갱신된다.
   - **macOS**: 릴리스에 dmg 와 함께 **zip** 이 올라가야 자동 업데이트가 동작한다(electron-updater 는 mac 에서 zip 으로 갱신한다). 다만 macOS 는 **코드 서명이 있어야** 앱 안에서 설치까지 되고, 서명이 없으면 새 버전 알림 후 릴리스 페이지를 열어 준다.
3. 저장소가 public 이면 토큰 없이 조회된다(비공개면 토큰 설정이 따로 필요).

서명하지 않은 빌드도 업데이트는 되지만, 설치 시 SmartScreen/Gatekeeper 경고는 그대로 뜬다.

## 도움말

메뉴 막대의 **도움** 에서 **tmux 사용법** 과 **단축키 모음** 을 볼 수 있다.
tmux 문서는 세션/윈도우/페인 개념, `tmux new -s`·`attach` 같은 명령, prefix 단축키, 복사 모드, `~/.tmux.conf` 설정 예까지 담고 있다.

## 글꼴과 이모지

OS 기본 터미널 글꼴을 그대로 쓴다.

- **Windows** — PowerShell / Windows Terminal 과 같은 `Cascadia Mono` → `Consolas`, 한글은 `맑은 고딕`, 이모지는 `Segoe UI Emoji`
- **macOS** — `Menlo` → `SF Mono`, 한글 `Apple SD Gothic Neo`, 이모지 `Apple Color Emoji`

이모지·한글 폭 계산은 xterm 의 unicode-graphemes 애드온(유니코드 15 grapheme 기준)으로 처리해 글자가 겹치거나 밀리지 않는다.

## 개발

```bash
npm install
npm start        # 앱 실행
npm run dev      # 개발자도구를 띄운 채 실행
npm run vendor   # xterm 버전을 올린 뒤 src/renderer/vendor 갱신
```

## 설치본 만들기 (클론 받은 뒤)

**공통 준비물은 [Node.js LTS](https://nodejs.org) 하나뿐이다.** Visual Studio, Xcode 같은 빌드 도구는 필요 없다.

### 윈도우

```
git clone https://github.com/silvergt/armux.git
cd armux
build-windows.bat        ← 탐색기에서 더블클릭해도 됨
```

`npm install` → `npm run dist:win` 을 대신 해 주고, 끝나면 `dist` 폴더를 열어 준다. 결과물:

| 파일 | 용도 |
| --- | --- |
| `dist\Armux Terminal Setup 0.1.0.exe` | **설치본.** 더블클릭 → 설치 경로 선택 → 시작 메뉴/바탕화면 아이콘 생성 (관리자 권한 불필요) |
| `dist\Armux Terminal 0.1.0.exe` | 포터블. 설치 없이 실행 |
| `dist\Armux Terminal-0.1.0-win.zip` | 압축본. 풀고 `Armux Terminal.exe` 실행 |

직접 명령으로 하려면 `npm install` 다음 `npm run dist:win`.

### macOS

```bash
git clone https://github.com/silvergt/armux.git
cd armux
./build-mac.command      # Finder 에서 더블클릭해도 됨
```

`dist/Armux Terminal-0.1.0.dmg`(인텔) / `dist/Armux Terminal-0.1.0-arm64.dmg`(애플 실리콘) 이 생긴다.
dmg 를 열어 앱을 **Applications** 로 드래그하면 설치 끝.

서명하지 않은 앱이라 처음 열 때 "확인되지 않은 개발자" 경고가 뜬다. 둘 중 하나로 해제한다:

```bash
xattr -dr com.apple.quarantine "/Applications/Armux Terminal.app"
```

또는 앱을 우클릭 → 열기, 혹은 시스템 설정 > 개인정보 보호 및 보안 > "확인 없이 열기".

> 윈도우 설치본은 윈도우에서, mac dmg 는 mac 에서 만들어야 한다(서로 크로스 빌드하려면 아래 참고).

### 그 밖의 빌드 명령

```bash
npm start             # 빌드 없이 바로 실행 (개발용)
npm run dist:win      # 설치본 exe + 포터블 exe + zip
npm run dist:win-zip  # zip 만. wine 없이 mac/Linux 에서도 됨
npm run dist:mac      # dmg (x64 / arm64). macOS 에서만
```

아이콘은 `build/icon.ico`(win) / `icon.icns`(mac) / `icon.png` 이며 `python3 scripts/make-icon.py` 로 다시 만든다.

### 다른 OS 에서 윈도우 설치본을 만들어야 한다면

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

### GitHub Actions 로 윈도우/맥 설치본 자동 빌드

로컬에 윈도우도 맥도 없다면 이 방법이 제일 편하다. `.github/workflows/build.yml` 을 만들고 태그를 푸시하면
Actions 탭에서 두 OS 의 설치본을 내려받을 수 있다.

```yaml
name: build
on:
  push:
    tags: ['v*']
  workflow_dispatch:        # 탭에서 수동 실행도 가능
jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            script: dist:win
          - os: macos-latest
            script: dist:mac
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run ${{ matrix.script }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.os }}
          path: |
            dist/*.exe
            dist/*.dmg
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
  sync-vendor.js      # xterm 배포 파일 복사
  make-icon.py        # build/ 아이콘 3종 생성
build/
  icon.png            # 원본 (1024px)
  icon.ico            # windows
  icon.icns           # macOS
build-windows.bat     # 윈도우: 더블클릭하면 설치본 빌드
build-mac.command     # macOS: 더블클릭하면 dmg 빌드
```

보안 설정: `contextIsolation: true`, `nodeIntegration: false`, 렌더러에는 CSP 적용. SSH 자격증명은 메인 프로세스 밖으로 나가지 않는다.
