'use strict';

/**
 * SFTP 파일 탐색기용 세션 관리자.
 * 터미널 세션과는 별도의 ssh2 연결을 열어 SFTP 서브시스템만 사용한다.
 * (셸 세션과 분리해 두면 파일 작업이 터미널 입출력에 끼어들지 않는다)
 */

const fs = require('fs');
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

function open(profile) {
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
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)));
  });
}

function stat(id, p) {
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
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, (err) => (err ? reject(err) : resolve(true)));
  });
}

/** 빈 파일 생성 (이미 있으면 에러) */
function createFile(id, p) {
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.open(p, 'wx', (err, handle) => {
      if (err) return reject(err);
      sftp.close(handle, (e) => (e ? reject(e) : resolve(true)));
    });
  });
}

function rename(id, from, to) {
  const sftp = get(id);
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve(true)));
  });
}

/** 파일/폴더 삭제 (폴더는 재귀 삭제) */
async function remove(id, p) {
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

function close(id) {
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
  download,
  upload,
  close,
  closeAll,
  joinRemote
};
