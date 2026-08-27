'use strict';

/*
 * styles.css → styles-light.css 를 만든다. `npm run theme:light`
 *
 * 이 앱은 어두운 화면을 기준으로 만들어졌고, 색이 176종·403곳에 직접 박혀 있다.
 * 그걸 손으로 하나씩 밝은 값으로 옮기면 빠뜨리는 곳이 반드시 생긴다. 그래서
 * 색만 기계적으로 뒤집어 같은 규칙을 한 벌 더 만들고, styles.css 뒤에 얹는다
 * (선택자가 같으므로 나중 것이 이긴다).
 *
 * 뒤집는 방법
 *   - 무채색(채도 낮음)  : 밝기를 그대로 뒤집는다. 검정→흰색, 진회색→연회색.
 *   - 유채색(강조·경고색): 색상과 채도는 두고 밝기만 뒤집되, 흰 바탕에서 읽히도록
 *                          너무 밝거나 어두워지지 않게 가둔다.
 *   - 그림자 rgba(0,0,0,a): 밝은 바탕에서는 같은 진하기면 지저분해 보이므로 옅게.
 *   - 흰 덧칠 rgba(255,255,255,a): 밝은 바탕에서는 검정 덧칠이 되어야 한다.
 *
 * 기계로 안 되는 몇 군데(색 있는 단추 위의 흰 글씨 등)는 맨 아래 손질 규칙에서
 * 되돌린다.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'styles-light.css');

/* ------------------------------- 색 변환 ------------------------------- */

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
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
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 어두운 화면용 색 → 밝은 화면용 색 */
function flip(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s <= 0.14) return hslToRgb(h, s, 1 - l); // 무채색은 그대로 뒤집는다
  // 유채색: 색은 유지하고 밝기만 뒤집되 흰 바탕에서 읽히는 범위로
  return hslToRgb(h, Math.min(1, s * 0.95), clamp(1 - l, 0.28, 0.62));
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

function convertHex(m) {
  let body = m.slice(1);
  let alpha = '';
  if (body.length === 3 || body.length === 4) {
    if (body.length === 4) alpha = body[3] + body[3];
    body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
  } else if (body.length === 8) {
    alpha = body.slice(6);
    body = body.slice(0, 6);
  } else if (body.length !== 6) {
    return m;
  }
  const [r, g, b] = flip(parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha}`;
}

function convertRgb(m, fn, args) {
  const nums = args.split(/[,\s/]+/).filter(Boolean);
  if (nums.length < 3) return m;
  const r = parseFloat(nums[0]);
  const g = parseFloat(nums[1]);
  const b = parseFloat(nums[2]);
  let a = nums.length > 3 ? parseFloat(nums[3]) : null;
  // 그림자: 밝은 바탕에서는 같은 진하기면 너무 무겁다
  if (r < 12 && g < 12 && b < 12 && a !== null) {
    return `rgba(0, 0, 0, ${Math.round(a * 0.3 * 100) / 100})`;
  }
  // 흰 덧칠(hover 등)은 밝은 바탕에서 검정 덧칠이 되어야 한다
  if (r > 243 && g > 243 && b > 243 && a !== null) {
    return `rgba(0, 0, 0, ${Math.round(a * 0.55 * 100) / 100})`;
  }
  const [nr, ng, nb] = flip(r, g, b);
  return a === null ? `rgb(${nr}, ${ng}, ${nb})` : `rgba(${nr}, ${ng}, ${nb}, ${a})`;
}

/* --------------------------- 기계로 안 되는 손질 --------------------------- */
/*
 * 색 있는 바탕 위의 흰 글씨는 뒤집으면 안 된다 (파란 단추 위 검은 글씨가 된다).
 * 아이콘/배지처럼 원래 색을 유지해야 읽히는 것들도 여기서 되돌린다.
 */
const MANUAL = `
/* ------------------------- 손질 (기계 변환으로 안 되는 곳) ------------------------- */

/* 색이 칠해진 단추·배지 위의 글씨는 흰색을 지킨다 */
.set-seg button.on,
.set-primary,
.pomo-primary,
#modal .btn-primary,
.alert-badge {
  color: #ffffff;
}
.alert-badge {
  background: #1a7f37;
  box-shadow: 0 0 6px rgba(26, 127, 55, 0.45);
}

/* 터미널 판 바탕은 xterm 쪽 테마가 칠한다 — CSS 가 덧칠하면 어긋난다 */
.pane .term-host,
.xterm .xterm-screen {
  background: transparent;
}

/* 창 그림자는 밝은 바탕에서 옅게 */
.set-box,
.pomo-pop,
.ex-menu {
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
}
`;

/* --------------------------------- 실행 --------------------------------- */

const src = fs.readFileSync(SRC, 'utf8');
let n = 0;
let out = src
  .replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => {
    const v = convertHex(m);
    if (v !== m) n++;
    return v;
  })
  .replace(/\b(rgba?)\(([^)]+)\)/g, (m, fn, args) => {
    const v = convertRgb(m, fn, args);
    if (v !== m) n++;
    return v;
  });

out =
  `/*\n * 자동 생성 파일 — 고치지 마세요. \`npm run theme:light\` 로 다시 만듭니다.\n` +
  ` * 원본: styles.css (색만 밝은 화면용으로 뒤집은 것)\n */\n\n` +
  out +
  MANUAL;

fs.writeFileSync(OUT, out);
console.log(`styles-light.css 생성 — 색 ${n}곳 변환, ${(out.length / 1024).toFixed(0)}KB`);
