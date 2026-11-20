'use strict';

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

module.exports = {
  compareVersions,
  normalizeScript,
  isSecureScriptUrl,
  isJavaScriptFilename,
};
