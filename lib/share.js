'use strict';

const net = require('net');
const { fingerprint, cleanText } = require('./util');
const { sanitizeOutbound, OUTPUT_PREFIX, NODE_TYPES } = require('./karing');

const PRIVATE_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

const SS_METHODS = new Set([
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'none',
  'plain',
]);

function decodeBase64(value) {
  let text = String(value || '').trim().replace(/\s+/g, '');
  if (!text) return '';
  text = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = text.length % 4;
  if (pad === 1) return '';
  if (pad) text += '='.repeat(4 - pad);
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function looksBase64(text) {
  const value = String(text || '').replace(/\s+/g, '');
  return value.length > 40 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function truthy(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function normalizeHost(raw) {
  return String(raw || '').trim().replace(/^\[|\]$/g, '');
}

function privateIPv4(host) {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function privateIPv6(host) {
  const value = host.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('::ffff:')) return privateIPv4(value.slice(7));
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true;
  if (value.startsWith('ff')) return true;
  return false;
}

function isPrivateHost(host) {
  const value = normalizeHost(host).toLowerCase();
  if (!value) return true;
  if (PRIVATE_NAMES.has(value) || value.endsWith('.local') || value.endsWith('.localhost')) return true;
  if (net.isIPv4(value)) return privateIPv4(value);
  if (net.isIPv6(value)) return privateIPv6(value);
  if (!value.includes('.') && !value.includes(':')) return true;
  return false;
}

function parsePort(raw) {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function parseHostPort(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return null;
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    return { host: normalizeHost(host), port: parsePort(rest.slice(1)) };
  }
  const index = text.lastIndexOf(':');
  if (index === -1) return null;
  return { host: normalizeHost(text.slice(0, index)), port: parsePort(text.slice(index + 1)) };
}

function alpnList(value) {
  if (!value) return null;
  const list = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return list.length ? list : null;
}

function buildTls(params, host, fallbackEnabled = false) {
  const security = String(params.get('security') || '').toLowerCase();
  const enabled = fallbackEnabled || security === 'tls' || security === 'reality' || security === 'xtls';
  if (!enabled) return null;

  const tls = { enabled: true };
  const serverName = params.get('sni') || params.get('peer') || params.get('serverName') || params.get('servername');
  if (serverName) tls.server_name = serverName;
  if (truthy(params.get('insecure')) || truthy(params.get('allowInsecure')) || truthy(params.get('allow_insecure')) || truthy(params.get('skip-cert-verify'))) {
    tls.insecure = true;
  }
  const alpn = alpnList(params.get('alpn'));
  if (alpn) tls.alpn = alpn;

  const fingerprintValue = params.get('fp') || params.get('fingerprint');
  if (fingerprintValue) tls.utls = { enabled: true, fingerprint: fingerprintValue };

  if (security === 'reality') {
    const publicKey = params.get('pbk') || params.get('public_key') || params.get('publicKey');
    if (!publicKey) return { invalid: 'reality public key missing' };
    tls.reality = { enabled: true, public_key: publicKey };
    const shortId = params.get('sid') || params.get('short_id') || params.get('shortId');
    if (shortId) tls.reality.short_id = shortId;
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
  }

  return tls;
}

function buildTransport(params, defaultValue = 'tcp') {
  const type = String(params.get('type') || defaultValue || 'tcp').toLowerCase();
  if (type === 'tcp' || type === 'none' || type === 'raw') return null;
  if (type === 'xhttp' || type === 'splithttp' || type === 'kcp' || type === 'mkcp' || type === 'quic') {
    return { unsupported: `transport ${type}` };
  }

  const hostHeader = params.get('host') || '';
  const path = params.get('path') || '/';

  if (type === 'ws' || type === 'websocket') {
    const transport = { type: 'ws', path };
    if (hostHeader) transport.headers = { Host: hostHeader };
    return transport;
  }
  if (type === 'grpc' || type === 'gun') {
    return {
      type: 'grpc',
      service_name: params.get('serviceName') || params.get('service_name') || params.get('path') || '',
    };
  }
  if (type === 'http' || type === 'h2' || type === 'h2c') {
    const transport = { type: 'http', path };
    if (hostHeader) transport.host = hostHeader.split(',').map((item) => item.trim()).filter(Boolean);
    return transport;
  }
  if (type === 'httpupgrade') {
    const transport = { type: 'httpupgrade', path };
    if (hostHeader) transport.host = hostHeader;
    return transport;
  }
  return { unsupported: `transport ${type}` };
}

function uriParams(url) {
  return url.searchParams;
}

function tagOf(url, fallback) {
  let tag = '';
  try { tag = decodeURIComponent(String(url.hash || '').replace(/^#/, '')); } catch { tag = ''; }
  tag = cleanText(tag, 120);
  if (tag.startsWith(OUTPUT_PREFIX)) return null;
  return tag || fallback;
}

function finish(candidate, stats) {
  if (!candidate) return null;
  const outbound = candidate.outbound;
  if (!outbound || !NODE_TYPES.has(outbound.type)) {
    stats.invalid += 1;
    return null;
  }
  if (!outbound.server || !outbound.server_port) {
    stats.invalid += 1;
    return null;
  }
  if (String(outbound.server).length > 253 || /[\s/\\?#@]/.test(String(outbound.server))) {
    stats.invalid += 1;
    return null;
  }
  if (!stats.allowPrivateHosts && isPrivateHost(outbound.server)) {
    stats.privateHost += 1;
    return null;
  }
  const clean = sanitizeOutbound(outbound);
  const fp = fingerprint(clean);
  return {
    fp,
    tag: candidate.tag || `${outbound.type} ${outbound.server}:${outbound.server_port}`,
    type: outbound.type,
    transport: (clean.transport && clean.transport.type) || 'tcp',
    outbound: clean,
  };
}

function parseVless(url, stats) {
  const params = uriParams(url);
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  const uuid = decodeURIComponent(url.username || '');
  if (!uuid || !server || !serverPort) return null;

  const transport = buildTransport(params, 'tcp');
  if (transport && transport.unsupported) {
    stats.unsupported += 1;
    return null;
  }

  const tls = buildTls(params, server, false);
  if (tls && tls.invalid) {
    stats.invalid += 1;
    return null;
  }

  const outbound = { type: 'vless', server, server_port: serverPort, uuid };
  const flow = params.get('flow');
  if (flow) outbound.flow = flow;
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  const packetEncoding = params.get('packetEncoding') || params.get('packet_encoding');
  if (packetEncoding) outbound.packet_encoding = packetEncoding;

  const tag = tagOf(url, `${params.get('remarks') || 'vless'} ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseVmess(rawUrl, stats) {
  const body = rawUrl.slice('vmess://'.length);
  const hashIndex = body.indexOf('#');
  const payload = hashIndex >= 0 ? body.slice(0, hashIndex) : body;
  let tagFragment = '';
  if (hashIndex >= 0) {
    try { tagFragment = decodeURIComponent(body.slice(hashIndex + 1)); } catch { tagFragment = ''; }
  }

  let data = null;
  try { data = JSON.parse(decodeURIComponent(payload)); } catch {}
  if (!data) {
    const decoded = decodeBase64(payload);
    if (decoded) {
      try { data = JSON.parse(decoded); } catch { data = null; }
    }
  }
  if (!data) return null;

  const server = normalizeHost(data.add || data.address || data.server);
  const serverPort = parsePort(data.port || data.port_server);
  const uuid = String(data.id || data.uuid || '').trim();
  if (!server || !serverPort || !uuid) return null;

  let transport = null;
  const networkType = String(data.net || 'tcp').toLowerCase();
  const transportParams = new URLSearchParams();
  transportParams.set('type', networkType);
  if (data.host) transportParams.set('host', String(data.host));
  if (data.path) transportParams.set('path', String(data.path));
  if (data.serviceName) transportParams.set('serviceName', String(data.serviceName));
  transport = buildTransport(transportParams, 'tcp');
  if (transport && transport.unsupported) {
    stats.unsupported += 1;
    return null;
  }

  let tls = null;
  const tlsMode = String(data.tls || data.security || '').toLowerCase();
  if (tlsMode === 'tls' || tlsMode === 'reality' || tlsMode === 'xtls') {
    const tlsParams = new URLSearchParams();
    tlsParams.set('security', tlsMode === 'reality' ? 'reality' : 'tls');
    if (data.sni) tlsParams.set('sni', String(data.sni));
    else if (data.host) tlsParams.set('sni', String(data.host));
    if (truthy(data.allowInsecure) || truthy(data.skipCertVerify) || truthy(data.verify_cert === false)) tlsParams.set('insecure', '1');
    if (data.alpn) tlsParams.set('alpn', String(data.alpn));
    if (data.fp) tlsParams.set('fp', String(data.fp));
    if (data.pbk) tlsParams.set('pbk', String(data.pbk));
    if (data.sid) tlsParams.set('sid', String(data.sid));
    tls = buildTls(tlsParams, server, false);
    if (tls && tls.invalid) {
      stats.invalid += 1;
      return null;
    }
  }

  const outbound = {
    type: 'vmess',
    server,
    server_port: serverPort,
    uuid,
    security: String(data.scy || data.security_cipher || 'auto'),
    alter_id: Number(data.aid || data.alterId) || 0,
  };
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;

  let tag = tagFragment;
  try { tag = cleanText(decodeURIComponent(tag) || data.ps || '', 120); } catch { tag = cleanText(data.ps || '', 120); }
  if (tag.startsWith(OUTPUT_PREFIX)) { stats.unsupported += 1; return null; }
  return { outbound, tag: tag || `vmess ${server}:${serverPort}` };
}

function parseTrojan(url, stats) {
  const params = uriParams(url);
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  const password = decodeURIComponent(url.username || '');
  if (!server || !serverPort || !password) return null;

  const transport = buildTransport(params, 'tcp');
  if (transport && transport.unsupported) {
    stats.unsupported += 1;
    return null;
  }
  const tls = buildTls(params, server, true);
  if (tls && tls.invalid) {
    stats.invalid += 1;
    return null;
  }

  const outbound = { type: 'trojan', server, server_port: serverPort, password };
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  const tag = tagOf(url, `trojan ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseShadowsocks(rawUrl, stats) {
  let body = rawUrl.slice('ss://'.length);
  let tag = '';
  const hashIndex = body.indexOf('#');
  if (hashIndex >= 0) {
    try { tag = decodeURIComponent(body.slice(hashIndex + 1)); } catch { tag = ''; }
    body = body.slice(0, hashIndex);
  }
  let query = '';
  const queryIndex = body.indexOf('?');
  if (queryIndex >= 0) {
    query = body.slice(queryIndex + 1);
    body = body.slice(0, queryIndex);
  }

  if (!body.includes('@')) {
    const decoded = decodeBase64(body);
    if (!decoded || !decoded.includes('@')) return null;
    body = decoded;
    const innerQuery = body.indexOf('?');
    if (innerQuery >= 0) {
      query = body.slice(innerQuery + 1);
      body = body.slice(0, innerQuery);
    }
  }

  const atIndex = body.lastIndexOf('@');
  if (atIndex <= 0) return null;
  const userinfo = body.slice(0, atIndex);
  const hostPort = parseHostPort(body.slice(atIndex + 1));
  if (!hostPort || !hostPort.host || !hostPort.port) return null;

  let method = '';
  let password = '';
  if (userinfo.includes(':')) {
    const split = userinfo.indexOf(':');
    method = decodeURIComponent(userinfo.slice(0, split));
    password = decodeURIComponent(userinfo.slice(split + 1));
  } else {
    const decoded = decodeBase64(userinfo);
    if (!decoded || !decoded.includes(':')) return null;
    const split = decoded.indexOf(':');
    method = decoded.slice(0, split);
    password = decoded.slice(split + 1);
  }
  method = method.trim().toLowerCase();
  if (!method || password === '' || !SS_METHODS.has(method)) {
    stats.invalid += 1;
    return null;
  }

  const outbound = {
    type: 'shadowsocks',
    server: hostPort.host,
    server_port: hostPort.port,
    method,
    password,
  };
  if (method === 'plain') outbound.method = 'none';

  const params = new URLSearchParams(query);
  const plugin = params.get('plugin');
  if (plugin) {
    const parts = plugin.split(';').filter(Boolean);
    const name = String(parts.shift() || '').trim();
    const opts = parts.join(';');
    if (name === 'obfs-local' || name === 'simple-obfs' || name === 'v2ray-plugin') {
      outbound.plugin = name === 'simple-obfs' ? 'obfs-local' : name;
      if (opts) outbound.plugin_opts = opts;
    } else {
      stats.unsupported += 1;
      return null;
    }
  }

  if (tag.startsWith(OUTPUT_PREFIX)) { stats.unsupported += 1; return null; }
  return { outbound, tag: cleanText(tag, 120) || `ss ${hostPort.host}:${hostPort.port}` };
}

function parseHysteria2(url, stats) {
  const params = uriParams(url);
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  if (!server || !serverPort) return null;

  let password = '';
  try { password = decodeURIComponent(url.username || ''); } catch { password = url.username || ''; }
  if (url.password) {
    try { password = `${password}:${decodeURIComponent(url.password)}`; } catch { password = `${password}:${url.password}`; }
  }
  if (!password) password = params.get('auth') || params.get('password') || '';
  if (!password) return null;

  const tls = buildTls(params, server, true);
  if (tls && tls.invalid) {
    stats.invalid += 1;
    return null;
  }

  const outbound = { type: 'hysteria2', server, server_port: serverPort, password };
  if (tls) outbound.tls = tls;
  const obfsType = params.get('obfs');
  const obfsPassword = params.get('obfs-password') || params.get('obfs_password');
  if (obfsType && obfsPassword) outbound.obfs = { type: obfsType, password: obfsPassword };
  if (truthy(params.get('fast-open')) || truthy(params.get('fast_open'))) outbound.tcp_fast_open = true;

  const tag = tagOf(url, `hysteria2 ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseHysteria(url, stats) {
  const params = uriParams(url);
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  if (!server || !serverPort) return null;

  const outbound = {
    type: 'hysteria',
    server,
    server_port: serverPort,
    up_mbps: Number(params.get('upmbps') || params.get('up')) || 50,
    down_mbps: Number(params.get('downmbps') || params.get('down')) || 100,
  };
  const auth = params.get('auth') || params.get('auth_str') || params.get('authStr');
  if (auth) outbound.auth_str = auth;
  const obfs = params.get('obfs');
  if (obfs) outbound.obfs = obfs;

  const tlsParams = new URLSearchParams();
  tlsParams.set('security', 'tls');
  const peer = params.get('peer') || params.get('sni');
  if (peer) tlsParams.set('sni', peer);
  if (truthy(params.get('insecure')) || truthy(params.get('allowInsecure'))) tlsParams.set('insecure', '1');
  const alpn = params.get('alpn');
  if (alpn) tlsParams.set('alpn', alpn);
  const tls = buildTls(tlsParams, server, true);
  if (tls) outbound.tls = tls;

  const tag = tagOf(url, `hysteria ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseTuic(url, stats) {
  const params = uriParams(url);
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  const uuid = decodeURIComponent(url.username || '');
  let password = '';
  try { password = decodeURIComponent(url.password || ''); } catch { password = url.password || ''; }
  if (!password) password = params.get('password') || '';
  if (!server || !serverPort || !uuid) return null;

  const tlsParams = new URLSearchParams();
  tlsParams.set('security', 'tls');
  const sni = params.get('sni') || params.get('peer');
  if (sni) tlsParams.set('sni', sni);
  if (truthy(params.get('allow_insecure')) || truthy(params.get('insecure'))) tlsParams.set('insecure', '1');
  const alpn = params.get('alpn') || 'h3';
  tlsParams.set('alpn', alpn);
  const tls = buildTls(tlsParams, server, true);

  const outbound = { type: 'tuic', server, server_port: serverPort, uuid, password };
  if (tls) outbound.tls = tls;
  const congestion = params.get('congestion_control') || params.get('congestion');
  if (congestion) outbound.congestion_control = congestion;
  const relay = params.get('udp_relay_mode');
  if (relay) outbound.udp_relay_mode = relay;
  if (truthy(params.get('udp_over_stream'))) outbound.udp_over_stream = true;
  if (truthy(params.get('zero_rtt_handshake'))) outbound.zero_rtt_handshake = true;

  const tag = tagOf(url, `tuic ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseAnyTls(url, stats) {
  const params = uriParams(url);
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  let password = '';
  try { password = decodeURIComponent(url.username || ''); } catch { password = url.username || ''; }
  if (!password) password = params.get('password') || '';
  if (!server || !serverPort || !password) return null;

  const tls = buildTls(params, server, true);
  if (tls && tls.invalid) {
    stats.invalid += 1;
    return null;
  }
  const outbound = { type: 'anytls', server, server_port: serverPort, password };
  if (tls) outbound.tls = tls;

  const tag = tagOf(url, `anytls ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseSocks(rawUrl, stats) {
  let body = rawUrl.replace(/^socks5?:\/\//i, '');
  let tag = '';
  const hashIndex = body.indexOf('#');
  if (hashIndex >= 0) {
    try { tag = decodeURIComponent(body.slice(hashIndex + 1)); } catch { tag = ''; }
    body = body.slice(0, hashIndex);
  }
  const queryIndex = body.indexOf('?');
  if (queryIndex >= 0) body = body.slice(0, queryIndex);

  let userinfo = '';
  let hostPortText = body;
  const atIndex = body.lastIndexOf('@');
  if (atIndex >= 0) {
    userinfo = body.slice(0, atIndex);
    hostPortText = body.slice(atIndex + 1);
  }
  const hostPort = parseHostPort(hostPortText);
  if (!hostPort || !hostPort.host || !hostPort.port) return null;

  let username = '';
  let password = '';
  if (userinfo) {
    if (userinfo.includes(':')) {
      const split = userinfo.indexOf(':');
      username = decodeURIComponent(userinfo.slice(0, split));
      password = decodeURIComponent(userinfo.slice(split + 1));
    } else {
      const decoded = decodeBase64(userinfo);
      if (decoded && decoded.includes(':')) {
        const split = decoded.indexOf(':');
        username = decoded.slice(0, split);
        password = decoded.slice(split + 1);
      } else {
        username = decodeURIComponent(userinfo);
      }
    }
  }

  const outbound = { type: 'socks', server: hostPort.host, server_port: hostPort.port };
  if (username) outbound.username = username;
  if (password) outbound.password = password;
  return { outbound, tag: cleanText(tag, 120) || `socks ${hostPort.host}:${hostPort.port}` };
}

function parseHttp(rawUrl, stats) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'http:') return null;
  if (url.pathname && url.pathname !== '/') return null;
  const server = normalizeHost(url.hostname);
  const serverPort = parsePort(url.port);
  if (!server || !serverPort) return null;
  const outbound = { type: 'http', server, server_port: serverPort };
  if (url.username) outbound.username = decodeURIComponent(url.username);
  if (url.password) outbound.password = decodeURIComponent(url.password);
  const tag = tagOf(url, `http ${server}:${serverPort}`);
  if (tag === null) { stats.unsupported += 1; return null; }
  return { outbound, tag };
}

function parseUri(rawUri, stats) {
  const uri = String(rawUri || '').trim();
  if (!uri || uri.startsWith('#')) return null;

  let scheme = '';
  const match = uri.match(/^([a-z0-9+.-]+):\/\//i);
  if (!match) return null;
  scheme = match[1].toLowerCase();

  try {
    if (scheme === 'vmess') return finish(parseVmess(uri, stats), stats);
    if (scheme === 'ss') return finish(parseShadowsocks(uri, stats), stats);

    const url = new URL(uri);
    if (scheme === 'vless') return finish(parseVless(url, stats), stats);
    if (scheme === 'trojan') return finish(parseTrojan(url, stats), stats);
    if (scheme === 'hysteria2' || scheme === 'hy2') return finish(parseHysteria2(url, stats), stats);
    if (scheme === 'hysteria') return finish(parseHysteria(url, stats), stats);
    if (scheme === 'tuic') return finish(parseTuic(url, stats), stats);
    if (scheme === 'anytls') return finish(parseAnyTls(url, stats), stats);
    if (scheme === 'socks' || scheme === 'socks5') return finish(parseSocks(uri, stats), stats);
    if (scheme === 'http') return finish(parseHttp(uri, stats), stats);
  } catch {
    stats.invalid += 1;
    return null;
  }

  stats.unsupported += 1;
  return null;
}

function parseJsonList(text, stats) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.outbounds) ? data.outbounds : null);
  if (!list) return null;

  const results = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !NODE_TYPES.has(item.type)) continue;
    if (item.transport && item.transport.type === 'xhttp') {
      stats.unsupported += 1;
      continue;
    }
    const tag = cleanText(item.tag || item.remark || '', 120);
    if (tag.startsWith(OUTPUT_PREFIX)) continue;
    const server = normalizeHost(item.server);
    const serverPort = parsePort(item.server_port || item.port);
    if (!server || !serverPort) {
      stats.invalid += 1;
      continue;
    }
    results.push(finish({
      outbound: { ...item, server, server_port: serverPort },
      tag: tag || `${item.type} ${server}:${serverPort}`,
    }, stats));
  }
  return results.filter(Boolean);
}

function parseList(input, options = {}) {
  const stats = {
    lines: 0,
    parsed: 0,
    duplicates: 0,
    invalid: 0,
    unsupported: 0,
    privateHost: 0,
    allowPrivateHosts: Boolean(options.allowPrivateHosts),
    byType: {},
  };
  const results = [];
  const seen = new Set();

  const push = (item) => {
    if (!item) return;
    if (seen.has(item.fp)) {
      stats.duplicates += 1;
      return;
    }
    seen.add(item.fp);
    results.push(item);
    stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;
  };

  let text = String(input || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { nodes: results, stats };

  const json = parseJsonList(text, stats);
  if (json) {
    json.forEach(push);
    stats.parsed = results.length;
    return { nodes: results, stats };
  }

  if (!text.includes('://') && looksBase64(text)) {
    const decoded = decodeBase64(text);
    if (decoded && decoded.includes('://')) text = decoded.replace(/^\uFEFF/, '').trim();
  }

  const lines = text.split(/\r?\n/);
  stats.lines = lines.length;
  const splitUris = /\s+(?=(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|anytls|socks5?|http):\/\/)/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    for (const token of trimmed.split(splitUris)) {
      const candidate = parseUri(token.trim(), stats);
      if (candidate) push(candidate);
    }
  }
  stats.parsed = results.length;
  return { nodes: results, stats };
}

function encPart(value) {
  return encodeURIComponent(String(value));
}

function hostForLink(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function buildQuery(params) {
  const parts = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${encPart(key)}=${encPart(value)}`);
  }
  return parts.join('&');
}

function tagFragment(tag) {
  const clean = cleanText(tag, 110);
  return clean ? `#${encPart(clean)}` : '';
}

function encodeUserInfo(user, pass) {
  return Buffer.from(`${user}:${pass}`, 'utf8').toString('base64url');
}

function tlsLinkParams(tls) {
  if (!tls || tls.enabled === false) return {};
  const reality = tls.reality && tls.reality.enabled;
  const params = { security: reality ? 'reality' : 'tls' };
  if (tls.server_name) params.sni = tls.server_name;
  if (reality) {
    if (tls.reality.public_key) params.pbk = tls.reality.public_key;
    if (tls.reality.short_id) params.sid = tls.reality.short_id;
    params.fp = (tls.utls && tls.utls.fingerprint) || 'chrome';
  } else if (tls.utls && tls.utls.enabled && tls.utls.fingerprint) {
    params.fp = tls.utls.fingerprint;
  }
  if (tls.insecure) params.insecure = '1';
  if (Array.isArray(tls.alpn) && tls.alpn.length) params.alpn = tls.alpn.join(',');
  return params;
}

function transportLinkParams(transport) {
  if (!transport || !transport.type) return { type: 'tcp' };
  const type = String(transport.type).toLowerCase();
  const hostValue = (value) => (Array.isArray(value) ? value.filter(Boolean).join(',') : String(value || ''));

  if (type === 'tcp' || type === 'raw' || type === 'none') return { type: 'tcp' };
  if (type === 'ws' || type === 'websocket') {
    const headers = transport.headers || {};
    return {
      type: 'ws',
      path: transport.path || '/',
      host: headers.Host || headers.host || '',
    };
  }
  if (type === 'grpc') {
    const params = { type: 'grpc', serviceName: transport.service_name || '' };
    if (transport.mode) params.mode = transport.mode;
    return params;
  }
  if (type === 'httpupgrade') {
    return { type: 'httpupgrade', path: transport.path || '/', host: hostValue(transport.host) };
  }
  if (type === 'http' || type === 'h2') {
    return { type: 'tcp', header: 'http', path: transport.path || '/', host: hostValue(transport.host) };
  }
  return null;
}

function vmessLink(outbound, tag, server, port) {
  const uuid = String(outbound.uuid || '').trim();
  if (!uuid) return null;

  const data = {
    v: '2',
    ps: cleanText(tag, 110) || `${server}:${port}`,
    add: server,
    port: String(port),
    id: uuid,
    aid: String(outbound.alter_id || 0),
    scy: String(outbound.security || 'auto'),
    net: 'tcp',
    type: 'none',
    host: '',
    path: '',
    tls: '',
    sni: '',
  };

  const transportType = (outbound.transport && outbound.transport.type) || 'tcp';
  const normalized = String(transportType).toLowerCase();
  if (normalized === 'tcp' || normalized === 'raw' || normalized === 'none') {
    // default already tcp
  } else if (normalized === 'ws' || normalized === 'websocket') {
    const headers = outbound.transport.headers || {};
    data.net = 'ws';
    data.path = outbound.transport.path || '/';
    data.host = headers.Host || headers.host || '';
  } else if (normalized === 'grpc') {
    data.net = 'grpc';
    data.path = outbound.transport.service_name || '';
  } else if (normalized === 'httpupgrade') {
    data.net = 'httpupgrade';
    data.path = outbound.transport.path || '/';
    data.host = typeof outbound.transport.host === 'string' ? outbound.transport.host : '';
  } else {
    return null;
  }

  const tls = outbound.tls;
  if (tls && tls.enabled !== false) {
    const reality = tls.reality && tls.reality.enabled;
    if (reality) {
      data.security = 'reality';
      data.pbk = tls.reality.public_key || '';
      data.sid = tls.reality.short_id || '';
    } else {
      data.tls = 'tls';
    }
    if (tls.server_name) data.sni = tls.server_name;
    if (tls.utls && tls.utls.fingerprint) data.fp = tls.utls.fingerprint;
    if (Array.isArray(tls.alpn) && tls.alpn.length) data.alpn = tls.alpn.join(',');
    if (tls.insecure) data.insecure = '1';
  }

  return `vmess://${Buffer.from(JSON.stringify(data), 'utf8').toString('base64')}`;
}

function outboundToLink(outbound, tag) {
  if (!outbound || typeof outbound !== 'object') return null;
  const server = normalizeHost(outbound.server);
  const port = parsePort(outbound.server_port);
  if (!server || !port) return null;

  const type = String(outbound.type || '').toLowerCase();
  const host = hostForLink(server);
  const transport = transportLinkParams(outbound.transport);
  if (transport === null) return null;

  if (type === 'vless') {
    const uuid = String(outbound.uuid || '').trim();
    if (!uuid) return null;
    const params = { encryption: 'none' };
    Object.assign(params, tlsLinkParams(outbound.tls));
    Object.assign(params, transport);
    if (outbound.flow) params.flow = outbound.flow;
    if (outbound.packet_encoding && outbound.packet_encoding !== 'none') {
      params['packet-encoding'] = outbound.packet_encoding;
    }
    return `vless://${encPart(uuid)}@${host}:${port}?${buildQuery(params)}${tagFragment(tag)}`;
  }

  if (type === 'vmess') return vmessLink(outbound, tag, server, port);

  if (type === 'trojan') {
    const password = String(outbound.password || '');
    if (!password) return null;
    const params = {};
    Object.assign(params, tlsLinkParams(outbound.tls), transport);
    return `trojan://${encPart(password)}@${host}:${port}?${buildQuery(params)}${tagFragment(tag)}`;
  }

  if (type === 'shadowsocks') {
    const method = String(outbound.method || '');
    const password = String(outbound.password ?? '');
    if (!method || method === 'none' || !password) return null;
    const params = {};
    if (outbound.plugin) {
      params.plugin = outbound.plugin_opts
        ? `${outbound.plugin};${outbound.plugin_opts}`
        : outbound.plugin;
    }
    const query = buildQuery(params);
    return `ss://${encodeUserInfo(method, password)}@${host}:${port}${query ? `?${query}` : ''}${tagFragment(tag)}`;
  }

  if (type === 'hysteria2') {
    const password = String(outbound.password || '');
    if (!password) return null;
    const params = {};
    const tls = outbound.tls;
    if (tls && tls.enabled !== false) {
      if (tls.server_name) params.sni = tls.server_name;
      if (tls.insecure) params.insecure = '1';
    }
    if (outbound.obfs && outbound.obfs.password) {
      params.obfs = outbound.obfs.type || 'salamander';
      params['obfs-password'] = outbound.obfs.password;
    }
    return `hy2://${encPart(password)}@${host}:${port}?${buildQuery(params)}${tagFragment(tag)}`;
  }

  if (type === 'socks') {
    const auth = outbound.username ? `${encPart(outbound.username)}:${encPart(outbound.password || '')}@` : '';
    return `socks5://${auth}${host}:${port}${tagFragment(tag)}`;
  }

  if (type === 'http') {
    const auth = outbound.username ? `${encPart(outbound.username)}:${encPart(outbound.password || '')}@` : '';
    return `http://${auth}${host}:${port}${tagFragment(tag)}`;
  }

  return null;
}

module.exports = {
  parseList,
  parseUri,
  outboundToLink,
  isPrivateHost,
  looksBase64,
  decodeBase64,
  LINK_TYPES: ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'socks', 'http'],
  SUPPORTED_SCHEMES: [
    'vless', 'vmess', 'trojan', 'ss',
    'hysteria', 'hysteria2', 'hy2',
    'tuic', 'anytls', 'socks', 'socks5',
  ],
};
