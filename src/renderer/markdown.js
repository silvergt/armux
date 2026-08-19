'use strict';

/**
 * 마크다운 → HTML.
 *
 * AI 답변과 .md 미리보기가 같이 쓴다. AI 가 보내는 글에는 코드블록·목록·표가
 * 섞여 오는데, 그대로 보여 주면 ``` 같은 기호가 날것으로 보인다.
 *
 * 들어오는 글은 믿을 수 없다고 보고(모델이 만든 글이다) 모든 글자를 먼저
 * 이스케이프한 뒤에만 태그를 만든다. 링크도 http(s) 만 통과시킨다.
 */

window.Markdown = (function () {
  const esc = (t) =>
    String(t)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // 인라인 코드를 잠시 빼 둘 때 쓰는 표식.
  // 사용자 글에 우연히 나올 수 없도록 사용자 영역(Private Use Area) 글자를 쓴다.
  const HOLE_A = '\uE000';
  const HOLE_B = '\uE001';

  /** 코드블록 한 덩이를 문법 색칠까지 해서 만든다 */
  function codeBlock(code, lang) {
    const body = String(code).replace(/\n$/, '');
    let inner = esc(body);
    let cls = 'hljs';
    if (lang && window.hljs) {
      // 모르는 언어면 hljs 가 예외를 던지므로 아는 언어일 때만 쓴다
      const known = window.hljs.getLanguage && window.hljs.getLanguage(lang);
      if (known) {
        try {
          inner = window.hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
          cls = 'hljs language-' + lang.replace(/[^\w-]/g, '');
        } catch (e) {
          /* 색칠 실패는 무시하고 그냥 보여 준다 */
        }
      }
    }
    const label = lang ? '<span class="md-lang">' + esc(lang) + '</span>' : '';
    // data-code 에 원문을 담아 두면 "복사" 가 색칠된 HTML 대신 원문을 준다
    return (
      '<div class="md-code">' + label +
      '<button class="md-copy" type="button" data-code="' + esc(body) + '">복사</button>' +
      '<pre class="md-pre"><code class="' + cls + '">' + inner + '</code></pre></div>'
    );
  }

  /** 줄 안쪽 서식 (굵게·기울임·인라인코드·링크) */
  function inline(text) {
    // 인라인 코드를 먼저 빼 두어야 그 안의 *, _ 가 서식으로 먹히지 않는다
    const holes = [];
    let t = String(text).replace(/`([^`]+)`/g, (m, code) => {
      holes.push('<code>' + esc(code) + '</code>');
      return HOLE_A + (holes.length - 1) + HOLE_B;
    });
    t = esc(t);
    t = t
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" class="md-link">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<>"']+)/g, '$1<a href="$2" class="md-link">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t.replace(new RegExp(HOLE_A + '(\\d+)' + HOLE_B, 'g'), (m, i) => holes[Number(i)]);
  }

  /** 표 한 덩이 (| a | b | 형태) */
  function table(rows) {
    const cells = (line) =>
      line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells); // 1번 줄은 --- 구분선
    const th = head.map((c) => '<th>' + inline(c) + '</th>').join('');
    const tr = body
      .map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>')
      .join('');
    return '<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
  }

  function render(md) {
    const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let list = null; // 'ul' | 'ol'
    let para = [];

    const closeList = () => {
      if (list) {
        html += '</' + list + '>';
        list = null;
      }
    };
    const flushPara = () => {
      if (para.length) {
        html += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
        para = [];
      }
    };
    const closeAll = () => {
      flushPara();
      closeList();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // ``` 코드블록. 닫는 줄이 아직 안 왔으면(스트리밍 중이면) 남은 줄이 모두 코드다.
      const fence = line.match(/^\s*```+\s*([\w+#.-]*)\s*$/);
      if (fence) {
        closeAll();
        const lang = fence[1] || '';
        const buf = [];
        i += 1;
        for (; i < lines.length; i++) {
          if (/^\s*```+\s*$/.test(lines[i])) break;
          buf.push(lines[i]);
        }
        html += codeBlock(buf.join('\n'), lang);
        continue;
      }

      // 표
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        closeAll();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(lines[i]);
          i += 1;
        }
        i -= 1;
        html += table(rows);
        continue;
      }

      if (!line.trim()) {
        closeAll();
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeAll();
        html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>';
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        closeAll();
        html += '<hr>';
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        closeAll();
        html += '<blockquote>' + inline(quote[1]) + '</blockquote>';
        continue;
      }

      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ol || ul) {
        flushPara();
        const want = ol ? 'ol' : 'ul';
        if (list !== want) {
          closeList();
          html += '<' + want + '>';
          list = want;
        }
        html += '<li>' + inline((ol || ul)[1]) + '</li>';
        continue;
      }

      closeList();
      para.push(line);
    }
    closeAll();
    return html;
  }

  /**
   * 만든 HTML 을 요소에 넣고 링크·"복사" 버튼을 연결한다.
   * 링크는 판 안에서 페이지가 통째로 넘어가지 않도록 기본 브라우저로 보낸다.
   */
  function into(el, md) {
    el.innerHTML = render(md);
    el.querySelectorAll('a.md-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.armux.util.openExternal(a.getAttribute('href'));
      });
    });
    el.querySelectorAll('button.md-copy').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        window.armux.util.clipboardWrite(b.dataset.code || '');
        b.textContent = '복사됨';
        setTimeout(() => {
          b.textContent = '복사';
        }, 1200);
      });
    });
  }

  return { render, into, esc };
})();
