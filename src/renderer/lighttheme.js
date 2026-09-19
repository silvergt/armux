'use strict';

/*
 * 밝은 모드 — 앱 전체를 밝게.
 *
 * 스타일시트에 박힌 색이 수백 군데라, 규칙을 손으로 한 벌 더 쓰면 새 화면을 만들 때마다
 * 빠뜨린다. 그래서 시작할 때 로드된 CSS 규칙을 전부 훑어, 색이 들어간 선언마다
 * "html.ui-light <선택자> { 밝게 바꾼 색 }" 규칙을 만들어 끼워 넣는다.
 *
 *   - 무채색(배경·글자·선)은 밝기를 뒤집는다: 검은 배경 → 흰 배경, 밝은 글자 → 어두운 글자
 *   - 유채색 글자는 흰 배경에서 읽히도록 어둡게, 어두운 유채색 배경은 옅은 색으로
 *   - 진한 색 버튼(초록 AI 버튼 등)은 그대로 두고, 그 위 글자도 그대로 둔다
 *
 * 자동 변환이 어색한 곳은 light.css 에서 손으로 바로잡는다(이 규칙들 뒤에 온다).
 * 터미널(xterm) 은 자기 팔레트(THEME_LIGHT)가 따로 있으므로 건드리지 않는다.
 */
(function () {
  const SKIP_SHEETS = /vendor\/xterm\.css$|light\.css$/;

  // --- 색 변환 -------------------------------------------------------------

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // 색 성분 차이(채도의 실제 크기)가 작으면 무채색으로 본다.
  // HSL 채도는 어두운 색에서 과장되므로(#141a22 도 s≈0.26) 성분 차이로 판단한다.
  const chromaOf = (r, g, b) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const isNeutralRgb = (r, g, b) => chromaOf(r, g, b) < 0.12;

  /**
   * role: 'fg'(글자·아이콘) | 'bg'(배경) | 'line'(테두리·밑줄) | 'shadow'
   * 돌려주는 값: [r,g,b] 또는 null(바꾸지 않음)
   */
  function mapRgb(r, g, b, role) {
    const [h, s, l] = rgbToHsl(r, g, b);
    let nl;
    if (isNeutralRgb(r, g, b)) {
      if (role === 'fg') nl = clamp(1 - l, 0.12, 0.62);
      else if (role === 'line') nl = 1 - l * 0.85;
      else nl = 1 - l * 0.6; // 배경: #000 → 흰색, #16181c → 거의 흰색, #3a3f49 → 옅은 회색
      return hslToRgb(h, Math.min(s, 0.12), nl);
    }
    if (role === 'fg') {
      if (l <= 0.45) return null;
      return hslToRgb(h, s, clamp(0.36 - (l - 0.5) * 0.2, 0.26, 0.4));
    }
    if (role === 'bg') {
      if (l >= 0.33) return null; // 진한 색 버튼·표식은 그대로
      return hslToRgb(h, clamp(s * 0.9, 0.3, 0.8), 0.9 - l * 0.25);
    }
    if (role === 'line') {
      if (l >= 0.4) return null;
      return hslToRgb(h, clamp(s, 0.3, 0.7), 0.72);
    }
    return null;
  }

  const COLOR_RE = /rgba?\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/g;

  /** 값 안의 모든 rgb()/rgba() 를 바꾼다. 바뀐 게 없으면 null */
  function mapValue(value, role) {
    let changed = false;
    const out = value.replace(COLOR_RE, (m, r, g, b, a) => {
      let alpha = a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
      if (role === 'shadow') {
        // 그림자는 검정 그대로, 밝은 바탕에 맞게 옅게. 밝은 빛 번짐(glow)은 없앤다
        const [, , l] = rgbToHsl(+r, +g, +b);
        changed = true;
        if (l > 0.5 && isNeutralRgb(+r, +g, +b)) return 'rgba(0, 0, 0, 0)';
        return `rgba(${r}, ${g}, ${b}, ${+(alpha * 0.45).toFixed(3)})`;
      }
      // 반투명 검정 배경(모달 뒤 가림막)은 그대로 어둡게 — 옅게만
      if (role === 'bg' && alpha < 0.95 && Math.max(+r, +g, +b) < 20 && alpha >= 0.2) {
        changed = true;
        return `rgba(0, 0, 0, ${+(alpha * 0.6).toFixed(3)})`;
      }
      const res = mapRgb(+r, +g, +b, role);
      if (!res) return m;
      changed = true;
      return alpha >= 1 ? `rgb(${res.join(', ')})` : `rgba(${res.join(', ')}, ${alpha})`;
    });
    return changed ? out : null;
  }

  function roleOf(prop) {
    if (prop === 'color' || prop === 'fill' || prop === 'stroke' || prop === 'caret-color' ||
        prop === '-webkit-text-fill-color' || prop === 'text-decoration-color') return 'fg';
    if (prop.startsWith('background')) return 'bg';
    if (prop === 'box-shadow' || prop === 'text-shadow' || prop === 'filter') return 'shadow';
    if (prop.startsWith('border') || prop.startsWith('outline') || prop === 'column-rule-color' ||
        prop === 'scrollbar-color') return 'line';
    return null;
  }

  // 배경이 "그대로 두는 진한 색" 이면 그 위 글자도 그대로 둬야 읽힌다
  const STRONG_VAR_BG = /var\(--(accent|danger|ok)\)/;
  function keepsStrongBg(style) {
    const bg = style.getPropertyValue('background-color') || style.getPropertyValue('background');
    if (!bg) return false;
    if (STRONG_VAR_BG.test(bg) && !/--accent-dim/.test(bg)) return true;
    COLOR_RE.lastIndex = 0;
    const m = COLOR_RE.exec(bg);
    COLOR_RE.lastIndex = 0;
    if (!m) return false;
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (alpha < 0.6) return false;
    const [, , l] = rgbToHsl(+m[1], +m[2], +m[3]);
    return !isNeutralRgb(+m[1], +m[2], +m[3]) && l >= 0.33;
  }

  // --- 선택자 -----------------------------------------------------------------

  function scopeSelector(sel) {
    return sel
      .split(',')
      .map((part) => {
        const p = part.trim();
        if (!p) return p;
        if (/^:root\b/.test(p)) return p.replace(/^:root/, 'html.ui-light');
        if (/^html\b/.test(p)) return p.replace(/^html/, 'html.ui-light');
        return 'html.ui-light ' + p;
      })
      .join(', ');
  }

  // --- 규칙 만들기 --------------------------------------------------------------

  function convertStyleRule(rule) {
    const st = rule.style;
    const keepFg = keepsStrongBg(st);
    const decls = [];
    for (let i = 0; i < st.length; i++) {
      const prop = st[i];
      if (prop.startsWith('--')) continue; // 변수는 light.css 에서 직접 정한다
      const role = roleOf(prop);
      if (!role) continue;
      if (role === 'fg' && keepFg) continue;
      const v = st.getPropertyValue(prop);
      if (!v || v.includes('var(')) continue;
      const nv = mapValue(v, role);
      if (nv === null) continue;
      const imp = st.getPropertyPriority(prop) ? ' !important' : '';
      decls.push(`${prop}: ${nv}${imp};`);
    }
    if (!decls.length) return '';
    return `${scopeSelector(rule.selectorText)} { ${decls.join(' ')} }`;
  }

  function convertRules(rules) {
    const out = [];
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const r = convertStyleRule(rule);
        if (r) out.push(r);
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        const inner = convertRules(rule.cssRules);
        if (inner.length) out.push(`@media ${rule.conditionText} { ${inner.join('\n')} }`);
      } else if (rule.cssRules && rule.type === CSSRule.SUPPORTS_RULE) {
        const inner = convertRules(rule.cssRules);
        if (inner.length) out.push(`@supports ${rule.conditionText} { ${inner.join('\n')} }`);
      }
    }
    return out;
  }

  let built = false;
  function build() {
    if (built) return;
    built = true;
    const parts = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const href = sheet.href || '';
      if (SKIP_SHEETS.test(href)) continue;
      if (sheet.ownerNode && sheet.ownerNode.id === 'light-auto') continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (err) {
        continue;
      }
      parts.push(...convertRules(rules));
    }
    const style = document.createElement('style');
    style.id = 'light-auto';
    style.textContent = parts.join('\n');
    // 손으로 고친 규칙(light.css)이 이긴다 — 그 앞에 끼운다
    const hand = document.querySelector('link[href="light.css"]');
    if (hand) hand.parentNode.insertBefore(style, hand);
    else document.head.appendChild(style);
  }

  /** 밝은 모드 켜기/끄기. 처음 켤 때 한 번만 규칙을 만든다 */
  function apply(light) {
    if (light) build();
    document.documentElement.classList.toggle('ui-light', !!light);
  }

  window.armuxLight = { apply, _mapValue: mapValue };
})();
