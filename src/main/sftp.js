'use strict';

/**
 * SFTP 파일 탐색기용 세션 관리자.
 * 터미널 세션과는 별도의 ssh2 연결을 열어 SFTP 서브시스템만 사용한다.
 * (셸 세션과 분리해 두면 파일 작업이 터미널 입출력에 끼어들지 않는다)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { buildConnectConfig } = require('./sshconfig');

const sessions = new Map(); // sftpId -> { client, sftp }

/** 원격 경로 결합 (항상 POSIX 규칙) */
function joinRemote(base, name) {
  if (base === '/') return `/${name}`;
  return `${base.replace(/\/+$/, '')}/${name}`;
}

/* ------------------------------- 로컬 모드 -------------------------------
 * 로컬 터미널 그룹의 파일 탐색기. SSH 대신 이 PC 의 파일시스템을 그대로 쓰되,
 * 결과 모양(list/stat/readFile …)을 원격과 똑같이 맞춰 렌더러·뷰어가 구분 없이
 * 동작하게 한다. 경로는 윈도우에서도 / 로 통일한다(렌더러가 / 로 잇는다).
 */

const isLocalId = (id) => {
  const s = sessions.get(id);
  return Boolean(s && s.local);
};

const slash = (p) => String(p).split(path.sep).join('/');

/** '.'·'~' 를 홈으로, '~/x' 를 홈 아래로 푼다 */
function localResolve(p) {
  if (!p || p === '.' || p === '~') return slash(os.homedir());
  if (p.startsWith('~/')) return slash(path.join(os.homedir(), p.slice(2)));
  return p;
}

/** 'drwxr-xr-x' 모양의 권한 문자열 (탐색기 우클릭 정보에 쓰인다) */
function modeToRights(mode, type) {
  const c = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  let out = c;
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7;
    out += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
  }
  return out;
}

async function listLocal(dir) {
  const d = localResolve(dir);
  const names = await fs.promises.readdir(d);
  const out = [];
  for (const name of names) {
    const full = joinRemote(d, name);
    let st;
    try {
      st = await fs.promises.lstat(full);
    } catch (e) {
      continue; // 읽는 사이 사라졌거나 권한이 없는 항목은 건너뛴다
    }
    const type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file';
    const ent = {
      name,
      path: full,
      type,
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode,
      rights: modeToRights(st.mode, type)
    };
    if (type === 'link') {
      try {
        if ((await fs.promises.stat(full)).isDirectory()) ent.linkToDir = true;
      } catch (e) {
        /* 끊어진 링크 */
      }
    }
    out.push(ent);
  }
  out.sort((a, b) => {
    const ad = a.type === 'dir' || a.linkToDir ? 0 : 1;
    const bd = b.type === 'dir' || b.linkToDir ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, 'ko');
  });
  return out;
}

async function statLocal(p) {
  const st = await fs.promises.stat(localResolve(p));
  return { type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
}

function open(profile) {
  // 로컬 터미널 그룹: 연결 없이 곧바로 세션을 만든다
  if (profile && profile.local) {
    const id = crypto.randomUUID();
    sessions.set(id, { local: true });
    return Promise.resolve(id);
  }
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const client = new Client();

    const fail = (err) => {
      try {
        client.end();
      } catch (e) {
        /* noop */
      }
      sessions.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    client
      .on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) return fail(err);
          sessions.set(id, { client, sftp });
          resolve(id);
        });
      })
      .on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => profile.password || ''));
      })
      .on('error', fail)
      .on('end', () => sessions.delete(id));

    try {
      client.connect(buildConnectConfig(profile));
    } catch (err) {
      fail(err);
    }
  });
}

function get(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('SFTP 세션이 없습니다. 다시 연결해 주세요.');
  return s.sftp;
}

/** 심볼릭 링크는 실제 대상 종류를 알아야 폴더인지 판단할 수 있다 */
function entryType(attrs) {
  if (attrs.isDirectory && attrs.isDirectory()) return 'dir';
  if (attrs.isSymbolicLink && attrs.isSymbolicLink()) return 'link';
  return 'file';
}

function list(id, dir) {
  if (isLocalId(id)) return listLocal(dir);
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, async (err, entries) => {
      if (err) return reject(err);
      const out = entries.map((e) => ({
        name: e.filename,
        path: joinRemote(dir, e.filename),
        type: entryType(e.attrs),
        size: e.attrs.size,
        mtime: e.attrs.mtime * 1000,
        mode: e.attrs.mode,
        rights: e.longname ? e.longname.slice(0, 10) : ''
      }));

      // 심볼릭 링크가 폴더를 가리키면 폴더처럼 다룰 수 있게 표시해 둔다
      await Promise.all(
        out
          .filter((e) => e.type === 'link')
          .map(
            (e) =>
              new Promise((res) => {
                sftp.stat(e.path, (er, attrs) => {
                  if (!er && attrs.isDirectory()) e.linkToDir = true;
                  res();
                });
              })
          )
      );

      out.sort((a, b) => {
        const ad = a.type === 'dir' || a.linkToDir ? 0 : 1;
        const bd = b.type === 'dir' || b.linkToDir ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name, 'ko');
      });
      resolve(out);
    });
  });
}

function realpath(id, p) {
  if (isLocalId(id)) return fs.promises.realpath(localResolve(p)).then(slash);
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
  });
}

function stat(id, p) {
  if (isLocalId(id)) return statLocal(p);
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, attrs) =>
      err
        ? reject(err)
        : resolve({
            type: attrs.isDirectory() ? 'dir' : 'file',
            size: attrs.size,
            mtime: attrs.mtime * 1000
          })
    );
  });
}

function mkdir(id, p) {
  if (isLocalId(id)) return fs.promises.mkdir(localResolve(p)).then(() => true);
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, (err) => (err ? reject(err) : resolve(true)));
  });
}

/** 빈 파일 생성 (이미 있으면 에러) */
function createFile(id, p) {
  if (isLocalId(id)) {
    // 'wx' — 이미 있으면 원격과 똑같이 실패한다
    return fs.promises.writeFile(localResolve(p), '', { flag: 'wx' }).then(() => true);
  }
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.open(p, 'wx', (err, handle) => {
      if (err) return reject(err);
      sftp.close(handle, (e) => (e ? reject(e) : resolve(true)));
    });
  });
}

function rename(id, from, to) {
  if (isLocalId(id)) return fs.promises.rename(localResolve(from), localResolve(to)).then(() => true);
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve(true)));
  });
}

/** 파일/폴더 삭제 (폴더는 재귀 삭제) */
async function remove(id, p) {
  if (isLocalId(id)) {
    // recursive 만 켜고 force 는 끈다 — 없는 경로를 지웠다고 조용히 성공하면 안 된다
    await fs.promises.rm(localResolve(p), { recursive: true });
    return true;
  }
  const sftp = get(id);
  const info = await stat(id, p).catch(() => null);
  if (info && info.type === 'dir') {
    const entries = await list(id, p);
    for (const e of entries) await remove(id, e.path);
    return new Promise((resolve, reject) => sftp.rmdir(p, (err) => (err ? reject(err) : resolve(true))));
  }
  return new Promise((resolve, reject) => sftp.unlink(p, (err) => (err ? reject(err) : resolve(true))));
}

/** 원격 → 로컬 다운로드 (폴더면 재귀) */
async function download(id, remote, local, onProgress) {
  if (isLocalId(id)) {
    const src = localResolve(remote);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await fs.promises.cp(src, local, { recursive: true });
    if (onProgress) {
      const st = await fs.promises.stat(local).catch(() => null);
      if (st && st.isFile()) onProgress(remote, st.size, st.size);
    }
    return local;
  }
  const sftp = get(id);
  const info = await stat(id, remote);
  if (info.type === 'dir') {
    fs.mkdirSync(local, { recursive: true });
    const entries = await list(id, remote);
    for (const e of entries) await download(id, e.path, path.join(local, e.name), onProgress);
    return local;
  }
  fs.mkdirSync(path.dirname(local), { recursive: true });
  await new Promise((resolve, reject) => {
    sftp.fastGet(
      remote,
      local,
      {
        step: (transferred, chunk, total) => onProgress && onProgress(remote, transferred, total)
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
  return local;
}

/** 로컬 → 원격 업로드 (폴더면 재귀) */
async function upload(id, local, remote, onProgress) {
  if (isLocalId(id)) {
    await fs.promises.cp(local, localResolve(remote), { recursive: true });
    if (onProgress) {
      const st = await fs.promises.stat(local).catch(() => null);
      if (st && st.isFile()) onProgress(local, st.size, st.size);
    }
    return remote;
  }
  const sftp = get(id);
  const st = fs.statSync(local);
  if (st.isDirectory()) {
    await mkdir(id, remote).catch(() => {}); // 이미 있으면 무시
    for (const name of fs.readdirSync(local)) {
      await upload(id, path.join(local, name), joinRemote(remote, name), onProgress);
    }
    return remote;
  }
  await new Promise((resolve, reject) => {
    sftp.fastPut(
      local,
      remote,
      {
        step: (transferred, chunk, total) => onProgress && onProgress(local, transferred, total)
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
  return remote;
}

/** 파일 내용을 읽어 base64 로 돌려준다. 너무 큰 파일은 거부(에디터 렉 방지) */
function readFile(id, p, maxBytes = 20 * 1024 * 1024) {
  if (isLocalId(id)) {
    const fp = localResolve(p);
    return fs.promises.stat(fp).then((st) => {
      if (st.size > maxBytes) {
        throw new Error(`파일이 너무 큽니다 (${Math.round(st.size / 1048576)}MB). 20MB 이하만 열 수 있습니다.`);
      }
      return fs.promises.readFile(fp).then((buf) => ({ base64: buf.toString('base64'), size: buf.length }));
    });
  }
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, attrs) => {
      if (err) return reject(err);
      if (attrs.size > maxBytes) {
        return reject(new Error(`파일이 너무 큽니다 (${Math.round(attrs.size / 1048576)}MB). 20MB 이하만 열 수 있습니다.`));
      }
      sftp.readFile(p, (e2, buf) => {
        if (e2) return reject(e2);
        resolve({ base64: buf.toString('base64'), size: buf.length });
      });
    });
  });
}

/** base64 내용을 파일에 쓴다 */
function writeFile(id, p, base64) {
  if (isLocalId(id)) return fs.promises.writeFile(localResolve(p), Buffer.from(base64 || '', 'base64')).then(() => true);
  const sftp = get(id);
  const buf = Buffer.from(base64 || '', 'base64');
  return new Promise((resolve, reject) => {
    sftp.writeFile(p, buf, (err) => (err ? reject(err) : resolve(true)));
  });
}

function close(id) {
  if (isLocalId(id)) {
    sessions.delete(id);
    return;
  }
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.client.end();
  } catch (e) {
    /* noop */
  }
  sessions.delete(id);
}

function closeAll() {
  for (const id of Array.from(sessions.keys())) close(id);
}

module.exports = {
  open,
  list,
  realpath,
  stat,
  mkdir,
  createFile,
  rename,
  remove,
  readFile,
  writeFile,
  download,
  upload,
  close,
  closeAll,
  joinRemote
};
