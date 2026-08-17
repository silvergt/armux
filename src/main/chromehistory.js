'use strict';

/**
 * 이 PC 에 설치된 크롬(또는 엣지/크로미움)의 **방문 기록**을 읽어 온다.
 * 웹 판 주소창 자동완성에만 쓰는 읽기 전용 기능이다.
 *
 * - History DB 는 SQLite 다. 쿠키·비밀번호 같은 암호화된 값은 건드리지 않고,
 *   url / title / visit_count / last_visit_time 만 읽는다.
 * - 크롬이 실행 중이면 파일이 잠겨 있으므로, 임시 폴더로 복사한 뒤 읽는다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  DatabaseSync = null;
}

/** OS 별 크롬/엣지/크로미움 History 파일 후보 */
function historyFiles() {
  const home = os.homedir();
  const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'];
  const bases = [];

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    bases.push(path.join(local, 'Google', 'Chrome', 'User Data'));
    bases.push(path.join(local, 'Microsoft', 'Edge', 'User Data'));
    bases.push(path.join(local, 'Chromium', 'User Data'));
  } else if (process.platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    bases.push(path.join(sup, 'Google', 'Chrome'));
    bases.push(path.join(sup, 'Microsoft Edge'));
    bases.push(path.join(sup, 'Chromium'));
  } else {
    bases.push(path.join(home, '.config', 'google-chrome'));
    bases.push(path.join(home, '.config', 'microsoft-edge'));
    bases.push(path.join(home, '.config', 'chromium'));
  }

  const out = [];
  for (const base of bases) {
    for (const p of profiles) out.push(path.join(base, p, 'History'));
  }
  return out;
}

let cache = { at: 0, rows: [] };

/** 모든 프로필의 기록을 모아 (url, title, visits) 목록으로. 20초 캐시. */
function loadAll() {
  if (!DatabaseSync) return [];
  if (Date.now() - cache.at < 20000) return cache.rows;

  const tmpDir = path.join(app.getPath('temp'), 'armux-chrome-history');
  fs.mkdirSync(tmpDir, { recursive: true });

  const merged = new Map(); // url -> {url, title, visits, last}
  let i = 0;
  for (const file of historyFiles()) {
    if (!fs.existsSync(file)) continue;
    const copy = path.join(tmpDir, `h${i++}.sqlite`);
    let db = null;
    try {
      fs.copyFileSync(file, copy); // 잠금 회피용 사본
      db = new DatabaseSync(copy, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT url, title, visit_count AS visits
             FROM urls WHERE hidden = 0 AND url LIKE 'http%'
             ORDER BY visit_count DESC LIMIT 3000`
        )
        .all();
      for (const r of rows) {
        const prev = merged.get(r.url);
        if (!prev || r.visits > prev.visits) merged.set(r.url, r);
      }
    } catch (e) {
      /* 이 프로필은 건너뛴다 */
    } finally {
      try {
        if (db) db.close();
      } catch (e) {
        /* noop */
      }
      try {
        fs.rmSync(copy, { force: true });
      } catch (e) {
        /* noop */
      }
    }
  }

  cache = { at: Date.now(), rows: Array.from(merged.values()) };
  return cache.rows;
}

/** 입력어에 맞는 자동완성 후보 (방문 많은 순) */
function suggest(query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const rows = loadAll();

  const scored = [];
  for (const r of rows) {
    const url = r.url.toLowerCase();
    const title = (r.title || '').toLowerCase();
    const inUrl = url.includes(q);
    const inTitle = title.includes(q);
    if (!inUrl && !inTitle) continue;
    // 호스트 시작 부분에서 맞으면 가장 높게, 그다음 URL 포함, 제목 포함
    let score = r.visits || 1;
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, '');
      if (host.startsWith(q)) score += 100000;
    } catch (e) {
      /* noop */
    }
    if (inUrl) score += 1000;
    scored.push({ url: r.url, title: r.title || '', score });
  }
  scored.sort((a, b) => b.score - a.score);

  // 같은 호스트가 너무 많이 뜨지 않게 살짝 정리
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (out.length >= limit) break;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ url: s.url, title: s.title });
  }
  return out;
}

const available = () => Boolean(DatabaseSync) && historyFiles().some((f) => fs.existsSync(f));

module.exports = { suggest, available };
