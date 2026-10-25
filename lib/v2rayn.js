'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SUB_REMARK = 'KaringNodeDoctor';
const SING_BOX = 24;
// v2rayN runs every profile with xray unless the core type is overridden,
// and xray >= 26.2.6 refuses plaintext / allowInsecure nodes that sing-box accepts.
const SING_BOX_CONFIG_TYPES = [1, 3, 4, 5, 6, 7]; // VMess SS SOCKS VLESS Trojan Hysteria2
const DB_RELATIVES = [
  path.join('guiConfigs', 'guiNDB.db'),
  path.join('guiConfigs', 'v2rayN.db'),
  'guiNDB.db',
];

let sqliteModule = null;
let sqliteChecked = false;

function sqlite() {
  if (sqliteChecked) return sqliteModule;
  sqliteChecked = true;
  try {
    sqliteModule = require('node:sqlite').DatabaseSync;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function scanRoots() {
  const home = os.homedir();
  const roots = [
    process.env.KND_V2N_DIR ? path.dirname(process.env.KND_V2N_DIR) : null,
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    home,
    process.env.APPDATA,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  return [...new Set(roots)];
}

function guessDatabases() {
  const candidates = [];
  if (process.env.KND_V2N_DIR) {
    for (const relative of DB_RELATIVES) candidates.push(path.join(process.env.KND_V2N_DIR, relative));
  }

  for (const root of scanRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/v2rayn/i.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      for (const relative of DB_RELATIVES) candidates.push(path.join(dir, relative));
    }
  }

  return candidates.filter(fileExists);
}

function runningProcessPath() {
  return new Promise((resolve) => {
    const script = "(Get-Process v2rayN -ErrorAction SilentlyContinue | Select-Object -First 1).Path";
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 6000 }, (error, stdout) => {
      const text = String(stdout || '').trim();
      resolve(error || !text ? null : text);
    });
  });
}

let dbCache = { at: 0, path: null, source: null };

async function locateDatabase(force = false) {
  const Database = sqlite();
  if (!Database) {
    return { available: false, error: 'برای نوشتن در v2rayN به Node.js نسخه ۲۲.۵ یا بالاتر نیاز است.' };
  }

  if (!force && dbCache.path && Date.now() - dbCache.at < 60_000) {
    return { available: true, dbPath: dbCache.path, source: dbCache.source };
  }

  if (process.env.KND_V2N_DB && fileExists(process.env.KND_V2N_DB)) {
    dbCache = { at: Date.now(), path: process.env.KND_V2N_DB, source: 'env' };
    return { available: true, dbPath: process.env.KND_V2N_DB, source: 'env' };
  }

  const exePath = await runningProcessPath();
  if (exePath) {
    const dir = path.dirname(exePath);
    for (const relative of DB_RELATIVES) {
      const candidate = path.join(dir, relative);
      if (fileExists(candidate)) {
        dbCache = { at: Date.now(), path: candidate, source: 'process' };
        return { available: true, dbPath: candidate, source: 'process' };
      }
    }
  }

  const guessed = guessDatabases();
  if (guessed.length) {
    dbCache = { at: Date.now(), path: guessed[0], source: 'scan' };
    return { available: true, dbPath: guessed[0], source: 'scan' };
  }

  return { available: false, error: 'فایل داده v2rayN (guiNDB.db) پیدا نشد.' };
}

function isV2rayNRunning() {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq v2rayN.exe', '/NH'], { windowsHide: true, timeout: 6000 }, (error, stdout) => {
      resolve(!error && /v2rayn\.exe/i.test(String(stdout || '')));
    });
  });
}

function openDatabase(dbPath, readOnly) {
  const Database = sqlite();
  const db = new Database(dbPath, { readOnly: Boolean(readOnly) });
  try {
    db.exec('pragma busy_timeout = 2500');
  } catch {}
  return db;
}

function readState(db, url, origin) {
  const hasTable = db.prepare("select name from sqlite_master where type = 'table' and name = 'SubItem'").get();
  if (!hasTable) {
    return { schema: false, registered: false, nodes: 0 };
  }

  const row = db.prepare('select Id, Remarks, AutoUpdateInterval, UpdateTime from SubItem where Url = ?').get(url);
  if (!row) return { schema: true, registered: false, nodes: 0 };

  let nodes = 0;
  try {
    nodes = db.prepare('select count(*) as n from ProfileItem where Subid = ?').get(row.Id).n;
  } catch {}

  return {
    schema: true,
    registered: true,
    subId: row.Id,
    remarks: row.Remarks,
    autoUpdateMinutes: Number(row.AutoUpdateInterval) || 0,
    updateTime: Number(row.UpdateTime) || 0,
    nodes,
    junk: scanJunk(db, origin),
  };
}

async function inspect(url, origin) {
  const located = await locateDatabase();
  if (!located.available) return { ...located, running: await isV2rayNRunning() };

  let state = { schema: false, registered: false, nodes: 0 };
  try {
    const db = openDatabase(located.dbPath, true);
    try {
      state = readState(db, url, origin);
      if (!state.junk) state.junk = scanJunk(db, origin);
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      available: true,
      dbPath: located.dbPath,
      running: await isV2rayNRunning(),
      error: `خواندن پایگاه‌داده v2rayN ممکن نشد: ${error.message}`,
      registered: false,
      nodes: 0,
    };
  }

  return {
    ...located,
    running: await isV2rayNRunning(),
    core: coreState(located.dbPath),
    ...state,
  };
}

function newId() {
  const hex = crypto.randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// v2rayN turns every sing-box JSON profile it cannot parse into a ConfigType 13
// (Outbound) row whose Address is a dangling "<uuid>.json" reference, Port 0 and no Subid.
function junkOutboundWhere() {
  return "ConfigType = 13 and Address is not null and Address like '%.json'";
}

function foreignSubWhere(origin) {
  if (!origin) return '0';
  const needle = `${String(origin).replace(/^https?:\/\//, '')}/sub/`;
  return `Url like '%${needle.replace(/'/g, "''")}%.json'`;
}

function scanJunk(db, origin) {
  const junk = { foreignSubs: [], outboundRows: 0 };
  try {
    junk.foreignSubs = db.prepare(`select Id, Remarks, Url from SubItem where ${foreignSubWhere(origin)}`).all();
  } catch {}
  try {
    junk.outboundRows = db.prepare(`select count(*) as n from ProfileItem where ${junkOutboundWhere()}`).get().n;
  } catch {}
  junk.hasJunk = junk.foreignSubs.length > 0 || junk.outboundRows > 0;
  return junk;
}

function backupDatabase(dbPath) {
  try {
    const db = openDatabase(dbPath, false);
    try {
      db.exec('pragma wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch {}
  // One backup per day keeps repeated heals from piling up copies.
  const stamp = new Date().toISOString().slice(0, 10);
  const target = `${dbPath}.knd-backup-${stamp}`;
  try {
    fs.copyFileSync(dbPath, target);
    return target;
  } catch {
    return null;
  }
}

async function cleanupJunk(origin) {
  const located = await locateDatabase(true);
  if (!located.available) throw Object.assign(new Error(located.error), { code: 'NO_DB' });

  const db = openDatabase(located.dbPath, false);
  try {
    const junk = scanJunk(db, origin);
    if (!junk.hasJunk) return { removedSubs: 0, removedRows: 0, backup: null };

    const backup = backupDatabase(located.dbPath);
    let removedRows = 0;

    for (const sub of junk.foreignSubs) {
      removedRows += db.prepare('delete from ProfileExItem where IndexId in (select IndexId from ProfileItem where Subid = ?)').run(sub.Id).changes;
      removedRows += db.prepare('delete from ProfileItem where Subid = ?').run(sub.Id).changes;
      try {
        db.prepare('delete from ProfileGroupItem where ItemId = ?').run(sub.Id);
      } catch {}
      removedRows += db.prepare('delete from SubItem where Id = ?').run(sub.Id).changes;
    }

    const outbound = db.prepare(`select IndexId from ProfileItem where ${junkOutboundWhere()}`).all();
    for (const row of outbound) {
      db.prepare('delete from ProfileExItem where IndexId = ?').run(row.IndexId);
      removedRows += db.prepare('delete from ProfileItem where IndexId = ?').run(row.IndexId).changes;
    }

    return { removedSubs: junk.foreignSubs.length, removedRows, backup };
  } finally {
    db.close();
  }
}

async function register(url, intervalMinutes = 60) {
  const located = await locateDatabase();
  if (!located.available) throw Object.assign(new Error(located.error), { code: 'NO_DB' });

  const db = openDatabase(located.dbPath, false);
  try {
    const state = readState(db, url);
    if (!state.schema) {
      throw Object.assign(new Error('جدول اشتراک در پایگاه‌داده v2rayN پیدا نشد.'), { code: 'NO_TABLE' });
    }
    const interval = Math.min(1440, Math.max(5, Number(intervalMinutes) || 60));
    if (state.registered) {
      db.prepare('update SubItem set Remarks = ?, AutoUpdateInterval = ?, UpdateTime = 0 where Id = ?')
        .run(SUB_REMARK, interval, state.subId);
      return { dbPath: located.dbPath, subId: state.subId, intervalMinutes: interval, created: false };
    }

    const subId = newId();
    db.prepare(`insert into SubItem
      (Id, Remarks, Url, Enabled, UserAgent, Sort, AutoUpdateInterval, UpdateTime)
      values (?, ?, ?, 1, '', 0, ?, 0)`).run(subId, SUB_REMARK, url, interval);
    return { dbPath: located.dbPath, subId, intervalMinutes: interval, created: true };
  } finally {
    db.close();
  }
}

async function unregister(url) {
  const located = await locateDatabase(true);
  if (!located.available) throw Object.assign(new Error(located.error), { code: 'NO_DB' });

  const db = openDatabase(located.dbPath, false);
  try {
    const state = readState(db, url);
    if (!state.registered) return { removed: false };
    db.prepare('delete from ProfileExItem where IndexId in (select IndexId from ProfileItem where Subid = ?)').run(state.subId);
    db.prepare('delete from ProfileItem where Subid = ?').run(state.subId);
    db.prepare('delete from SubItem where Id = ?').run(state.subId);
    return { removed: true };
  } finally {
    db.close();
  }
}

function configFilePath(dbPath) {
  return path.join(path.dirname(dbPath), 'guiNConfig.json');
}

function parseConfigFile(file) {
  if (!fileExists(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return undefined;
  }
}

function readV2rayNConfig(dbPath) {
  const file = configFilePath(dbPath);
  const data = parseConfigFile(file);
  if (data === undefined) return { available: false, file, error: 'bad_json' };
  if (data === null) return { available: false, file, error: 'not_found' };
  return { available: true, file, data };
}

function writeV2rayNConfig(file, data, raw) {
  try {
    fs.writeFileSync(`${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`, raw, 'utf8');
  } catch {}
  const tmp = `${file}.knd-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(file); } catch {}
    fs.renameSync(tmp, file);
  }
}

function coreState(dbPath) {
  const cfg = readV2rayNConfig(dbPath);
  if (!cfg.available) {
    return {
      available: false,
      singbox: false,
      error: cfg.error === 'bad_json'
        ? 'فایل تنظیمات v2rayN قابل خواندن نیست.'
        : 'فایل تنظیمات v2rayN پیدا نشد.',
    };
  }

  const items = Array.isArray(cfg.data.CoreTypeItem) ? cfg.data.CoreTypeItem : [];
  const missing = SING_BOX_CONFIG_TYPES.filter((type) => !items.some((item) => item && item.ConfigType === type && item.CoreType === SING_BOX));
  return {
    available: true,
    singbox: missing.length === 0,
    pendingTypes: missing,
    tun: buildTunInfo(cfg.data.TunModeItem),
  };
}

function buildTunInfo(tun) {
  if (!tun || typeof tun !== 'object') return { enableTun: false, stack: null, mtu: null };
  return {
    enableTun: Boolean(tun.EnableTun),
    stack: tun.Stack || null,
    mtu: tun.Mtu || null,
    autoRoute: tun.AutoRoute !== false,
    strictRoute: tun.StrictRoute !== false,
  };
}

function applySingboxCore(dbPath, subUrl) {
  const cfg = readV2rayNConfig(dbPath);
  if (!cfg.available) {
    throw Object.assign(new Error(cfg.error === 'bad_json'
      ? 'فایل تنظیمات v2rayN خراب است؛ v2rayN را باز کنید و دوباره امتحان کنید.'
      : 'فایل تنظیمات v2rayN پیدا نشد.'), { code: 'NO_CONFIG' });
  }

  const items = Array.isArray(cfg.data.CoreTypeItem) ? cfg.data.CoreTypeItem : [];
  for (const type of SING_BOX_CONFIG_TYPES) {
    const existing = items.find((item) => item && item.ConfigType === type);
    if (existing) existing.CoreType = SING_BOX;
    else items.push({ ConfigType: type, CoreType: SING_BOX });
  }
  cfg.data.CoreTypeItem = items;

  const raw = fs.readFileSync(cfg.file, 'utf8');
  writeV2rayNConfig(cfg.file, cfg.data, raw);

  let profiles = 0;
  if (subUrl) {
    const db = openDatabase(dbPath, false);
    try {
      const sub = db.prepare('select Id from SubItem where Url = ?').get(subUrl);
      if (sub) profiles = db.prepare('update ProfileItem set CoreType = ? where Subid = ?').run(SING_BOX, sub.Id).changes;
    } catch {} finally {
      db.close();
    }
  }

  return { singbox: true, profiles };
}

function setTunEnabled(dbPath, enable) {
  const cfg = readV2rayNConfig(dbPath);
  if (!cfg.available) {
    throw Object.assign(new Error('فایل تنظیمات v2rayN پیدا نشد.'), { code: 'NO_CONFIG' });
  }

  if (!cfg.data.TunModeItem || typeof cfg.data.TunModeItem !== 'object') {
    cfg.data.TunModeItem = { EnableTun: false, AutoRoute: true, StrictRoute: true };
  }
  const raw = fs.readFileSync(cfg.file, 'utf8');
  cfg.data.TunModeItem.EnableTun = Boolean(enable);
  if (enable && !cfg.data.TunModeItem.Stack) cfg.data.TunModeItem.Stack = 'mixed';
  writeV2rayNConfig(cfg.file, cfg.data, raw);

  const after = parseConfigFile(cfg.file);
  if (!after || !after.TunModeItem || Boolean(after.TunModeItem.EnableTun) !== Boolean(enable)) {
    const error = new Error('تنظیم ذخیره شد ولی تأیید نشد؛ v2rayN را ببندید و دوباره امتحان کنید.');
    error.code = 'VERIFY_FAILED';
    throw error;
  }

  return buildTunInfo(after.TunModeItem);
}

function singleQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function launchElevated(dbPath) {
  const exe = path.join(path.dirname(path.dirname(dbPath)), 'v2rayN.exe');
  if (!fileExists(exe)) {
    throw Object.assign(new Error('فایل v2rayN.exe کنار این پوشه پیدا نشد.'), { code: 'NO_EXE' });
  }

  return new Promise((resolve, reject) => {
    const script = `Start-Process -FilePath ${singleQuote(exe)} -Verb RunAs`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20_000 }, (error) => {
      if (error) {
        reject(Object.assign(new Error('اجرای v2rayN با ادمین انجام نشد (پنجرهٔ UAC را تأیید کنید).'), { code: 'LAUNCH_FAILED' }));
        return;
      }
      resolve({ launched: true, exe });
    });
  });
}

module.exports = {
  SUB_REMARK,
  SING_BOX,
  sqliteAvailable: () => Boolean(sqlite()),
  locateDatabase,
  isV2rayNRunning,
  inspect,
  register,
  unregister,
  scanJunk,
  cleanupJunk,
  coreState,
  applySingboxCore,
  setTunEnabled,
  launchElevated,
};
