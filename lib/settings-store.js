'use strict';

const { readJsonSafeSync, writeJsonAtomicSync } = require('./fs-atomic');

const DEFAULT_SETTINGS = Object.freeze({
  keepActive: true,
  shinyEgg: true,
  minimizeToTray: false,
  alwaysOnTop: false,
  muted: false,
});

function sanitizeSettings(raw, base = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...(base || {}), ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    keepActive: merged.keepActive !== false,
    shinyEgg: merged.shinyEgg !== false,
    minimizeToTray: merged.minimizeToTray === true,
    alwaysOnTop: merged.alwaysOnTop === true,
    muted: merged.muted === true,
  };
}

function loadSettings(filePath) {
  const saved = readJsonSafeSync(filePath, null);
  if (!saved) return { ...DEFAULT_SETTINGS };
  return sanitizeSettings(saved);
}

function saveSettings(filePath, settings) {
  try {
    const next = sanitizeSettings(settings);
    writeJsonAtomicSync(filePath, next);
    return { ok: true, settings: next };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : '保存设置失败' };
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  loadSettings,
  saveSettings,
};
