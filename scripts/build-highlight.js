// highlight.js 를 필요한 언어만 골라 단일 IIFE(vendor/highlight.js)로 번들.
// (highlight.js 의 exports 맵이 서브패스를 막으므로 실제 파일 절대경로로 import 한다)
const { execSync } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');
const root = path.join(__dirname, '..');
const libDir = path.join(root, 'node_modules', 'highlight.js', 'lib');
const langs = ['json','yaml','python','javascript','typescript','bash','shell','xml','css','markdown','go','rust','c','cpp','java','ini','sql','dockerfile','ruby','php'];
const varOf = (l) => 'l_' + l.replace(/[^a-z0-9]/g, '');
const entry = path.join(os.tmpdir(), 'armux-hljs-entry.js');
fs.writeFileSync(entry,
  `import hljs from ${JSON.stringify(path.join(libDir, 'core.js'))};\n` +
  langs.map((l) => `import ${varOf(l)} from ${JSON.stringify(path.join(libDir, 'languages', l + '.js'))};`).join('\n') +
  `\n` + langs.map((l) => `hljs.registerLanguage('${l}', ${varOf(l)});`).join('\n') +
  `\nwindow.hljs = hljs;\n`);
const out = path.join(root, 'src', 'renderer', 'vendor', 'highlight.js');
execSync(`"${path.join(root, 'node_modules', '.bin', 'esbuild')}" "${entry}" --bundle --format=iife --minify --outfile="${out}"`, { stdio: 'inherit' });
fs.copyFileSync(path.join(libDir, '..', 'styles', 'atom-one-dark.min.css'), path.join(root, 'src', 'renderer', 'vendor', 'highlight.css'));
console.log('built', out, fs.statSync(out).size, 'bytes');
