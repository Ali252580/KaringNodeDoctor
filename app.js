'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Store, isHealthy } = require('./lib/state');
const { Scheduler } = require('./lib/scheduler');
const { buildSubscription, buildV2raySubscription, healthyRecords } = require('./lib/subgen');
const { coreAvailable, CORE_PATH, stopAllTestProcesses } = require('./lib/tester');
const { cleanupStaleProxy } = require('./lib/systemproxy');
const { readSubscriptionSync, readTunSetting, writeTunSetting, isKaringRunning } = require('./lib/karing');
const { cleanText } = require('./lib/util');

const VERSION = '1.1.4';
const ROOT = __dirname;
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.KND_PORT) || 3210;
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_NAME = 'KaringNodeDoctor';
const HIDDEN_MODE = process.argv.includes('--hidden') || process.env.KND_OPEN === '0';

const DATA_DIR = process.env.KND_STATE_DIR
  ? path.resolve(process.env.KND_STATE_DIR)
  : path.join(ROOT, 'data');
const store = new Store(DATA_DIR);
const scheduler = new Scheduler(store);
const bootedAt = Date.now();
let boundPort = BASE_PORT;
let karingErrorCache = { at: 0, error: null };
let autostartCache = { at: 0, value: null };

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

function applyHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
}

function sendJson(res, status, payload) {
  applyHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('حجم درخواست بیش از حد مجاز است'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('بدنه درخواست JSON معتبر نیست'));
      }
    });
    req.on('error', reject);
  });
}

function safeTokenEqual(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function karingInfo() {
  try {
    const scan = scheduler.scanKaring(60_000);
    karingErrorCache = { at: 0, error: null };
    return {
      dataDir: scan.dataDir,
      corePath: scan.corePath,
      version: scan.karingVersion,
      stats: scan.stats,
    };
  } catch (error) {
    if (!karingErrorCache.error || Date.now() - karingErrorCache.at > 15_000) {
      karingErrorCache = { at: Date.now(), error: cleanText(error.message, 300) };
    }
    return { error: karingErrorCache.error };
  }
}

function countsSnapshot() {
  const settings = store.data.settings;
  const now = Date.now();
  let tested = 0;
  let failing = 0;
  let unsupported = 0;

  for (const record of Object.values(store.data.nodes)) {
    if (!record) continue;
    if (record.unsupported) {
      unsupported += 1;
      continue;
    }
    if (!record.lastTestAt) continue;
    tested += 1;
    if (!isHealthy(record, settings, now) && (record.fails || 0) > 0) failing += 1;
  }

  const healthyList = healthyRecords(store, now);
  const healthy = healthyList.length;
  const webHealthy = healthyList.filter((record) => record.profileId === '__web__').length;
  return {
    records: Object.keys(store.data.nodes).length,
    tested,
    failing,
    unsupported,
    healthy,
    webHealthy,
    webPool: Object.keys(store.data.web.pool || {}).length,
    output: Math.min(healthy, settings.maxWorkingNodes),
  };
}

function queryAutostart() {
  if (process.platform !== 'win32') return Promise.resolve({ supported: false, enabled: false });
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_PATH, '/v', REG_NAME], { windowsHide: true }, (error, stdout) => {
      resolve({ supported: true, enabled: !error && String(stdout).includes(REG_NAME) });
    });
  });
}

async function getAutostart() {
  if (autostartCache.value && Date.now() - autostartCache.at < 20_000) return autostartCache.value;
  const value = await queryAutostart();
  autostartCache = { at: Date.now(), value };
  return value;
}

function writeHiddenLauncher() {
  const nodeExe = process.execPath;
  if (!/node\.exe$/i.test(nodeExe)) {
    throw new Error('برنامه با Node.js اجرا نشده است؛ برای شروع خودکار ابتدا start.bat را اجرا کنید.');
  }
  const appFile = path.join(ROOT, 'app.js');
  const launcher = path.join(ROOT, 'start-hidden.vbs');
  const content = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${ROOT.replace(/"/g, '')}"`,
    `shell.Run """${nodeExe}"" ""${appFile}"" --hidden", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(launcher, content, 'utf8');
  return launcher;
}

function setAutostart(enabled) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('شروع خودکار فقط روی ویندوز پشتیبانی می‌شود.'));
  }
  return new Promise((resolve, reject) => {
    if (!enabled) {
      execFile('reg', ['delete', REG_PATH, '/v', REG_NAME, '/f'], { windowsHide: true }, (error) => {
        if (error && !/unable to find/i.test(String(error.message))) {
          return reject(new Error('حذف شروع خودکار انجام نشد.'));
        }
        resolve({ enabled: false });
      });
      return;
    }

    let launcher;
    try {
      launcher = writeHiddenLauncher();
    } catch (error) {
      return reject(error);
    }
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const command = `"${wscript}" "${launcher}"`;
    execFile(
      'reg',
      ['add', REG_PATH, '/v', REG_NAME, '/t', 'REG_SZ', '/d', command, '/f'],
      { windowsHide: true },
      (error) => {
        if (error) return reject(new Error('ثبت شروع خودکار انجام نشد.'));
        resolve({ enabled: true });
      }
    );
  });
}

async function ensureAutostart() {
  if (process.env.KND_NO_AUTOSTART === '1') return;
  if (process.platform !== 'win32') return;
  if (!store.data.settings.autoStart) return;
  try {
    const info = await queryAutostart();
    if (!info.supported) return;
    if (info.enabled) {
      try { writeHiddenLauncher(); } catch {}
      return;
    }
    await setAutostart(true);
    autostartCache = { at: Date.now(), value: { supported: true, enabled: true } };
  } catch (error) {
    console.error('ثبت اجرای خودکار ناموفق بود:', cleanText(error.message, 200));
  }
}

let proxyCleanupBusy = false;

async function runProxyCleanup() {
  if (proxyCleanupBusy || process.platform !== 'win32') return;
  proxyCleanupBusy = true;
  try {
    const result = await cleanupStaleProxy();
    if (result.cleared) {
      console.log(`تنظیم پروکسی سیستم پس از قطع VPN پاک شد: ${result.previous}`);
    }
  } catch (error) {
    console.error('پاک‌سازی پروکسی سیستم ناموفق بود:', cleanText(error.message, 200));
  } finally {
    proxyCleanupBusy = false;
  }
}

function probeExistingInstance(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/status', timeout: 700 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 200_000) req.destroy();
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data && data.app && data.app.version ? data : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function findExistingInstance() {
  for (let port = BASE_PORT; port < BASE_PORT + 20; port += 1) {
    const existing = await probeExistingInstance(port);
    if (existing) return { port, status: existing };
  }
  return null;
}

function buildKaringSync(karing, counts) {
  if (!karing || !karing.dataDir) return null;
  let sync;
  try {
    sync = readSubscriptionSync(karing.dataDir, `/sub/${store.data.subToken}.json`);
  } catch {
    return null;
  }
  if (!sync.found) return { found: false, expected: counts.output };
  return {
    found: true,
    remark: sync.remark,
    enabled: sync.enabled,
    nodes: sync.nodes,
    updateAt: sync.updateAt,
    refreshMinutes: sync.refreshMinutes,
    nextAt: sync.updateAt && sync.refreshMinutes
      ? sync.updateAt + sync.refreshMinutes * 60_000
      : null,
    expected: counts.output,
    stale: sync.enabled && sync.nodes < counts.output,
  };
}

function buildTunStatus(dataDir) {
  if (!dataDir) return { available: false, error: 'تنظیمات Karing در دسترس نیست.' };
  try {
    return readTunSetting(dataDir);
  } catch (error) {
    return { available: false, error: cleanText(error.message, 300) };
  }
}

let runningProbe = { at: 0, value: null };
async function probeKaringRunning(dataDir) {
  if (!dataDir) return null;
  if (runningProbe.value !== null && Date.now() - runningProbe.at < 5000) return runningProbe.value;
  let value = false;
  try {
    value = await isKaringRunning(dataDir);
  } catch {
    value = false;
  }
  runningProbe = { at: Date.now(), value };
  return value;
}

function buildV2rayInfo() {
  try {
    const generated = buildV2raySubscription(store);
    return {
      path: `/v2ray/${store.data.subToken}.txt`,
      count: generated.count,
      skipped: generated.skipped,
      skippedCount: generated.skippedCount,
    };
  } catch {
    return { path: `/v2ray/${store.data.subToken}.txt`, count: 0, skipped: {}, skippedCount: 0 };
  }
}

function buildStatus(autostart) {
  const counts = countsSnapshot();
  let karing;
  try {
    karing = karingInfo();
  } catch {
    karing = {};
  }
  return {
    app: {
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
      port: boundPort,
      coreReady: coreAvailable(),
      corePath: CORE_PATH,
    },
    karing,
    karingSync: buildKaringSync(karing, counts),
    karingTun: buildTunStatus(karing.dataDir),
    web: {
      enabled: Boolean(store.data.settings.webEnabled),
      ...scheduler.web.counts(),
      sources: scheduler.web.sourceStatus(),
    },
    settings: store.data.settings,
    run: scheduler.runState,
    lastRun: store.data.lastRun,
    counts,
    subscription: {
      path: `/sub/${store.data.subToken}.json`,
      output: counts.output,
      healthy: counts.healthy,
      v2ray: buildV2rayInfo(),
    },
    autostart,
  };
}

function nodeSummary(record) {
  return {
    tag: record.tag,
    type: record.type,
    transport: record.transport,
    profileRemark: record.profileRemark,
    lastMs: Number.isFinite(record.lastMs) ? record.lastMs : null,
    lastOkAt: record.lastOkAt || null,
    lastTestAt: record.lastTestAt || null,
    fails: record.fails || 0,
    totalOk: record.totalOk || 0,
    totalFail: record.totalFail || 0,
    lastError: record.lastError || null,
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/status') {
    const autostart = await getAutostart();
    const status = buildStatus(autostart);
    status.karingRunning = await probeKaringRunning(status.karing && status.karing.dataDir);
    return sendJson(res, 200, status);
  }

  if (req.method === 'GET' && pathname === '/api/profiles') {
    const healthy = healthyRecords(store);
    const healthyByProfile = new Map();
    for (const record of healthy) {
      healthyByProfile.set(record.profileId, (healthyByProfile.get(record.profileId) || 0) + 1);
    }
    try {
      const scan = scheduler.scanKaring(30_000);
      const profiles = scan.profiles.map((profile) => ({
        id: profile.id,
        remark: profile.remark,
        type: profile.type,
        enabled: profile.enabled && store.data.settings.includeProfiles[profile.id] !== false,
        sourceEnabled: profile.enabled,
        unique: profile.unique,
        healthy: healthyByProfile.get(profile.id) || 0,
      }));
      return sendJson(res, 200, {
        profiles,
        stats: scan.stats,
        karingVersion: scan.karingVersion,
      });
    } catch (error) {
      return sendJson(res, 503, { error: cleanText(error.message, 300), profiles: [] });
    }
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    const patch = body && typeof body.settings === 'object' && body.settings ? body.settings : body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return sendJson(res, 400, { error: 'تنظیمات معتبر نیست.' });
    }
    const settings = store.updateSettings(patch);
    scheduler.refreshAuto();
    return sendJson(res, 200, { ok: true, settings });
  }

  if (req.method === 'POST' && pathname === '/api/run') {
    if (scheduler.runState.running) {
      return sendJson(res, 409, { error: 'یک دوره تست در حال اجرا است.', run: scheduler.runState });
    }
    scheduler.runCycle('manual').catch(() => {});
    return sendJson(res, 202, { ok: true, run: scheduler.runState });
  }

  if (req.method === 'POST' && pathname === '/api/web/refresh') {
    if (scheduler.runState.running) {
      return sendJson(res, 409, { error: 'یک دوره تست در حال اجرا است.', run: scheduler.runState });
    }
    scheduler.runCycle('manual', { forceWeb: true }).catch(() => {});
    return sendJson(res, 202, { ok: true, run: scheduler.runState });
  }

  if (req.method === 'GET' && pathname === '/api/results') {
    const now = Date.now();
    const settings = store.data.settings;
    const records = Object.values(store.data.nodes).filter(Boolean);

    const healthy = healthyRecords(store, now).slice(0, 300).map(nodeSummary);
    const failing = records
      .filter((record) => !record.unsupported && record.lastTestAt && (record.fails || 0) > 0
        && !(settings.includeProfiles[record.profileId] === false))
      .sort((a, b) => (b.lastTestAt || 0) - (a.lastTestAt || 0))
      .slice(0, 150)
      .map(nodeSummary);

    return sendJson(res, 200, {
      healthy,
      failing,
      counts: countsSnapshot(),
      lastRun: store.data.lastRun,
      history: store.data.history.slice(-10).reverse(),
    });
  }

  if (req.method === 'POST' && pathname === '/api/karing/tun') {
    const body = await readBody(req);
    const enable = Boolean(body && body.enable);
    let dataDir;
    try {
      dataDir = scheduler.scanKaring(60_000).dataDir;
    } catch (error) {
      return sendJson(res, 503, { error: cleanText(error.message, 300) || 'تنظیمات Karing در دسترس نیست.' });
    }
    try {
      const tun = writeTunSetting(dataDir, enable);
      runningProbe = { at: 0, value: null };
      const running = await probeKaringRunning(dataDir);
      return sendJson(res, 200, {
        ok: true,
        tun,
        running,
        note: running
          ? (enable
            ? 'برای روشن شدن واقعی، Karing را کامل ببندید (از آیکون کنار ساعت) و دوباره باز کنید.'
            : 'برای خاموش شدن واقعی، Karing را کامل ببندید (از آیکون کنار ساعت) و دوباره باز کنید.')
          : (enable
            ? 'تنظیم ذخیره شد؛ با اجرای بعدی Karing و اتصال، TUN فعال می‌شود.'
            : 'تنظیم ذخیره شد؛ با اجرای بعدی Karing حالت TUN خاموش می‌ماند.'),
      });
    } catch (error) {
      return sendJson(res, 500, { error: cleanText(error.message, 300) || 'تغییر حالت TUN ممکن نشد.' });
    }
  }

  if (pathname === '/api/autostart') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await getAutostart());
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const enabled = Boolean(body.enabled);
      try {
        const result = await setAutostart(enabled);
        autostartCache = { at: Date.now(), value: { supported: true, ...result } };
        store.updateSettings({ autoStart: enabled });
        return sendJson(res, 200, { supported: true, ...result });
      } catch (error) {
        return sendJson(res, 400, { error: cleanText(error.message, 300) });
      }
    }
  }

  return sendJson(res, 404, { error: 'مسیر API پیدا نشد.' });
}

async function handler(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}:${boundPort}`).pathname;
  } catch {
    return sendJson(res, 400, { error: 'درخواست نامعتبر است.' });
  }

  if (pathname.startsWith('/api/')) {
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const allowedOrigins = [`http://${HOST}:${boundPort}`, `http://localhost:${boundPort}`];
      if (origin && !allowedOrigins.includes(origin)) {
        return sendJson(res, 403, { error: 'درخواست از مبدأ غیرمجاز رد شد.' });
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return sendJson(res, 415, { error: 'نوع درخواست باید JSON باشد.' });
      }
    }
    try {
      return await handleApi(req, res, pathname);
    } catch (error) {
      return sendJson(res, 500, { error: cleanText(error.message, 300) || 'خطای داخلی' });
    }
  }

  if (pathname.startsWith('/sub/')) {
    const name = decodeURIComponent(pathname.slice('/sub/'.length));
    const token = name.replace(/\.json$/i, '');
    if (!safeTokenEqual(token, store.data.subToken)) {
      applyHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    const subscription = buildSubscription(store);
    applyHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Node-Count': String(subscription.count),
    });
    return res.end(JSON.stringify(subscription));
  }

  if (pathname.startsWith('/v2ray/')) {
    const name = decodeURIComponent(pathname.slice('/v2ray/'.length));
    const token = name.replace(/\.txt$/i, '');
    if (!safeTokenEqual(token, store.data.subToken)) {
      applyHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    const generated = buildV2raySubscription(store);
    applyHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Node-Count': String(generated.count),
      'X-Skipped-Count': String(generated.skippedCount),
    });
    return res.end(generated.base64);
  }

  const entry = STATIC_FILES.get(pathname);
  if (entry && req.method === 'GET') {
    try {
      const content = fs.readFileSync(path.join(ROOT, 'public', entry.file));
      applyHeaders(res);
      res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-store' });
      return res.end(content);
    } catch {
      applyHeaders(res);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('public file missing');
    }
  }

  applyHeaders(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handler(req, res).catch(() => {
        try { res.writeHead(500); res.end(); } catch {}
      });
    });
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

async function main() {
  if (!coreAvailable()) {
    console.error('موتور تست پیدا نشد. فایل core\\sing-box.exe را بررسی کنید.');
    process.exitCode = 1;
    return;
  }

  const existing = await findExistingInstance();
  if (existing) {
    const url = `http://${HOST}:${existing.port}`;
    console.log(`Karing Node Doctor از قبل روی ${url} در حال اجراست.`);
    if (!HIDDEN_MODE) {
      execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    }
    return;
  }

  let server = null;
  for (let port = BASE_PORT; port < BASE_PORT + 20; port += 1) {
    try {
      server = await listen(port);
      boundPort = port;
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }

  if (!server) {
    console.error('هیچ پورت آزادی بین 3210 تا 3229 پیدا نشد.');
    process.exitCode = 1;
    return;
  }

  scheduler.start();
  ensureAutostart();

  runProxyCleanup();
  const proxyTimer = setInterval(runProxyCleanup, 30_000);
  proxyTimer.unref();

  const url = `http://${HOST}:${boundPort}`;
  console.log('');
  console.log(`Karing Node Doctor v${VERSION}`);
  console.log(`داشبورد: ${url}`);
  console.log(`آدرس ساب‌سکریپشن برای Karing: ${url}/sub/${store.data.subToken}.json`);
  console.log(`آدرس لینک‌ها برای v2rayA:      ${url}/v2ray/${store.data.subToken}.txt`);
  console.log('برای توقف: Ctrl+C');
  console.log('');

  if (!HIDDEN_MODE) {
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }

  const shutdown = () => {
    stopAllTestProcesses();
    try { server.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('اجرای برنامه ناموفق بود:', error.message);
  process.exitCode = 1;
});
