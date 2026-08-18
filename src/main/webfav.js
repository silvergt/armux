'use strict';

/**
 * 웹 판 즐겨찾기 저장소. <userData>/webfavorites.json 에 사용자가 등록한 페이지를 둔다.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'webfavorites.json');

function list() {
  try {
    const arr = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function save(arr) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(arr, null, 2), 'utf8');
}

function add(item) {
  const url = String(item && item.url ? item.url : '').trim();
  if (!url) return list();
  const cur = list().filter((f) => f.url !== url); // 같은 URL 은 하나만
  cur.unshift({ name: (item.name || url).slice(0, 80), url });
  save(cur.slice(0, 100));
  return list();
}

function remove(url) {
  save(list().filter((f) => f.url !== url));
  return list();
}

module.exports = { list, add, remove };
