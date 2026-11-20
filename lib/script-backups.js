'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BACKUPS_PER_SCRIPT = 5;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

async function backupEntries(dir) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const files = entries.filter((entry) => entry.isFile());
  return Promise.all(files.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    const stat = await fs.promises.stat(fullPath);
    return { name: entry.name, fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
  }));
}

async function removeQuietly(filePath) {
  try { await fs.promises.unlink(filePath); }
  catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
}

async function pruneScriptBackups(dir, scriptName) {
  const all = await backupEntries(dir);
  const matching = all
    .filter((entry) => entry.name.startsWith(scriptName + '.'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = new Set();
  for (const entry of matching.slice(MAX_BACKUPS_PER_SCRIPT)) {
    await removeQuietly(entry.fullPath);
    removed.add(entry.fullPath);
  }

  const remaining = all
    .filter((entry) => !removed.has(entry.fullPath))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = remaining.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of remaining) {
    if (total <= MAX_BACKUP_BYTES) break;
    await removeQuietly(entry.fullPath);
    total -= entry.size;
  }
}

module.exports = {
  MAX_BACKUPS_PER_SCRIPT,
  MAX_BACKUP_BYTES,
  pruneScriptBackups,
};
