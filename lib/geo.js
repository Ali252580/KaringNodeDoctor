'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const dns = require('dns');
const { sleep } = require('./util');

const LIST_FILE = path.join(__dirname, 'geo', 'ru-v4.txt');
const BATCH_URL = 'http://ip-api.com/batch?fields=query,countryCode';
const RESOLVE_TTL_MS = 12 * 60 * 60 * 1000;
const RESOLVE_FAILURE_TTL_MS = 10 * 60 * 1000;
const COUNTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOOKUP_CONCURRENCY = 24;

let ranges = null;
const hostCache = new Map();
const countryCache = new Map();

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num > 255) return null;
    value = value * 256 + num;
  }
  return value;
}

function loadRanges() {
  if (ranges) return ranges;
  const out = [];
  try {
    const text = fs.readFileSync(LIST_FILE, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      const [base, prefixRaw] = value.split('/');
      const ip = ipToInt(base);
      const prefix = Number(prefixRaw);
      if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
      const size = 2 ** (32 - prefix);
      const mask = prefix === 0 ? 0 : 0xffffffff - (size - 1);
      const start = ip & mask;
      out.push([start, start + size - 1]);
    }
  } catch {}
  out.sort((a, b) => a[0] - b[0]);
  ranges = out;
  return ranges;
}

function isRussianIp(ip) {
  const value = ipToInt(ip);
  if (value === null) return false;
  const list = loadRanges();
  let low = 0;
  let high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = list[mid];
    if (value < start) high = mid - 1;
    else if (value > end) low = mid + 1;
    else return true;
  }
  return false;
}

function normalizeHost(rawHost) {
  return String(rawHost || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

async function resolveHost(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  if (net.isIP(host)) return host;

  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.ip;

  try {
    const result = await dns.promises.lookup(host, { family: 4 });
    hostCache.set(host, { at: Date.now(), ttl: RESOLVE_TTL_MS, ip: result.address });
    return result.address;
  } catch {
    hostCache.set(host, { at: Date.now(), ttl: RESOLVE_FAILURE_TTL_MS, ip: null });
    return null;
  }
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const request = http.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
        if (data.length > 2_000_000) request.destroy(new Error('response too large'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function lookupCountries(ips) {
  for (let offset = 0; offset < ips.length; offset += 100) {
    const chunk = ips.slice(offset, offset + 100);
    let rows;
    try {
      rows = await postJson(BATCH_URL, chunk.map((ip) => ({ query: ip })));
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;

    for (const row of rows) {
      if (!row || typeof row.query !== 'string') continue;
      const code = typeof row.countryCode === 'string' && row.countryCode ? row.countryCode : null;
      countryCache.set(row.query, { code, at: Date.now() });
    }
    for (const ip of chunk) {
      if (!countryCache.has(ip) || Date.now() - countryCache.get(ip).at > COUNTRY_TTL_MS) {
        countryCache.set(ip, { code: null, at: Date.now() });
      }
    }
    if (offset + 100 < ips.length) await sleep(350);
  }
}

async function classifyHosts(rawHosts) {
  const hosts = [...new Set(rawHosts.map(normalizeHost))];
  const result = new Map();
  const pending = [];

  const addresses = await mapLimit(hosts, LOOKUP_CONCURRENCY, resolveHost);
  hosts.forEach((host, index) => {
    const ip = addresses[index];
    if (!ip) {
      result.set(host, { ip: null, ru: false });
      return;
    }
    if (net.isIP(ip) !== 4) {
      result.set(host, { ip, ru: false });
      return;
    }
    if (isRussianIp(ip)) {
      result.set(host, { ip, ru: true });
      return;
    }
    const cached = countryCache.get(ip);
    if (cached && Date.now() - cached.at < COUNTRY_TTL_MS) {
      result.set(host, { ip, ru: cached.code === 'RU' });
      return;
    }
    pending.push({ host, ip });
  });

  if (pending.length) {
    const ips = [...new Set(pending.map((item) => item.ip))];
    await lookupCountries(ips);
    for (const { host, ip } of pending) {
      const cached = countryCache.get(ip);
      result.set(host, { ip, ru: Boolean(cached && cached.code === 'RU') });
    }
  }

  return result;
}

async function checkHost(rawHost) {
  const host = normalizeHost(rawHost);
  const classified = await classifyHosts([host]);
  return classified.get(host) || { ip: null, ru: false };
}

async function filterRussian(candidates) {
  const hosts = candidates.map((candidate) => (
    candidate && candidate.outbound ? candidate.outbound.server : ''
  ));
  const classified = await classifyHosts(hosts);

  const kept = [];
  const removed = [];
  candidates.forEach((candidate, index) => {
    const info = classified.get(normalizeHost(hosts[index])) || { ip: null, ru: false };
    if (info.ru) {
      removed.push(candidate);
    } else {
      if (info.ip && candidate && candidate.outbound) candidate.serverIp = info.ip;
      kept.push(candidate);
    }
  });
  return { kept, removed };
}

async function purgeRussianRecords(store) {
  const records = store.data.nodes;
  const entries = Object.entries(records).filter(([, record]) => (
    record && record.outbound && record.outbound.server
  ));
  if (!entries.length) return 0;

  const classified = await classifyHosts(entries.map(([, record]) => record.outbound.server));

  let removed = 0;
  for (const [fp, record] of entries) {
    const info = classified.get(normalizeHost(record.outbound.server));
    if (info && info.ru) {
      delete records[fp];
      removed += 1;
    }
  }
  if (removed) store.save();
  return removed;
}

module.exports = {
  isRussianIp,
  checkHost,
  classifyHosts,
  filterRussian,
  purgeRussianRecords,
};
