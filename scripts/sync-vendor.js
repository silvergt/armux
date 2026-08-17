'use strict';

/**
 * node_modules 의 xterm 배포 파일을 src/renderer/vendor 로 복사한다.
 * 렌더러는 번들러 없이 <script> 태그로 이 파일들을 로드하므로,
 * 패키징(asar) 시 경로 문제가 없도록 앱 소스 안에 함께 둔다.
 * xterm 버전을 올린 뒤에는 `npm run vendor` 를 다시 실행할 것.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
  ['node_modules/@xterm/addon-search/lib/addon-search.js', 'addon-search.js']
];

fs.mkdirSync(out, { recursive: true });
for (const [src, dst] of files) {
  fs.copyFileSync(path.join(root, src), path.join(out, dst));
  console.log('copied', dst);
}
