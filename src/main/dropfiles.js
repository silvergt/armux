'use strict';

/**
 * 끌어다 놓은 파일 · 붙여넣은 스크린샷을 서버로 옮긴다.
 *
 * Claude Code 는 서버에서 돌아가므로 내 PC 의 경로나 클립보드를 볼 수 없다.
 * 그래서 파일을 서버의 한 곳(~/.armux/dropped)에 올려 두고, 그 "서버 경로" 를
 * 프롬프트에 넣어 준다. Claude Code 는 경로만 있으면 이미지도 읽는다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 지우기 규칙 (여기만큼은 느슨하게 두지 않는다)
 *
 *  R1. 지우는 곳은 오직 "$HOME/.armux/dropped" 한 곳이다. 경로를 바깥에서
 *      받지 않는다 — 인자로 받으면 언젠가 잘못된 값이 들어온다.
 *  R2. $HOME 이 비어 있으면 아무것도 하지 않는다.
 *  R3. 그 경로가 실제 디렉터리가 아니면(없거나, 파일이거나) 아무것도 하지 않는다.
 *  R4. 그 경로가 심볼릭 링크면 아무것도 하지 않는다. 링크를 따라가면 엉뚱한
 *      곳을 지우게 된다.
 *  R5. 바로 아래 한 겹만 본다(-maxdepth 1). 하위 폴더로 내려가지 않는다.
 *      우리는 하위 폴더를 만들지 않으므로, 있다면 남의 것이다.
 *  R6. 일반 파일만 지운다(-type f). 디렉터리·심볼릭 링크·소켓 따위는 건드리지
 *      않는다. (find 는 -L 없이는 링크를 따라가지 않으므로 -type f 에 링크는
 *      걸리지 않는다)
 *  R7. 마지막으로 고친 지 60분이 지난 것만 지운다(-mmin +60).
 *  R8. rm -rf 를 쓰지 않는다. find 의 -delete 로 위 조건에 맞는 것만 지운다.
 *      변수가 비어도 "rm -rf $EMPTY" 같은 사고가 날 수 없다.
 *
 * 위 조건을 모두 통과한 것만 사라진다. 하나라도 어긋나면 그냥 아무 일도
 * 일어나지 않는다(조용히 실패하는 쪽이 잘못 지우는 것보다 낫다).
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ssh = require('./ssh');
const sftp = require('./sftp');

/** 서버에서 파일을 모아 두는 곳 (이 이름은 바깥에서 바꿀 수 없다) */
const DROP_SUBPATH = '.armux/dropped';

/** 몇 분이 지난 것을 지울지 */
const MAX_AGE_MIN = 60;

/*
 * 폴더를 만들고, 오래된 것을 지우고, 절대 경로를 알려 주는 스크립트.
 * 위 R1~R8 을 그대로 옮긴 것이다. 경로는 여기서 $HOME 으로만 만든다.
 */
const PREPARE = `
set -e
[ -n "$HOME" ] || exit 0                       # R2
D="$HOME/${DROP_SUBPATH}"

# 링크를 만들어 두고 그리로 지우게 만드는 것을 막는다 (R4)
if [ -L "$D" ]; then
  echo "ARMUX_DROP_ERR:symlink"
  exit 0
fi

mkdir -p "$D" 2>/dev/null || true
if [ ! -d "$D" ]; then                          # R3
  echo "ARMUX_DROP_ERR:notdir"
  exit 0
fi
chmod 700 "$D" 2>/dev/null || true

# R5·R6·R7·R8 — 이 폴더 바로 아래의, 일반 파일이고, ${MAX_AGE_MIN}분 지난 것만
find "$D" -maxdepth 1 -type f -mmin +${MAX_AGE_MIN} -delete 2>/dev/null || true

echo "ARMUX_DROP_DIR:$D"
`.trim();

/**
 * 서버에 보관 폴더를 마련하고 오래된 파일을 정리한다.
 * @returns {Promise<string>} 서버의 절대 경로 (실패하면 빈 문자열)
 */
async function prepare(sessionId) {
  try {
    const { stdout } = await ssh.exec(sessionId, PREPARE, 15000);
    const m = String(stdout || '').match(/ARMUX_DROP_DIR:(.+)/);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

/** 파일 이름에서 위험한 글자를 걷어낸다 (경로 조각이 섞여 들어오지 못하게) */
function safeName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[^\w.\-가-힣]/g, '_').slice(0, 80);
  return cleaned || 'file';
}

/** 같은 이름이 부딪히지 않게 짧은 꼬리를 붙인다 */
function uniqueName(name) {
  const tag = crypto.randomBytes(3).toString('hex');
  const safe = safeName(name);
  const dot = safe.lastIndexOf('.');
  return dot > 0 ? `${safe.slice(0, dot)}-${tag}${safe.slice(dot)}` : `${safe}-${tag}`;
}

/**
 * 내 PC 의 파일들을 서버로 올린다.
 * @returns {Promise<{ dir, files: [{ name, remote }], error? }>}
 */
async function upload(sessionId, profile, localPaths) {
  const dir = await prepare(sessionId);
  if (!dir) return { dir: '', files: [], error: '서버에 보관 폴더를 만들지 못했습니다.' };

  let id = null;
  try {
    /*
     * sftp.open 은 "완성된 접속 프로필" 을 받는다. 저장된 호스트 id 나 임시
     * 자격증명(credId)을 프로필로 푸는 일은 main 이 맡고 있으므로, 여기서는
     * 이미 풀린 프로필을 받아 쓴다.
     */
    id = await sftp.open(profile);
    const files = [];
    for (const local of localPaths) {
      let st = null;
      try {
        st = fs.statSync(local);
      } catch (e) {
        continue; // 사라진 파일은 건너뛴다
      }
      if (st.isDirectory()) continue; // 폴더는 올리지 않는다 (한 번에 한 덩이만)
      const name = uniqueName(path.basename(local));
      const remote = `${dir}/${name}`;
      await sftp.upload(id, local, remote);
      files.push({ name: path.basename(local), remote });
    }
    return { dir, files };
  } catch (err) {
    return { dir, files: [], error: String((err && err.message) || err) };
  } finally {
    if (id) sftp.close(id);
  }
}

/**
 * 클립보드 이미지를 서버로 올린다.
 * @param {Buffer} png 이미지 바이트
 */
async function uploadImage(sessionId, profile, png) {
  const tmp = path.join(os.tmpdir(), `armux-paste-${Date.now()}.png`);
  try {
    fs.writeFileSync(tmp, png);
    const res = await upload(sessionId, profile, [tmp]);
    if (res.files[0]) res.files[0].name = '스크린샷.png';
    return res;
  } finally {
    try {
      fs.unlinkSync(tmp); // 내 PC 의 임시 파일은 바로 지운다
    } catch (e) {
      /* 이미 없으면 그만 */
    }
  }
}

module.exports = { prepare, upload, uploadImage, DROP_SUBPATH, MAX_AGE_MIN, safeName, uniqueName };
