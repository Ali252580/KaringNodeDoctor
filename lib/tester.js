'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { testViaProxy } = require('./probe');
const { ensureDir, cleanText, sleep, shannonToken } = require('./util');

const CORE_PATH = process.env.KND_CORE || path.join(__dirname, '..', 'core', 'sing-box.exe');
const BATCH_SIZE = 30;
const STARTUP_TIMEOUT_MS = 7000;
const ACTIVE_CHILDREN = new Set();

function stopAllTestProcesses() {
  for (const child of ACTIVE_CHILDREN) {
    try { child.kill(); } catch {}
  }
  ACTIVE_CHILDREN.clear();
}

process.on('exit', stopAllTestProcesses);

function coreAvailable() {
  try { return fs.statSync(CORE_PATH).isFile(); } catch { return false; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function freePorts(count) {
  const ports = [];
  const seen = new Set();
  while (ports.length < count) {
    const port = await freePort();
    if (seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
}

function canConnect(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill(); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function extractError(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return 'موتور تست نتوانست این نود را بارگذاری کند';
  const line = [...lines].reverse().find((item) => /error|fatal|panic|unknown|invalid|decode/i.test(item)) || lines[lines.length - 1];
  return cleanText(line.replace(/^.*?\b(ERROR|FATAL)\b\s*/i, ''), 300);
}

function buildConfig(entries, ports) {
  const inbounds = [];
  const outbounds = [];
  const rules = [];

  entries.forEach((entry, index) => {
    inbounds.push({
      type: 'mixed',
      tag: `knd-in-${index}`,
      listen: '127.0.0.1',
      listen_port: ports[index],
    });
    outbounds.push({ ...entry.outbound, tag: `knd-out-${index}` });
    rules.push({ inbound: [`knd-in-${index}`], outbound: `knd-out-${index}` });
  });

  outbounds.push({ type: 'direct', tag: 'knd-direct' });

  return {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    route: { rules, final: 'knd-direct' },
  };
}

async function waitReady(child, stderrState, port) {
  const started = Date.now();
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null) return false;
    if (await canConnect(port)) return true;
    if (stderrState.text && /fatal|panic/i.test(stderrState.text) && child.exitCode !== null) return false;
    await sleep(140);
  }
  return false;
}

async function runPool(entries, ports, settings, hooks) {
  const results = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index];
      const outcome = await testViaProxy(ports[index], settings.testUrl, settings.timeoutMs);
      const result = { fp: entry.fp, tag: entry.tag, ...outcome };
      results.push(result);
      if (hooks && typeof hooks.onResult === 'function') hooks.onResult(result, entry);
    }
  };

  const workers = Math.max(1, Math.min(settings.concurrency, entries.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

async function runSingleBatch(entries, settings, workDir, depth, hooks) {
  const ports = await freePorts(entries.length);
  const config = buildConfig(entries, ports);
  const configPath = path.join(workDir, `batch-${depth}-${shannonToken(4)}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const stderrState = { text: '' };
  let child;
  try {
    child = spawn(CORE_PATH, ['run', '-c', configPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    return entries.map((entry) => ({
      fp: entry.fp,
      tag: entry.tag,
      ok: false,
      unsupported: true,
      ms: 0,
      error: `اجرای موتور تست ممکن نشد: ${error.message}`,
    }));
  }

  child.stderr.on('data', (chunk) => {
    stderrState.text = (stderrState.text + chunk.toString('utf8')).slice(-6000);
  });
  child.on('error', () => {});
  ACTIVE_CHILDREN.add(child);
  child.once('exit', () => ACTIVE_CHILDREN.delete(child));

  const ready = await waitReady(child, stderrState, ports[0]);

  if (!ready) {
    await stopProcess(child);
    try { fs.unlinkSync(configPath); } catch {}

    if (entries.length > 1) {
      const middle = Math.ceil(entries.length / 2);
      const left = await runSingleBatch(entries.slice(0, middle), settings, workDir, depth + 1, hooks);
      const right = await runSingleBatch(entries.slice(middle), settings, workDir, depth + 1, hooks);
      return [...left, ...right];
    }

    const error = extractError(stderrState.text);
    const result = { fp: entries[0].fp, tag: entries[0].tag, ok: false, unsupported: true, ms: 0, error };
    if (hooks && typeof hooks.onResult === 'function') hooks.onResult(result, entries[0]);
    return [result];
  }

  const results = await runPool(entries, ports, settings, hooks);
  await stopProcess(child);
  try { fs.unlinkSync(configPath); } catch {}
  return results;
}

async function testCandidates(candidates, settings, hooks = {}) {
  if (!coreAvailable()) {
    const error = new Error(`موتور تست پیدا نشد: ${CORE_PATH}`);
    error.code = 'NO_CORE';
    throw error;
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || !candidate.fp || seen.has(candidate.fp)) continue;
    seen.add(candidate.fp);
    unique.push(candidate);
  }

  const workDir = path.join(os.tmpdir(), 'KaringNodeDoctor', shannonToken(6));
  ensureDir(workDir);
  const started = Date.now();
  const results = [];

  try {
    for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
      if (hooks && hooks.cancelled && hooks.cancelled()) break;
      const chunk = unique.slice(offset, offset + BATCH_SIZE);
      const batch = await runSingleBatch(chunk, settings, workDir, 0, hooks);
      results.push(...batch);
    }
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }

  return {
    results,
    durationMs: Date.now() - started,
    tested: results.length,
  };
}

module.exports = {
  CORE_PATH,
  BATCH_SIZE,
  coreAvailable,
  stopAllTestProcesses,
  testCandidates,
};
