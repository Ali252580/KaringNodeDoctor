'use strict';

const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { defaultDataDir } = require('./karing');
const { readJson, sleep } = require('./util');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const FALLBACK_PORTS = [3067, 3065, 3066, 4067, 4066];

function run(file, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        return reject(error);
      }
      resolve(String(stdout || ''));
    });
  });
}

async function regRead(name) {
  try {
    const stdout = await run('reg', ['query', REG_KEY, '/v', name]);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = stdout.match(new RegExp(`^\\s*${escaped}\\s+(REG_\\w+)\\s*(.*?)\\s*$`, 'im'));
    if (!match) return null;
    return { type: match[1], raw: match[2] };
  } catch {
    return null;
  }
}

async function proxyEnabled() {
  const value = await regRead('ProxyEnable');
  if (!value) return null;
  const num = Number.parseInt(value.raw, value.raw.toLowerCase().startsWith('0x') ? 16 : 10);
  return Number.isFinite(num) ? num : null;
}

async function proxyServer() {
  const value = await regRead('ProxyServer');
  return value ? value.raw : null;
}

function karingProxyPorts() {
  const dataDir = process.env.KND_KARING_DIR || defaultDataDir();
  const settings = readJson(path.join(dataDir, 'karing_setting.json'), {}) || {};
  const proxy = settings.proxy && typeof settings.proxy === 'object' ? settings.proxy : {};
  const ports = new Set();
  for (const [key, raw] of Object.entries(proxy)) {
    if (!/port/i.test(key) || key === 'control_port') continue;
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  if (!ports.size) for (const port of FALLBACK_PORTS) ports.add(port);
  return ports;
}

function parseEndpoint(entry) {
  const eq = entry.indexOf('=');
  const target = (eq >= 0 ? entry.slice(eq + 1) : entry).trim();
  const match = target.match(/^\[([^\]]+)\]:(\d+)$/) || target.match(/^([^:]+):(\d+)$/);
  if (!match) return null;
  return { host: match[1].toLowerCase(), port: Number(match[2]) };
}

function isKaringProxyValue(value, ports) {
  const entries = String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!entries.length) return false;
  return entries.every((entry) => {
    const endpoint = parseEndpoint(entry);
    return Boolean(endpoint) && LOCAL_HOSTS.has(endpoint.host) && ports.has(endpoint.port);
  });
}

function refreshWinInet() {
  const script = [
    "$sig='[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'",
    'Add-Type -Namespace Knd -Name WinInet -MemberDefinition $sig | Out-Null',
    '[Knd.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '[Knd.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
  ].join('; ');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], 15000)
    .catch(() => '');
}

function isLocalProxyValue(value) {
  const entries = String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!entries.length) return false;
  return entries.every((entry) => {
    const endpoint = parseEndpoint(entry);
    return Boolean(endpoint) && LOCAL_HOSTS.has(endpoint.host);
  });
}

function isListening(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const target = host === 'localhost' ? '127.0.0.1' : host;
    const socket = net.connect({ host: target, port });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function localProxyEndpoints(value) {
  const ports = String(value || '')
    .split(';')
    .map((part) => parseEndpoint(part.trim()))
    .filter((endpoint) => endpoint && LOCAL_HOSTS.has(endpoint.host));
  const alive = [];
  for (const endpoint of ports) {
    if (await isListening(endpoint.host, endpoint.port)) alive.push(endpoint);
  }
  return { total: ports.length, alive };
}

async function disableSystemProxy() {
  try {
    await run('reg', ['add', REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
  } catch (error) {
    return { supported: true, cleared: false, reason: 'disable-failed', error: error.message };
  }
  try {
    await run('reg', ['delete', REG_KEY, '/v', 'ProxyServer', '/f']);
  } catch {}
  await refreshWinInet();
  return { supported: true, cleared: true };
}

async function cleanupStaleProxy(options = {}) {
  if (process.platform !== 'win32') return { supported: false, cleared: false };

  const enabled = await proxyEnabled();
  const server = await proxyServer();

  // A VPN client left the system proxy switched on for a port nothing listens
  // on (closed, crashed, or a core that failed to start); every browser then
  // loses internet, and the client cannot even fetch its own subscription.
  if (enabled === 1) {
    if (!isLocalProxyValue(server)) return { supported: true, cleared: false, reason: 'not-local' };
    const first = await localProxyEndpoints(server);
    if (first.alive.length) return { supported: true, cleared: false, reason: 'proxy-alive' };

    await sleep(options.confirmMs ?? 2500);
    if ((await proxyEnabled()) !== 1) return { supported: true, cleared: false, reason: 're-enabled' };
    if ((await proxyServer()) !== server) return { supported: true, cleared: false, reason: 'changed' };
    const again = await localProxyEndpoints(server);
    if (again.alive.length) return { supported: true, cleared: false, reason: 'proxy-alive' };

    const result = await disableSystemProxy();
    return { ...result, previous: server, deadEndpoint: true };
  }

  if (enabled !== 0) return { supported: true, cleared: false, reason: 'unknown-state' };
  if (!server) return { supported: true, cleared: false, reason: 'empty' };
  if (!isKaringProxyValue(server, karingProxyPorts())) {
    return { supported: true, cleared: false, reason: 'not-karing' };
  }

  await sleep(options.confirmMs ?? 2500);

  const recheck = await proxyEnabled();
  if (recheck !== 0) return { supported: true, cleared: false, reason: 're-enabled' };
  if ((await proxyServer()) !== server) return { supported: true, cleared: false, reason: 'changed' };

  try {
    await run('reg', ['delete', REG_KEY, '/v', 'ProxyServer', '/f']);
  } catch (error) {
    return { supported: true, cleared: false, reason: 'delete-failed', error: error.message };
  }

  await refreshWinInet();
  return { supported: true, cleared: true, previous: server };
}

async function activeLocalProxy() {
  if (process.platform !== 'win32') return null;
  if ((await proxyEnabled()) !== 1) return null;
  const server = await proxyServer();
  if (!isLocalProxyValue(server)) return null;
  const endpoints = String(server)
    .split(';')
    .map((part) => parseEndpoint(part.trim()))
    .filter((endpoint) => endpoint && LOCAL_HOSTS.has(endpoint.host));
  for (const endpoint of endpoints) {
    if (await isListening(endpoint.host, endpoint.port)) return endpoint;
  }
  return null;
}

module.exports = {
  REG_KEY,
  isKaringProxyValue,
  isLocalProxyValue,
  karingProxyPorts,
  cleanupStaleProxy,
  activeLocalProxy,
};
