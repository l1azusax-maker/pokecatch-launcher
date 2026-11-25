'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions,
  normalizeScript,
  isSecureScriptUrl,
  isJavaScriptFilename,
  safeScriptName,
  parseUserscriptMeta,
  looksLikeHtmlDocument,
} = require('../lib/script-utils');
const { mapLimit } = require('../lib/concurrency');

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

test('safeScriptName neutralizes traversal, reserved device names and bad chars', () => {
  assert.equal(safeScriptName('../../evil/test.user.js'), 'test.user.js');
  assert.equal(safeScriptName('..\\..\\evil\\a:b*c?.js'), 'a_b_c_.js');
  assert.equal(safeScriptName('CON.js'), '_CON.js');
  assert.equal(safeScriptName('my-plugin', { ensureExtension: true }), 'my-plugin.user.js');
  assert.equal(safeScriptName('...', { fallback: 'imported.user.js' }), 'imported.user.js');
});

test('parseUserscriptMeta extracts standard header fields', () => {
  const code = `// ==UserScript==
// @name         Helper Plugin
// @version      2.3.1
// @description  Auto helper
// @downloadURL  https://example.com/helper.user.js
// @updateURL    https://example.com/helper.meta.js
// ==/UserScript==
console.log(1);`;
  const meta = parseUserscriptMeta(code);
  assert.equal(meta.name, 'Helper Plugin');
  assert.equal(meta.version, '2.3.1');
  assert.equal(meta.description, 'Auto helper');
  assert.equal(meta.downloadURL, 'https://example.com/helper.user.js');
  assert.equal(meta.updateURL, 'https://example.com/helper.meta.js');
});

test('looksLikeHtmlDocument rejects HTML pages without flagging userscripts', () => {
  assert.equal(looksLikeHtmlDocument('<!doctype html><html><body>404</body></html>'), true);
  assert.equal(looksLikeHtmlDocument('  <html><head></head></html>'), true);
  assert.equal(looksLikeHtmlDocument('// ==UserScript==\n// @name x\n// ==/UserScript==\nconst h = "<html>";'), false);
  assert.equal(looksLikeHtmlDocument('(() => { console.log("ok"); })();'), false);
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
