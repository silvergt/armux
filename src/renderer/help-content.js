'use strict';

/**
 * 도움말 모달에 들어가는 내용.
 * renderer.js 에서 window.HELP_CONTENT[key] 로 꺼내 쓴다.
 */

window.HELP_CONTENT = {
  tmux: {
    title: 'tmux 사용법',
    html: `
      <p class="lead">
        tmux 는 <b>SSH 접속이 끊겨도 원격 서버에서 작업이 계속 돌아가게</b> 해 주는 터미널 멀티플렉서다.
        노트북을 닫거나 네트워크가 끊겨도, 다시 접속해 <code>tmux attach</code> 하면 하던 화면이 그대로 나온다.
      </p>

      <h3>1. 구조</h3>
      <ul>
        <li><b>세션(session)</b> — 작업 공간 한 덩어리. 서버에 계속 남아 있는 단위.</li>
        <li><b>윈도우(window)</b> — 세션 안의 탭. 하나의 세션에 여러 개.</li>
        <li><b>페인(pane)</b> — 윈도우를 나눈 화면 조각.</li>
      </ul>
      <pre>세션 dev
 ├─ 윈도우 0: editor   ├ 페인 0 (vim)  ├ 페인 1 (테스트 실행)
 └─ 윈도우 1: server   └ 페인 0 (로그 tail)</pre>

      <h3>2. 셸에서 치는 명령</h3>
      <table>
        <tr><th>명령</th><th>설명</th></tr>
        <tr><td><code>tmux</code></td><td>이름 없는 새 세션 시작</td></tr>
        <tr><td><code>tmux new -s dev</code></td><td><b>dev</b> 라는 이름으로 새 세션 시작</td></tr>
        <tr><td><code>tmux ls</code></td><td>세션 목록 보기</td></tr>
        <tr><td><code>tmux attach -t dev</code></td><td>dev 세션에 다시 붙기 (<code>tmux a -t dev</code>)</td></tr>
        <tr><td><code>tmux attach</code></td><td>마지막 세션에 붙기</td></tr>
        <tr><td><code>tmux kill-session -t dev</code></td><td>dev 세션 종료</td></tr>
        <tr><td><code>tmux kill-server</code></td><td>모든 세션 종료</td></tr>
      </table>

      <h3>3. prefix 키</h3>
      <p>
        tmux 단축키는 전부 <b>prefix 를 누른 뒤</b> 이어서 누른다. 기본 prefix 는 <kbd>Ctrl</kbd>+<kbd>b</kbd> 다.
        아래 표에서 <code>prefix + d</code> 는 “Ctrl+b 를 눌렀다 떼고 d” 라는 뜻이다.
      </p>

      <h3>4. 세션 / 윈도우</h3>
      <table>
        <tr><th>키</th><th>동작</th></tr>
        <tr><td><code>prefix + d</code></td><td><b>detach</b>. 세션을 서버에 남겨둔 채 빠져나온다 (가장 많이 씀)</td></tr>
        <tr><td><code>prefix + s</code></td><td>세션 목록에서 골라 이동</td></tr>
        <tr><td><code>prefix + $</code></td><td>현재 세션 이름 바꾸기</td></tr>
        <tr><td><code>prefix + c</code></td><td>새 윈도우(탭) 만들기</td></tr>
        <tr><td><code>prefix + n</code> / <code>prefix + p</code></td><td>다음 / 이전 윈도우</td></tr>
        <tr><td><code>prefix + 0~9</code></td><td>번호로 윈도우 이동</td></tr>
        <tr><td><code>prefix + w</code></td><td>윈도우 목록에서 골라 이동</td></tr>
        <tr><td><code>prefix + ,</code></td><td>윈도우 이름 바꾸기</td></tr>
        <tr><td><code>prefix + &amp;</code></td><td>현재 윈도우 닫기</td></tr>
      </table>

      <h3>5. 페인(화면 분할)</h3>
      <table>
        <tr><th>키</th><th>동작</th></tr>
        <tr><td><code>prefix + %</code></td><td>좌우로 분할</td></tr>
        <tr><td><code>prefix + "</code></td><td>위아래로 분할</td></tr>
        <tr><td><code>prefix + 방향키</code></td><td>페인 간 이동</td></tr>
        <tr><td><code>prefix + o</code></td><td>다음 페인으로 순환 이동</td></tr>
        <tr><td><code>prefix + z</code></td><td>현재 페인 전체화면 토글 (다시 누르면 복귀)</td></tr>
        <tr><td><code>prefix + Ctrl+방향키</code></td><td>페인 크기 조절</td></tr>
        <tr><td><code>prefix + {</code> / <code>prefix + }</code></td><td>페인 위치 앞/뒤로 교체</td></tr>
        <tr><td><code>prefix + space</code></td><td>미리 정의된 배치로 레이아웃 변경</td></tr>
        <tr><td><code>prefix + x</code></td><td>현재 페인 닫기 (<code>exit</code> 와 동일)</td></tr>
      </table>

      <h3>6. 복사 모드 (스크롤 / 텍스트 복사)</h3>
      <table>
        <tr><th>키</th><th>동작</th></tr>
        <tr><td><code>prefix + [</code></td><td>복사 모드 진입. 방향키·PgUp 으로 스크롤</td></tr>
        <tr><td><code>space</code> → 이동 → <code>Enter</code></td><td>선택 시작 → 범위 지정 → 복사</td></tr>
        <tr><td><code>prefix + ]</code></td><td>복사한 내용 붙여넣기</td></tr>
        <tr><td><code>q</code></td><td>복사 모드 나가기</td></tr>
      </table>

      <h3>7. 자주 쓰는 흐름</h3>
      <pre>ssh 접속
tmux new -s work        # 작업 시작
  ... 오래 걸리는 작업 실행 ...
Ctrl+b d                # 빠져나오기 (작업은 계속 돌아감)
exit                    # ssh 끊어도 됨

# 나중에 다시
ssh 접속
tmux ls                 # work: 1 windows ...
tmux attach -t work     # 하던 화면 그대로 복귀</pre>

      <h3>8. 설정 팁 (~/.tmux.conf)</h3>
      <pre># 마우스로 페인 선택·크기조절·스크롤
set -g mouse on

# 스크롤백 넉넉히
set -g history-limit 100000

# 윈도우 번호를 1부터
set -g base-index 1

# prefix 를 Ctrl+a 로 바꾸기 (screen 사용자에게 익숙)
unbind C-b
set -g prefix C-a
bind C-a send-prefix</pre>
      <p>설정을 고친 뒤에는 <code>tmux source-file ~/.tmux.conf</code> 로 적용한다.</p>

      <h3>9. Armux 와 같이 쓰기</h3>
      <p>
        Armux 의 탭·분할은 <b>내 PC 쪽</b> 화면 분할이라 접속이 끊기면 사라진다.
        서버에서 돌아가는 작업 자체를 지키려면 tmux 를 함께 쓰는 게 좋다.
        예를 들어 서버에 붙자마자 <code>tmux new -s main</code> 또는 <code>tmux attach -t main</code> 을 실행해 두면,
        네트워크가 끊겨도 재접속 후 그대로 이어서 작업할 수 있다.
      </p>

      <h3>10. 탭 표시는 tmux 의 모든 창을 본다</h3>
      <p>
        Armux 는 접속한 서버에 <b>2초마다</b> "지금 어느 창에서 무엇이 돌고 있는지" 를 물어본다.
        그래서 <b>지금 보고 있지 않은 tmux 창</b>에서 백테스트가 돌고 있어도 탭에 스피너가 뜨고,
        <b>안 보는 사이에 끝나면 초록 느낌표</b>가 뜬다. 창을 옮기거나 tmux 에서 빠져나가도
        다음 조회에서 저절로 맞춰진다.
      </p>
      <ul>
        <li>사람의 입력을 기다리는 것은 "돌고 있다" 로 보지 않는다 —
            <code>vim</code>·<code>htop</code>·페이저, 인자 없는 <code>python3</code> REPL,
            <code>sudo -i</code> 로 연 셸, <code>tail -f</code> 같은 감시.</li>
        <li>Claude 가 <b>생각 중인지 입력을 기다리는지</b>는 폴링으로 구별되지 않아
            Claude Code 훅이 알려 준다(창별로 따로 기억한다).</li>
        <li>중첩 <code>tmux</code>·중첩 <code>ssh</code> 안쪽은 판단하지 않는다.
            스피너가 안 뜰 뿐, 잘못된 알림은 뜨지 않는다.</li>
      </ul>
    `
  },

  shortcuts: {
    title: 'Armux 단축키',
    html: `
      <h3>탭 이동</h3>
      <table>
        <tr><th>키</th><th>동작</th></tr>
        <tr><td><kbd>⌘</kbd>(mac) / <kbd>Ctrl</kbd>(win) + <kbd>1</kbd>~<kbd>9</kbd></td><td>서브탭(가로 줄) 이동</td></tr>
        <tr><td><kbd>⌘⌃</kbd>(mac) / <kbd>Ctrl+Alt</kbd>(win) + <kbd>1</kbd>~<kbd>9</kbd></td><td>메인탭(세로 열) 이동</td></tr>
      </table>

      <h3>탭 / 분할</h3>
      <table>
        <tr><th>키</th><th>동작</th></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>N</kbd></td><td>새 메인탭 (새 SSH 접속)</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>T</kbd></td><td>현재 그룹에 서브탭 추가</td></tr>
        <tr><td><kbd>⌘D</kbd> (mac) / <kbd>Ctrl+Shift+D</kbd> (win)</td><td>좌우로 분할</td></tr>
        <tr><td><kbd>⌘⇧D</kbd> (mac) / <kbd>Ctrl+Shift+E</kbd> (win)</td><td>위아래로 분할</td></tr>
        <tr><td><kbd>⌘⌥</kbd>(mac) / <kbd>Ctrl+Alt</kbd>(win) + <kbd>방향키</kbd></td><td>분할된 창 사이 이동</td></tr>
        <tr><td><kbd>⌥←</kbd> <kbd>⌥→</kbd> / <kbd>Alt+←</kbd> <kbd>Alt+→</kbd></td><td>한 단어 뒤로 / 앞으로</td></tr>
        <tr><td><kbd>⌘←</kbd> <kbd>⌘→</kbd> (mac)</td><td>줄 처음 / 줄 끝</td></tr>
        <tr><td><kbd>⌥⌫</kbd> / <kbd>Alt+⌫</kbd> · <kbd>⌘⌫</kbd></td><td>한 단어 삭제 · 줄 처음까지 삭제</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>W</kbd></td><td>현재 분할 창 닫기 (마지막이면 탭이 닫힘)</td></tr>
        <tr><td>페인 우상단 <b>⤒ / ⤓</b></td><td>맨 위로 / 맨 아래로 (tmux 세션 안에서도 동작)</td></tr>
      </table>

      <h3>편집 / 보기</h3>
      <table>
        <tr><th>키</th><th>동작</th></tr>
        <tr><td><kbd>Ctrl+C</kbd> / <kbd>Ctrl+V</kbd></td><td>복사 / 붙여넣기 (선택한 글자가 없으면 Ctrl+C 는 셸로 <code>^C</code> 전달)</td></tr>
        <tr><td><kbd>⌘C</kbd> / <kbd>⌘V</kbd> (mac)<br /><kbd>Ctrl+Shift+C</kbd> / <kbd>Ctrl+Shift+V</kbd></td><td>복사 / 붙여넣기</td></tr>
        <tr><td>드래그</td><td>선택하면 시스템 클립보드로 자동 복사</td></tr>
        <tr><td>tmux·vim 복사</td><td>OSC 52 로 시스템 클립보드에 복사됨 (tmux 는 set-clipboard on 권장)</td></tr>
        <tr><td>터미널 안 링크 클릭</td><td>기본 브라우저로 열림</td></tr>
        <tr><td>우클릭</td><td>붙여넣기</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>F</kbd></td><td>화면 내 검색</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd></td><td>글자 크기 확대 / 축소 / 초기화</td></tr>
      </table>

      <h3>웹페이지 판</h3>
      <table>
        <tr><th>동작</th><th>설명</th></tr>
        <tr><td>새 탭 <b>+</b> → <b>웹페이지</b> 탭</td><td>웹페이지를 첫 화면으로 하는 메인탭 열기</td></tr>
        <tr><td>판 도구 둘째 줄 <b>🌐 웹페이지로 전환</b></td><td>그 판을 브라우저로 전환 (다시 누르면 터미널로, SSH 세션은 유지)</td></tr>
        <tr><td>주소창</td><td>URL 이면 이동, 아니면 구글 검색. 이 PC 크롬 방문 기록으로 자동완성(방향키·Enter)</td></tr>
        <tr><td>크롬에서 열기</td><td>진짜 크롬(기본 브라우저)으로 현재 주소 열기 — 크롬 로그인/설정 그대로</td></tr>
      </table>
      <p>크롬의 로그인 세션은 암호화되어 있어 가져올 수 없다. 이 판에서 로그인하면 그 상태는 앱 안에 저장된다.</p>

      <h3>파일 탐색기 (SFTP)</h3>
      <table>
        <tr><th>동작</th><th>설명</th></tr>
        <tr><td>서브탭 왼쪽 <b>📁 파일</b> 탭</td><td>파일 탐색기 열기 (📌 를 누르면 왼쪽에 고정)</td></tr>
        <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>&#96;</kbd></td><td>파일 탐색기 켜고 끄기</td></tr>
        <tr><td>폴더 앞 <b>▸</b> / 더블클릭</td><td>들어가지 않고 그 자리에서 하위 항목 펼치기</td></tr>
        <tr><td><b>←</b> / <b>→</b> · 마우스 뒤로·앞으로 버튼</td><td>뒤로(없으면 상위 폴더) / 앞으로</td></tr>
        <tr><td>파일 더블클릭</td><td>내려받기</td></tr>
        <tr><td>우클릭</td><td>이름 변경, 새 폴더, 새 파일, 업로드, 다운로드, 삭제</td></tr>
        <tr><td>내 PC 에서 끌어다 놓기</td><td>그 폴더로 업로드</td></tr>
        <tr><td>항목을 폴더 위로 끌기</td><td>서버 안에서 이동</td></tr>
        <tr><td><kbd>Alt</kbd> + 끌기</td><td>내 PC 로 꺼내기(다운로드 후 시스템 드래그)</td></tr>
        <tr><td><kbd>F5</kbd> / <kbd>Backspace</kbd> / <kbd>Delete</kbd></td><td>새로고침 / 상위 폴더 / 삭제</td></tr>
      </table>

      <h3>퀵메모</h3>
      <table>
        <tr><th>키/동작</th><th>설명</th></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>M</kbd> · 하단바 오른쪽 <b>📝</b></td><td>퀵메모 창 열기/닫기 (마지막으로 적던 메모를 그대로 이어 연다. 그런 메모가 없으면 새 메모를 만든다)</td></tr>
        <tr><td>머리의 <b>메모 이름 ▾</b></td><td>다른 메모로 갈아타기 · 목록에서 <b>✕</b> 로 삭제</td></tr>
        <tr><td><b>+</b></td><td>새 메모 만들기</td></tr>
        <tr><td><b>⏱</b> · <kbd>Ctrl/⌘</kbd>+<kbd>D</kbd></td><td>커서 자리에 지금 시각 넣기</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>S</kbd></td><td>저장 (손을 멈추면 자동 저장도 됨)</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>닫기 (적던 내용은 저장된다)</td></tr>
        <tr><td>가장자리 끌기 · <b>⛶</b></td><td>창 크기 조절 · 전체보기</td></tr>
      </table>
      <p>퀵메모와 메모장 탭은 같은 곳에 저장한다. 급히 적어 둔 것을 <b>메모장에서 열기</b> 로 넘겨 큰 화면에서 이어 쓸 수 있다.</p>

      <h3>메모장</h3>
      <table>
        <tr><th>키/동작</th><th>설명</th></tr>
        <tr><td><kbd>⌘⌃</kbd>(mac) / <kbd>Ctrl+Alt</kbd>(win) + <kbd>&#96;</kbd> · 왼쪽 위 <b>📝 메모</b></td><td>메모장 열기/닫기</td></tr>
        <tr><td>목록 열 제목 클릭</td><td>이름·크기·만든 날짜·마지막 작성 기준 정렬 (기본: 마지막 작성 최신순)</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>N</kbd></td><td>새 메모</td></tr>
        <tr><td><kbd>Ctrl/⌘</kbd>+<kbd>S</kbd></td><td>저장 (입력을 멈추면 자동 저장도 됨)</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>편집 화면에서 목록으로</td></tr>
      </table>
      <p>메모는 <code>&lt;앱 데이터&gt;/notes/*.md</code> 에 마크다운 파일로 저장된다. 목록의 <b>📂 폴더 열기</b> 로 실제 폴더를 열 수 있다.</p>

      <h3>정보 / 업데이트</h3>
      <p>메뉴 막대 <b>정보 → 버전</b> 에서 버전·빌드 날짜·개발자·GitHub 링크를 볼 수 있고, <b>정보 → 업데이트</b> 에서 새 버전 확인과 설치를 할 수 있다.</p>

      <h3>세션 복원</h3>
      <p>앱을 끌 때의 탭 구성(메인탭·서브탭 순서, 탭 이름, 분할 구조와 비율, 탐색기 고정 여부)을 저장해 두었다가 다시 켤 때 그대로 되살린다. 저장된 접속으로 등록된 서버는 자동으로 다시 연결된다.</p>

      <h3>탭 표시</h3>
      <table>
        <tr><th>표시</th><th>뜻</th></tr>
        
        <tr><td><span class="alert-demo">!</span> 초록 느낌표</td><td>Claude 가 생각을 끝냄 (그 창을 보고 있지 않을 때). 탭을 열거나 입력하면 사라진다</td></tr>
        <tr><td>점</td><td>그 밖의 모든 경우 — 연결 상태 (초록: 연결됨 / 회색: 종료 / 빨강: 실패)</td></tr>
      </table>
      <p>서브탭에 뜬 표시는 메인탭에도 함께 뜬다.</p>

      <h3>알림</h3>
      <p>
        터미널에서 Claude Code 가 사용자의 응답을 기다리면 해당 탭에 <span class="alert-demo">!</span> 표시가 뜬다.
        서브탭에 하나라도 있으면 메인탭에도 같이 표시되고, 그 탭을 열어 확인하면 사라진다.
      </p>
    `
  }
};
