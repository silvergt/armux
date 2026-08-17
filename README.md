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
- **탭 표시** — 세 가지뿐이고, 한 자리에 하나만 보여 준다.
  1. **스피너** — Claude 가 생각하는 중 (화면에 `esc to interrupt` 가 보일 때).
  2. **❗ 초록 느낌표** — Claude 가 생각을 끝냈을 때(그 창을 보고 있지 않은 경우). 그 탭을 열거나 입력하면 사라진다.
  3. **점** — 그 밖의 모든 경우(연결 상태만 표시). 일반 명령 실행이나 vim 같은 전체화면 앱은 따로 표시하지 않는다.

  서브탭에 뜬 표시는 메인탭에도 함께 뜬다.
- **❗ 초록 느낌표** — 그 탭의 Claude Code 등이 사용자의 응답을 기다리는 중이라는 표시. 서브탭에 뜨면 메인탭에도 함께 뜨고, 그 탭을 열어 확인하면 사라진다.

## 단축키

| 키 | 동작 |
| --- | --- |
| `⌘`(mac) / `Ctrl`(win) + `1`~`9` | 서브탭(가로 줄) 이동 |
| `⌘⌃`(mac) / `Ctrl+Alt`(win) + `1`~`9` | 메인탭(세로 열) 이동 |
| `Ctrl/⌘` + `N` | 새 메인탭(새 SSH 접속) |
| `Ctrl/⌘` + `T` | 현재 그룹에 서브탭 추가 |
| `⌘D` (mac) / `Ctrl+Shift+D` (win) | 좌우로 분할 |
| `⌘⇧D` (mac) / `Ctrl+Shift+E` (win) | 위아래로 분할 |
| `Ctrl` + `` ` `` | 파일 탐색기 켜고 끄기 |
| `Alt` + 방향키 | 분할된 창 사이 이동 |
| `Ctrl/⌘` + `W` | 현재 분할 창 닫기 (마지막이면 탭이 닫힘) |
| `Ctrl+C` / `Ctrl+V` (win·linux) | 복사 / 붙여넣기. **선택한 글자가 없으면 `Ctrl+C` 는 평소대로 셸에 `^C`(SIGINT)로 전달된다** |
| `⌘C` / `⌘V` (mac), `Ctrl+Shift+C` / `Ctrl+Shift+V` | 복사 / 붙여넣기 |
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

## 웹페이지 판

터미널 대신 **웹 브라우저**를 판에 띄울 수 있다.

- **새 메인탭으로** — `+` → 다이얼로그 위쪽의 **웹페이지** 탭 → 주소 입력 → `열기`
- **기존 판을 전환** — 판에 마우스를 올리면 나오는 도구 두 번째 줄의 **🌐 웹페이지로 전환** (웹 상태에서는 **⌨ 터미널로 전환**). 전환해도 그 판의 SSH 세션은 살아 있어 언제든 돌아올 수 있다.
- 주소창(입력하면 URL 이면 이동, 아니면 구글 검색), 뒤로/앞으로/새로고침/홈, "크롬에서 열기" 로 구성된다.
- **주소창 자동완성** — 이 PC 크롬의 방문 기록을 읽어와(읽기 전용) 후보를 띄운다. 방향키·Enter 로 선택. 크롬/엣지/크로미움의 여러 프로필을 함께 본다.
- 이 판은 **로그인이 유지**된다(persist 세션). 한 번 로그인하면 앱을 껐다 켜도 유지된다. 크롬의 로그인 세션 자체를 가져올 수는 없으니, 로그인이 그대로인 진짜 크롬으로 열려면 "크롬에서 열기" 를 쓴다.

> **크롬 프로필(로그인 세션)까지 그대로 쓰지는 못한다.** 크롬은 쿠키·비밀번호를 OS 키체인으로 암호화해 두고 실행 중에는 프로필을 잠그기 때문에, 어떤 외부 앱도 그 로그인 상태를 그대로 가져올 수 없다.
> 이 판은 Chromium 엔진 자체는 크롬과 같고 User-Agent 도 크롬으로 맞췄지만, **로그인은 이 창에서 따로** 해야 한다(로그인 상태는 앱 안에 계속 저장된다).
> 진짜 내 크롬으로 열고 싶으면 주소창 오른쪽 **크롬에서 열기** 를 누르면 기본 브라우저로 넘어간다.

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

연결이 끊기면 다음 작업에서 **자동으로 다시 연결**하고, 그래도 안 되면 툴바에 `⟲ 다시 연결` 버튼이 나타난다.

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

상단 오른쪽에 시계 하나가 `국기 코드 MM/DD HH:mm` 형식으로 표시된다(0.5초마다 갱신).
클릭하면 **🇰🇷 KR · 🇭🇰 HK · 🇺🇸 US** 중에서 고를 수 있고, 고른 지역은 다음 실행에도 유지된다.

## 하단바의 Claude 사용량

접속한 서버에 Claude Code 가 로그인되어 있으면 하단바에 **계정 이메일 · 플랜 · 세션(5시간) 사용량 · 주간 사용량** 이 막대와 퍼센트로 표시된다. 로그인되어 있지 않으면 아무것도 표시하지 않는다.

세션 사용량 오른쪽에는 **↻ 남은 시간(HH:MM)** — 그 사용량이 초기화되기까지 남은 시간이 표시된다.

조회는 **그 서버 안에서** 실행된다(서버의 `~/.claude/.credentials.json` 토큰으로 Anthropic API 를 호출). 토큰이 내 PC 로 넘어오지 않고, Armux 는 결과 수치만 받아 표시한다. 5분마다 갱신하고, 사용량 API 호출 제한(429)에 걸리면 마지막 값을 그대로 두고 15분 뒤에 다시 시도한다.

## 창 구성

- **Windows / Linux** — 제목 줄을 따로 두지 않고 맨 윗줄 하나에 **아이콘 + 앱 이름 + 메뉴(탭·편집·보기·정보·도움)** 를 모았다. 최소화·최대화·닫기 버튼만 그 줄 오른쪽에 겹쳐 표시된다.
- **macOS** — 같은 메뉴가 이미 시스템 메뉴 막대에 있으므로 앱 안에는 두지 않는다. 신호등 버튼이 놓일 얇은 줄만 남고, 탭 줄(📝 메모 포함)이 화면 왼쪽 끝부터 시작한다.

### macOS 단축키

macOS 에서는 `Ctrl` 대신 **`⌘`** 를 쓴다 — 서브탭 `⌘1~9`, 메인탭 `⌘⌃1~9`, 파일 탐색기 `⌘\``, 메모장 `⌘⌃\``, 복사/붙여넣기 `⌘C`/`⌘V`, 전체 선택 `⌘A`.
웹 화면·입력칸에서도 같은 키가 그대로 동작한다.

## 정보 · 자동 업데이트

맨 윗줄 **정보** 메뉴에 두 항목이 있다.

- **버전** — 아이콘, 버전(+커밋), 빌드 날짜, 개발자(Jun Yeol Yang), GitHub 바로가기.
- **업데이트** — GitHub Releases 에 더 새 버전이 있는지 확인하고, `내려받기` → `지금 설치하고 다시 시작` 순서로 업데이트한다. 진행률이 막대로 표시된다.

자동 업데이트가 **동작하는 조건**:

1. 배포본이 GitHub Releases 에 `latest.yml`(win) / `latest-mac.yml`(mac) 과 함께 올라가 있어야 한다 → 태그를 밀면 CI 가 알아서 올린다(`releaseType: release` 라 초안이 아니라 바로 공개된다).
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

또는 릴리스에서 dmg 를 받는다 — Apple Silicon 은 `-mac-arm64.dmg`, 인텔은 `-mac-x64.dmg`.
dmg 를 열어 앱을 **Applications** 로 드래그하면 설치 끝이다.

#### 처음 실행할 때 뜨는 경고 (중요)

이 앱은 **ad-hoc 서명만 되어 있고 Apple 공증(notarization)은 받지 않았다.** 그래서 처음 열 때 막힌다.
증상별로 이렇게 푼다.

| 메시지 | 해결 |
| --- | --- |
| `Apple cannot check it for malicious software` | 아래 명령 한 줄, 또는 시스템 설정 > 개인정보 보호 및 보안 > 맨 아래 **"확인 없이 열기"** |
| `is damaged and can't be opened` | 서명이 없는 예전 빌드다. 0.9.3 이상을 받을 것 |

```bash
xattr -dr com.apple.quarantine "/Applications/Armux Terminal.app"
```

이 명령은 "인터넷에서 받은 파일" 표시(quarantine)를 지우는 것이라, 실행하면 그다음부터 경고 없이 열린다.
macOS 15(Sequoia)부터는 우클릭 → 열기 우회가 없어졌으므로, 위 명령이나 시스템 설정 쪽을 써야 한다.

> 경고를 아예 없애고 **맥에서도 앱 내 자동 업데이트**를 쓰려면 Apple Developer Program(연 $99)의
> Developer ID 인증서로 서명 + 공증이 필요하다. 인증서가 준비되면 CI 에 `CSC_LINK`/`CSC_KEY_PASSWORD`,
> `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 를 넣고 `mac.notarize` 를 켜면 된다.

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
