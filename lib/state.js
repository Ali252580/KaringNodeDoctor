'use strict';

const path = require('path');
const { ensureDir, readJson, writeJson, clampInt, shannonToken } = require('./util');

const DEFAULT_SETTINGS = {
  testUrl: 'https://www.gstatic.com/generate_204',
  timeoutMs: 8000,
  concurrency: 12,
  maxTestsPerCycle: 600,
  maxWorkingNodes: 120,
  cycleMinutes: 40,
  failuresToDrop: 2,
  healthyTtlMinutes: 1440,
  autoRun: true,
  autoStart: true,
  webEnabled: true,
  webRefreshMinutes: 1440,
  webMaxPerSource: 300,
  webMaxPool: 2500,
  includeProfiles: {},
};

function normalizeSettings(raw, current = {}) {
  const base = { ...DEFAULT_SETTINGS, ...current };
  const next = { ...base };

  if (raw.testUrl !== undefined) {
    const value = String(raw.testUrl || '').trim();
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
      next.testUrl = value;
    } catch {
      next.testUrl = base.testUrl;
    }
  }

  if (raw.timeoutMs !== undefined) next.timeoutMs = clampInt(raw.timeoutMs, 3000, 30000, base.timeoutMs);
  if (raw.concurrency !== undefined) next.concurrency = clampInt(raw.concurrency, 1, 32, base.concurrency);
  if (raw.maxTestsPerCycle !== undefined) next.maxTestsPerCycle = clampInt(raw.maxTestsPerCycle, 10, 2000, base.maxTestsPerCycle);
  if (raw.maxWorkingNodes !== undefined) next.maxWorkingNodes = clampInt(raw.maxWorkingNodes, 10, 1000, base.maxWorkingNodes);
  if (raw.cycleMinutes !== undefined) next.cycleMinutes = clampInt(raw.cycleMinutes, 5, 1440, base.cycleMinutes);
  if (raw.failuresToDrop !== undefined) next.failuresToDrop = clampInt(raw.failuresToDrop, 1, 5, base.failuresToDrop);
  if (raw.healthyTtlMinutes !== undefined) next.healthyTtlMinutes = clampInt(raw.healthyTtlMinutes, 30, 10080, base.healthyTtlMinutes);
  if (raw.autoRun !== undefined) next.autoRun = Boolean(raw.autoRun);
  if (raw.autoStart !== undefined) next.autoStart = Boolean(raw.autoStart);
  if (raw.webEnabled !== undefined) next.webEnabled = Boolean(raw.webEnabled);
  if (raw.webRefreshMinutes !== undefined) next.webRefreshMinutes = clampInt(raw.webRefreshMinutes, 60, 10080, base.webRefreshMinutes);
  if (raw.webMaxPerSource !== undefined) next.webMaxPerSource = clampInt(raw.webMaxPerSource, 50, 1000, base.webMaxPerSource);
  if (raw.webMaxPool !== undefined) next.webMaxPool = clampInt(raw.webMaxPool, 100, 10000, base.webMaxPool);

  if (raw.includeProfiles && typeof raw.includeProfiles === 'object' && !Array.isArray(raw.includeProfiles)) {
    const map = {};
    for (const [key, value] of Object.entries(raw.includeProfiles)) {
      if (typeof key === 'string' && key.length <= 80 && typeof value === 'boolean') map[key] = value;
    }
    next.includeProfiles = map;
  }

  return next;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    ensureDir(dir);

    const raw = readJson(this.file, {}) || {};
    const rawWeb = raw.web && typeof raw.web === 'object' && !Array.isArray(raw.web) ? raw.web : {};
    this.data = {
      version: 2,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || null,
      subToken: typeof raw.subToken === 'string' && raw.subToken.length >= 16 ? raw.subToken : shannonToken(16),
      settings: normalizeSettings(raw.settings || {}, {}),
      nodes: raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes) ? raw.nodes : {},
      web: {
        lastFetchAt: rawWeb.lastFetchAt || null,
        lastError: rawWeb.lastError || null,
        sources: rawWeb.sources && typeof rawWeb.sources === 'object' && !Array.isArray(rawWeb.sources) ? rawWeb.sources : {},
        pool: rawWeb.pool && typeof rawWeb.pool === 'object' && !Array.isArray(rawWeb.pool) ? rawWeb.pool : {},
        dead: rawWeb.dead && typeof rawWeb.dead === 'object' && !Array.isArray(rawWeb.dead) ? rawWeb.dead : {},
      },
      history: Array.isArray(raw.history) ? raw.history.slice(-30) : [],
      lastRun: raw.lastRun || null,
    };
    this.save();
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    writeJson(this.file, this.data);
  }

  updateSettings(patch) {
    this.data.settings = normalizeSettings(patch, this.data.settings);
    this.save();
    return this.data.settings;
  }

  addHistory(entry) {
    this.data.history.push(entry);
    if (this.data.history.length > 30) this.data.history = this.data.history.slice(-30);
  }

  setLastRun(entry) {
    this.data.lastRun = entry;
  }
}

function isHealthy(record, settings, now = Date.now()) {
  if (!record || !record.outbound) return false;
  if (!record.lastOkAt) return false;
  if ((record.fails || 0) >= settings.failuresToDrop) return false;
  return now - record.lastOkAt <= settings.healthyTtlMinutes * 60_000;
}

module.exports = {
  Store,
  DEFAULT_SETTINGS,
  normalizeSettings,
  isHealthy,
};
