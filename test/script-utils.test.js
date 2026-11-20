'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compareVersions, normalizeScript, isSecureScriptUrl, isJavaScriptFilename } = require('../lib/script-utils');
const { mapLimit } = require('../lib/concurrency');
const { pruneScriptBackups, MAX_BACKUPS_PER_SCRIPT } = require('../lib/script-backups');

test('compareVersions follows SemVer prerelease precedence', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('compareVersions keeps numeric fallback for userscript versions', () => {
  assert.equal(compareVersions('1.29.20', '1.9.99'), 1);
  assert.equal(compareVersions('2026.11.20.1', '2026.11.20'), 1);
});

test('normalizeScript ignores BOM, CRLF and trailing whitespace', () => {
  assert.equal(normalizeScript('\uFEFFa  \r\nb\r\n'), 'a\nb');
});

test('script URLs must remain on HTTPS', () => {
  assert.equal(isSecureScriptUrl('https://gist.githubusercontent.com/a/b/raw/x.user.js'), true);
  assert.equal(isSecureScriptUrl('http://gist.githubusercontent.com/a/b/raw/x.user.js'), false);
  assert.equal(isSecureScriptUrl('file:///tmp/x.user.js'), false);
});

test('only JavaScript files are injectable', () => {
  assert.equal(isJavaScriptFilename('a.user.js'), true);
  assert.equal(isJavaScriptFilename('a.js'), true);
  assert.equal(isJavaScriptFilename('a.json'), false);
});

test('mapLimit preserves order and limits concurrency', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([1, 2, 3, 4], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(peak, 2);
});

test('script backup retention keeps only the newest files', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pcl-backups-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < MAX_BACKUPS_PER_SCRIPT + 2; i++) {
    const file = path.join(dir, `demo.user.js.${i}.bak`);
    await fs.promises.writeFile(file, String(i));
    const stamp = new Date(Date.now() + i * 1000);
    await fs.promises.utimes(file, stamp, stamp);
  }
  await pruneScriptBackups(dir, 'demo.user.js');
  const remaining = await fs.promises.readdir(dir);
  assert.equal(remaining.length, MAX_BACKUPS_PER_SCRIPT);
  assert.equal(remaining.includes('demo.user.js.0.bak'), false);
  assert.equal(remaining.includes('demo.user.js.1.bak'), false);
});
