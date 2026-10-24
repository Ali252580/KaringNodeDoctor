'use strict';

const { isHealthy } = require('./state');
const { OUTPUT_PREFIX } = require('./karing');
const { outboundToLink } = require('./share');
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

function buildV2raySubscription(store) {
  const settings = store.data.settings;
  const records = healthyRecords(store).slice(0, settings.maxWorkingNodes);
  const used = new Set();
  const links = [];
  const linkable = [];
  const skipped = {};

  for (const record of records) {
    if (outboundToLink(record.outbound, record.tag)) {
      linkable.push(record);
      continue;
    }
    const type = String(record.type || 'unknown');
    skipped[type] = (skipped[type] || 0) + 1;
  }

  for (const record of linkable) {
    links.push(outboundToLink(record.outbound, uniqueTag(record.tag, used)));
  }

  const skippedCount = Object.values(skipped).reduce((sum, value) => sum + value, 0);
  return {
    links,
    text: links.join('\n'),
    base64: Buffer.from(links.join('\n'), 'utf8').toString('base64'),
    count: links.length,
    skipped,
    skippedCount,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  healthyRecords,
  buildSubscription,
  buildV2raySubscription,
};
