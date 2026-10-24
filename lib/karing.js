'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { readJson, fingerprint, cleanText } = require('./util');

const NODE_TYPES = new Set([
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'anytls',
  'shadowtls',
  'socks',
  'http',
]);

const META_KEYS = new Set([
  'tag',
  'domain_resolver',
  'detour',
  'metadata',
  'remark',
  'remarks',
  'name',
  'groupid',
  'groupId',
  'id',
]);

const OUTPUT_PREFIX = 'CHK | ';

function defaultDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'karing', 'karing');
}

function sanitizeOutbound(outbound) {
  const clone = JSON.parse(JSON.stringify(outbound));
  for (const key of Object.keys(clone)) {
    if (META_KEYS.has(key) || key.startsWith('_')) delete clone[key];
  }
  return clone;
}

function isXhttp(outbound) {
  return Boolean(outbound.transport && outbound.transport.type === 'xhttp');
}

function profileIndex(subscribe) {
  const items = Array.isArray(subscribe) ? subscribe : (subscribe && subscribe.items) || [];
  const profiles = [];
  const tagMap = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const servers = Array.isArray(item.servers) ? item.servers : [];
    const profile = {
      id: String(item.groupid || ''),
      remark: cleanText(item.remark, 80) || 'بدون نام',
      type: cleanText(item.type, 20),
      enabled: item.enable !== false,
      total: servers.length,
    };
    profiles.push(profile);

    for (const server of servers) {
      if (!server || !server.tag) continue;
      if (!tagMap.has(server.tag)) tagMap.set(server.tag, profile);
    }
  }

  return { profiles, tagMap };
}

function loadKaring(options = {}) {
  const dataDir = options.dataDir || process.env.KND_KARING_DIR || defaultDataDir();
  const service = readJson(path.join(dataDir, 'service.json'), {}) || {};

  const coreCandidates = [
    service.core_path,
    path.join(dataDir, 'service_core.json'),
  ].filter(Boolean);
  const corePath = coreCandidates.find((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  }) || null;

  if (!corePath) {
    const error = new Error('فایل کانفیگ فعال Karing پیدا نشد. مطمئن شوید Karing یک‌بار اجرا شده است.');
    error.code = 'NO_CORE';
    throw error;
  }

  const core = readJson(corePath, null);
  if (!core || !Array.isArray(core.outbounds)) {
    const error = new Error('خواندن کانفیگ فعال Karing ممکن نشد.');
    error.code = 'BAD_CORE';
    throw error;
  }

  const subscribe = readJson(path.join(dataDir, 'karing_subscribe.json'), { items: [] });
  const { profiles, tagMap } = profileIndex(subscribe);

  const candidates = [];
  const byFingerprint = new Map();
  let xhttpCount = 0;
  let noProfileCount = 0;
  let invalidCount = 0;

  for (const outbound of core.outbounds) {
    if (!outbound || !NODE_TYPES.has(outbound.type)) continue;
    const tag = typeof outbound.tag === 'string' ? outbound.tag : '';
    if (!tag || tag.startsWith(OUTPUT_PREFIX)) continue;

    if (isXhttp(outbound)) {
      xhttpCount += 1;
      continue;
    }

    if (!outbound.server || !outbound.server_port) {
      invalidCount += 1;
      continue;
    }

    const profile = tagMap.get(tag);
    if (!profile) noProfileCount += 1;

    const clean = sanitizeOutbound(outbound);
    const fp = fingerprint(clean);
    const existing = byFingerprint.get(fp);
    if (existing) {
      existing.duplicates += 1;
      continue;
    }

    const record = {
      fp,
      tag: cleanText(tag, 160) || `${outbound.type}-${outbound.server}:${outbound.server_port}`,
      profileId: profile ? profile.id : '__other__',
      profileRemark: profile ? profile.remark : 'بدون پروفایل',
      type: outbound.type,
      transport: (outbound.transport && outbound.transport.type) || 'tcp',
      outbound: clean,
      duplicates: 0,
    };
    byFingerprint.set(fp, record);
    candidates.push(record);
  }

  const counts = new Map();
  for (const candidate of candidates) {
    counts.set(candidate.profileId, (counts.get(candidate.profileId) || 0) + 1);
  }
  for (const profile of profiles) {
    profile.unique = counts.get(profile.id) || 0;
  }

  const nodeOutbounds = core.outbounds.filter((outbound) => {
    if (!outbound) return false;
    if (!NODE_TYPES.has(outbound.type)) return false;
    return !(typeof outbound.tag === 'string' && outbound.tag.startsWith(OUTPUT_PREFIX));
  }).length;

  return {
    dataDir,
    corePath,
    controlPort: Number(service.control_port) || 3057,
    karingVersion: cleanText(service.version, 40),
    profiles: profiles.filter((profile) => profile.unique > 0),
    candidates,
    stats: {
      totalOutbounds: core.outbounds.length,
      nodeOutbounds,
      unique: candidates.length,
      duplicates: candidates.reduce((sum, item) => sum + item.duplicates, 0),
      xhttp: xhttpCount,
      invalid: invalidCount,
      noProfile: noProfileCount,
      profiles: profiles.filter((profile) => profile.unique > 0).length,
    },
  };
}

function parseKaringTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const time = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  ).getTime();
  return Number.isFinite(time) ? time : null;
}

function readSubscriptionSync(dataDir, subPath) {
  const subscribe = readJson(path.join(dataDir, 'karing_subscribe.json'), { items: [] });
  const items = Array.isArray(subscribe) ? subscribe : (subscribe && subscribe.items) || [];

  for (const item of items) {
    if (!item || typeof item.urlOrPath !== 'string' || !item.urlOrPath) continue;
    let pathname = '';
    try { pathname = new URL(item.urlOrPath).pathname; } catch { continue; }
    if (pathname !== subPath) continue;

    return {
      found: true,
      remark: cleanText(item.remark, 80),
      enabled: item.enable !== false,
      nodes: Array.isArray(item.servers) ? item.servers.length : 0,
      updateAt: parseKaringTime(item.updateTime),
      refreshMinutes: Number(item.updateDurationMinutes) > 0 ? Number(item.updateDurationMinutes) : null,
    };
  }

  return { found: false };
}

function tunFilePath(dataDir) {
  return path.join(dataDir || defaultDataDir(), 'karing_setting.json');
}

function readTunSetting(dataDir) {
  const file = tunFilePath(dataDir);
  const setting = readJson(file, null);
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
    const error = new Error('فایل تنظیمات Karing خوانده نشد. مطمئن شوید Karing یک‌بار اجرا شده است.');
    error.code = 'NO_SETTINGS';
    throw error;
  }
  const tun = setting.tun && typeof setting.tun === 'object' ? setting.tun : {};
  return {
    file,
    available: true,
    enable: tun.enable === true,
    stack: cleanText(tun.stack, 20) || 'mixed',
    autoRoute: tun.auto_route !== false,
    strictRoute: tun.strict_route === true,
    hijackDns: tun.hijack_dns === true,
    mtu: Number(tun.mtu) > 0 ? Number(tun.mtu) : null,
    proxyAll: setting.proxy_all === true,
  };
}

function writeTunSetting(dataDir, enable) {
  const current = readTunSetting(dataDir);
  const raw = fs.readFileSync(current.file, 'utf8');
  let setting;
  try {
    setting = JSON.parse(raw);
  } catch {
    const error = new Error('فایل تنظیمات Karing فرمت معتبر JSON ندارد.');
    error.code = 'BAD_SETTINGS';
    throw error;
  }
  if (!setting.tun || typeof setting.tun !== 'object') setting.tun = {};

  const wanted = Boolean(enable);
  setting.tun.enable = wanted;
  if (wanted && !setting.tun.stack) setting.tun.stack = 'mixed';

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.writeFileSync(`${current.file}.bak-${stamp}`, raw, 'utf8');
  } catch {}

  const tmp = `${current.file}.knd-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(setting, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, current.file);
  } catch (error) {
    try { fs.unlinkSync(current.file); } catch {}
    fs.renameSync(tmp, current.file);
    if (error && error.code === 'EPERM') throw error;
  }

  const after = readTunSetting(dataDir);
  if (after.enable !== wanted) {
    const error = new Error('تغییر ذخیره شد ولی وضعیت TUN تأیید نشد. Karing را ببندید و دوباره امتحان کنید.');
    error.code = 'VERIFY_FAILED';
    throw error;
  }
  return after;
}

function isKaringRunning(dataDir, timeoutMs = 450) {
  let port = 3057;
  try {
    const service = readJson(path.join(dataDir || defaultDataDir(), 'service.json'), null);
    if (service && Number(service.control_port) > 0) port = Number(service.control_port);
  } catch {}

  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

module.exports = {
  OUTPUT_PREFIX,
  NODE_TYPES,
  defaultDataDir,
  readTunSetting,
  writeTunSetting,
  isKaringRunning,
  sanitizeOutbound,
  loadKaring,
  readSubscriptionSync,
};
