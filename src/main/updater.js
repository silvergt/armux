'use strict';

/**
 * GitHub Releases 기반 자동 업데이트.
 *
 * 동작 방식
 *   1. 새 릴리스가 있는지 확인 (public 저장소라 토큰 없이 조회된다)
 *   2. 사용자가 "내려받기" 를 누르면 설치본을 내려받고
 *   3. "지금 설치" 를 누르면 앱을 껐다 켜며 설치한다
 *
 * 주의: 자동 설치는 **NSIS 설치본(.exe)** 이나 mac dmg/zip 처럼
 * 업데이트 메타데이터(latest.yml)와 함께 배포된 빌드에서만 동작한다.
 * 압축본(zip)을 직접 풀어 쓰는 경우에는 확인만 하고 릴리스 페이지를 안내한다.
 */

const { app, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const REPO = { owner: 'silvergt', repo: 'armux' };
const RELEASES_URL = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;

let send = () => {};
let state = { status: 'idle', version: null, notes: null, error: null, progress: 0 };

function setState(patch) {
  state = { ...state, ...patch };
  send('update:state', state);
}

function init(sender) {
  send = sender;

  autoUpdater.autoDownload = false; // 사용자가 확인한 뒤에 내려받는다
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) =>
    setState({ status: 'available', version: info.version, notes: info.releaseNotes || null })
  );
  autoUpdater.on('update-not-available', () => setState({ status: 'none', version: null }));
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => setState({ status: 'ready', version: info.version, progress: 100 }));
  autoUpdater.on('error', (err) => setState({ status: 'error', error: cleanError(err) }));
}

function cleanError(err) {
  const msg = String((err && err.message) || err);
  if (/not packed|dev-app-update|ENOENT.*app-update\.yml/i.test(msg)) {
    return '이 빌드는 자동 업데이트를 지원하지 않습니다(개발 실행 또는 압축본). 릴리스 페이지에서 새 버전을 받아 주세요.';
  }
  if (/404|Cannot find latest/i.test(msg)) {
    return '아직 올라온 릴리스가 없습니다.';
  }
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg)) {
    return '네트워크에 연결할 수 없습니다.';
  }
  if (/code signature|codesign|not signed/i.test(msg)) {
    return 'macOS 는 코드 서명이 있어야 앱 안에서 설치까지 됩니다. 릴리스 페이지에서 새 버전을 받아 주세요.';
  }
  return msg.replace(/^Error:\s*/, '');
}

/** 업데이트 확인 */
async function check() {
  if (!app.isPackaged) {
    setState({
      status: 'unsupported',
      error: '개발 모드에서는 업데이트를 확인할 수 없습니다. 배포본에서 사용해 주세요.'
    });
    return state;
  }
  try {
    setState({ status: 'checking', error: null, progress: 0 });
    const res = await autoUpdater.checkForUpdates();
    if (!res || !res.updateInfo) return state;
    // 이벤트에서 상태가 갱신되지만, 혹시 이벤트가 오지 않은 경우를 대비
    if (state.status === 'checking') setState({ status: 'none' });
    return state;
  } catch (err) {
    setState({ status: 'error', error: cleanError(err) });
    return state;
  }
}

async function download() {
  try {
    setState({ status: 'downloading', progress: 0, error: null });
    await autoUpdater.downloadUpdate();
    return state;
  } catch (err) {
    setState({ status: 'error', error: cleanError(err) });
    return state;
  }
}

function install() {
  // 다운로드가 끝난 상태에서만 의미가 있다
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

const openReleases = () => shell.openExternal(RELEASES_URL);
const getState = () => state;

module.exports = { init, check, download, install, openReleases, getState, RELEASES_URL, REPO };
