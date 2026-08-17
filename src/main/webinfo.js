'use strict';

/**
 * 웹 페인용 보조 정보.
 *  - 이 PC 에 설치된 크롬의 **북마크 바** 를 읽어 온다 (Bookmarks 파일은 평범한 JSON 이다).
 *  - 앱에서 따로 추가한 북마크는 <userData>/webbookmarks.json 에 저장한다.
 *
 * 크롬의 로그인 세션·쿠키는 암호화되어 있고 크롬이 파일을 점유하므로 가져올 수 없다.
 * 그래서 "크롬에서 열기" 버튼으로 진짜 크롬에 넘기는 길도 함께 제공한다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/** OS 별 크롬 Bookmarks 파일 후보 */
function chromeBookmarkFiles() {
  const home = os.homedir();
  const profiles = ['Default', 'Profile 1', 'Profile 2'];
  const bases = [];

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    bases.push(path.join(local, 'Google', 'Chrome', 'User Data'));
    bases.push(path.join(local, 'Microsoft', 'Edge', 'User Data'));
  } else if (process.platform === 'darwin') {
    bases.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
    bases.push(path.join(home, 'Library', 'Application Support', 'Microsoft Edge'));
  } else {
    bases.push(path.join(home, '.config', 'google-chrome'));
    bases.push(path.join(home, '.config', 'chromium'));
  }

  const out = [];
  for (const base of bases) {
    for (const p of profiles) out.push(path.join(base, p, 'Bookmarks'));
  }
  return out;
}

/** 북마크 트리에서 링크만 뽑아낸다 (폴더는 한 단계 펼침) */
function flatten(node, depth = 0, out = []) {
  if (!node) return out;
  if (node.type === 'url' && node.url) {
    out.push({ name: node.name || node.url, url: node.url });
  } else if (node.children && depth < 3) {
    for (const c of node.children) flatten(c, depth + 1, out);
  }
  return out;
}

function chromeBookmarks(limit = 40) {
  for (const file of chromeBookmarkFiles()) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bar = data.roots && data.roots.bookmark_bar;
      const items = flatten(bar);
      if (items.length) return { source: file, items: items.slice(0, limit) };
    } catch (err) {
      /* 다음 후보로 */
    }
  }
  return { source: null, items: [] };
}

/* ------------------------------- 내 북마크 ------------------------------- */

const myFile = () => path.join(app.getPath('userData'), 'webbookmarks.json');

function myBookmarks() {
  try {
    const arr = JSON.parse(fs.readFileSync(myFile(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    return [];
  }
}

function addBookmark(item) {
  const list = myBookmarks().filter((b) => b.url !== item.url);
  list.unshift({ name: item.name || item.url, url: item.url });
  fs.mkdirSync(path.dirname(myFile()), { recursive: true });
  fs.writeFileSync(myFile(), JSON.stringify(list.slice(0, 60), null, 2), 'utf8');
  return list;
}

function removeBookmark(url) {
  const list = myBookmarks().filter((b) => b.url !== url);
  fs.writeFileSync(myFile(), JSON.stringify(list, null, 2), 'utf8');
  return list;
}

/** 북마크 바에 보여줄 목록 (내 북마크 먼저, 그 다음 크롬에서 읽어온 것) */
function bookmarks() {
  const chrome = chromeBookmarks();
  const mine = myBookmarks();
  const seen = new Set(mine.map((b) => b.url));
  const merged = mine.map((b) => ({ ...b, mine: true }));
  for (const b of chrome.items) {
    if (seen.has(b.url)) continue;
    seen.add(b.url);
    merged.push({ ...b, mine: false });
  }
  return { chromeSource: chrome.source, items: merged };
}

module.exports = { bookmarks, addBookmark, removeBookmark, chromeBookmarks };
