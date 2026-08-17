'use strict';

/**
 * 메모장 저장소.
 * 메모는 <userData>/notes/*.md 로 저장한다 (평범한 마크다운 파일이라 다른 편집기로도 열 수 있다).
 */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const dir = () => path.join(app.getPath('userData'), 'notes');

function ensureDir() {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 파일명으로 쓸 수 없는 문자를 정리 */
function safeName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '제목 없는 메모';
}

function fileFor(name) {
  return path.join(ensureDir(), `${safeName(name)}.md`);
}

/** 메모 목록 (마지막 수정이 최신인 순) */
function list() {
  const d = ensureDir();
  return fs
    .readdirSync(d)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map((f) => {
      const full = path.join(d, f);
      const st = fs.statSync(full);
      return {
        name: f.replace(/\.md$/i, ''),
        file: full,
        size: st.size,
        createdAt: st.birthtimeMs || st.ctimeMs,
        updatedAt: st.mtimeMs
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function read(name) {
  try {
    return fs.readFileSync(fileFor(name), 'utf8');
  } catch (err) {
    return '';
  }
}

function write(name, content) {
  const file = fileFor(name);
  fs.writeFileSync(file, content ?? '', 'utf8');
  const st = fs.statSync(file);
  return { name: safeName(name), file, updatedAt: st.mtimeMs, createdAt: st.birthtimeMs || st.ctimeMs };
}

/** 새 메모 만들기. 같은 이름이 있으면 (2), (3) … 을 붙인다. */
function create(baseName) {
  const base = safeName(baseName || '새 메모');
  let name = base;
  let i = 2;
  while (fs.existsSync(fileFor(name))) name = `${base} (${i++})`;
  return write(name, '');
}

function rename(from, to) {
  const src = fileFor(from);
  const dst = fileFor(to);
  if (src === dst) return { name: safeName(to), file: dst };
  if (fs.existsSync(dst)) throw new Error('같은 이름의 메모가 이미 있습니다.');
  fs.renameSync(src, dst);
  return { name: safeName(to), file: dst };
}

function remove(name) {
  fs.rmSync(fileFor(name), { force: true });
  return true;
}

/** 메모 폴더를 파일 탐색기/Finder 로 열기 */
function reveal() {
  shell.openPath(ensureDir());
  return ensureDir();
}

module.exports = { list, read, write, create, rename, remove, reveal, dir: ensureDir };
