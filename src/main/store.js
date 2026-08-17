'use strict';

/**
 * 저장된 SSH 호스트 프로필 관리.
 * 파일 위치: <userData>/hosts.json
 * 비밀번호는 OS 키체인 기반 safeStorage 로 암호화해서 저장한다(불가능한 환경이면 저장하지 않음).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

let filePath = null; // hosts.json 절대경로 (app ready 이후 결정)

function getFilePath() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'hosts.json');
  return filePath;
}

function readRaw() {
  try {
    const txt = fs.readFileSync(getFilePath(), 'utf8');
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed.hosts) ? parsed.hosts : [];
  } catch (err) {
    return [];
  }
}

function writeRaw(hosts) {
  const dir = path.dirname(getFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getFilePath(), JSON.stringify({ hosts }, null, 2), 'utf8');
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (err) {
    return false;
  }
}

function encrypt(plain) {
  if (!plain) return null;
  if (!canEncrypt()) return null; // 암호화 불가 환경에서는 평문 저장하지 않는다
  return safeStorage.encryptString(plain).toString('base64');
}

function decrypt(enc) {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (err) {
    return '';
  }
}

/** 렌더러로 넘기는 안전한 형태(비밀번호 제외) */
function toPublic(h) {
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType, // 'password' | 'key' | 'agent'
    privateKeyPath: h.privateKeyPath || '',
    hasSavedPassword: Boolean(h.password || h.passphrase),
    lastUsedAt: h.lastUsedAt || 0
  };
}

function list() {
  return readRaw()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .map(toPublic);
}

/** 저장/수정. profile.id 가 있으면 갱신, 없으면 신규 생성 */
function save(profile) {
  const hosts = readRaw();
  const id = profile.id || crypto.randomUUID();
  const idx = hosts.findIndex((h) => h.id === id);
  const prev = idx >= 0 ? hosts[idx] : {};

  const next = {
    id,
    name: profile.name || `${profile.username}@${profile.host}`,
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    authType: profile.authType || 'password',
    privateKeyPath: profile.privateKeyPath || '',
    lastUsedAt: profile.lastUsedAt || prev.lastUsedAt || 0,
    // 비밀번호/패스프레이즈: 새로 들어온 값이 있으면 암호화 저장, 없으면 기존 값 유지
    password: profile.savePassword && profile.password ? encrypt(profile.password) : prev.password || null,
    passphrase: profile.savePassword && profile.passphrase ? encrypt(profile.passphrase) : prev.passphrase || null
  };

  if (idx >= 0) hosts[idx] = next;
  else hosts.push(next);
  writeRaw(hosts);
  return toPublic(next);
}

function remove(id) {
  writeRaw(readRaw().filter((h) => h.id !== id));
}

/** 접속에 필요한 비밀정보까지 포함된 원본 프로필 (main 프로세스 전용) */
function getSecret(id) {
  const h = readRaw().find((x) => x.id === id);
  if (!h) return null;
  return {
    ...h,
    password: decrypt(h.password),
    passphrase: decrypt(h.passphrase)
  };
}

function touch(id) {
  const hosts = readRaw();
  const h = hosts.find((x) => x.id === id);
  if (!h) return;
  h.lastUsedAt = Date.now();
  writeRaw(hosts);
}

module.exports = { list, save, remove, getSecret, touch, canEncrypt };
