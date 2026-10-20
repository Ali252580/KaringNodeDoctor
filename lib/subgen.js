'use strict';

const { isHealthy } = require('./state');
const { OUTPUT_PREFIX } = require('./karing');
const { WEB_PROFILE_ID } = require('./web');
const { cleanText } = require('./util');

function healthyRecords(store, now = Date.now()) {
  const settings = store.data.settings;
  return Object.values(store.data.nodes)
    .filter((record) => record
      && record.outbound
      && !record.unsupported
      && (record.profileId !== WEB_PROFILE_ID || settings.webEnabled)
      && settings.includeProfiles[record.profileId] !== false
      && isHealthy(record, settings, now))
    .sort((a, b) => {
      const aMs = Number.isFinite(a.lastMs) ? a.lastMs : Number.MAX_SAFE_INTEGER;
      const bMs = Number.isFinite(b.lastMs) ? b.lastMs : Number.MAX_SAFE_INTEGER;
      if (aMs !== bMs) return aMs - bMs;
      return String(a.tag || '').localeCompare(String(b.tag || ''), 'en');
    });
}

function uniqueTag(rawTag, used) {
  const clean = cleanText(rawTag, 110) || 'node';
  const base = `${OUTPUT_PREFIX}${clean}`;
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base} ·${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildSubscription(store) {
  const settings = store.data.settings;
  const records = healthyRecords(store).slice(0, settings.maxWorkingNodes);
  const used = new Set();
  const outbounds = records.map((record) => ({
    ...record.outbound,
    tag: uniqueTag(record.tag, used),
  }));

  return {
    outbounds,
    count: outbounds.length,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  healthyRecords,
  buildSubscription,
};
