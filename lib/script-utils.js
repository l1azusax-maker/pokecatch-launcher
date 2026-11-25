'use strict';

const path = require('path');
const semver = require('semver');

function compareVersions(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  const semverInput = (value) => value.replace(/^v(?=\d)/i, '');
  const leftSemver = semver.valid(semverInput(left));
  const rightSemver = semver.valid(semverInput(right));

  if (leftSemver && rightSemver) return semver.compare(leftSemver, rightSemver);

  const pa = left.split(/[.\-+_]/);
  const pb = right.split(/[.\-+_]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] === undefined ? '0' : pa[i];
    const y = pb[i] === undefined ? '0' : pb[i];
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      const nx = BigInt(x);
      const ny = BigInt(y);
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' });
    }
  }
  return 0;
}

function normalizeScript(content) {
  return String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function isSecureScriptUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isJavaScriptFilename(name) {
  return /(?:\.user)?\.js$/i.test(String(name || ''));
}

function safeScriptName(name, { fallback = '', ensureExtension = false } = {}) {
  // 同时处理 Windows 和 POSIX 路径分隔符，保证在任何平台或远程路径下都只取末段文件名
  const raw = String(name || '').replace(/\\/g, '/');
  let out = path.posix.basename(raw).replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '');
  if (!out || out === '.' || out === '..') out = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (ensureExtension && out && !/\.(user\.js|js)$/i.test(out)) out += '.user.js';
  return out;
}

function parseUserscriptMeta(content) {
  const meta = {};
  const m = String(content || '').match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (m) {
    const block = m[1];
    const grab = (key) => {
      const re = new RegExp('@' + key + '\\s+(.+)');
      const mm = block.match(re);
      return mm ? mm[1].trim() : '';
    };
    meta.name = grab('name');
    meta.version = grab('version');
    meta.downloadURL = grab('downloadURL');
    meta.updateURL = grab('updateURL');
    meta.description = grab('description');
  }
  return meta;
}

function looksLikeHtmlDocument(content) {
  const text = String(content || '');
  const head = text.slice(0, 3000);
  const looksHtml = /^\s*</.test(text) || /<html[\s>]|<head[\s>]|<!doctype/i.test(head);
  return looksHtml && !/==UserScript==/.test(head);
}

module.exports = {
  compareVersions,
  normalizeScript,
  isSecureScriptUrl,
  isJavaScriptFilename,
  safeScriptName,
  parseUserscriptMeta,
  looksLikeHtmlDocument,
};
