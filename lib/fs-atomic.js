'use strict';

const fs = require('fs');
const path = require('path');

function writeFileAtomicSync(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const temp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`);
  fs.writeFileSync(temp, content, { encoding, flag: 'wx' });
  try {
    fs.renameSync(temp, filePath);
  } catch (err) {
    try {
      fs.copyFileSync(temp, filePath);
      fs.unlinkSync(temp);
    } catch (fallbackErr) {
      try { fs.unlinkSync(temp); } catch (_) {}
      throw fallbackErr || err;
    }
  }
}

async function writeFileAtomic(filePath, content, encoding = 'utf8') {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const base = path.basename(filePath);
  const temp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`);
  await fs.promises.writeFile(temp, content, { encoding, flag: 'wx' });
  try {
    await fs.promises.rename(temp, filePath);
  } catch (err) {
    try {
      await fs.promises.copyFile(temp, filePath);
      await fs.promises.unlink(temp);
    } catch (fallbackErr) {
      try { await fs.promises.unlink(temp); } catch (_) {}
      throw fallbackErr || err;
    }
  }
}

function writeJsonAtomicSync(filePath, data) {
  writeFileAtomicSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJsonSafeSync(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  writeFileAtomicSync,
  writeFileAtomic,
  writeJsonAtomicSync,
  readJsonSafeSync,
};
