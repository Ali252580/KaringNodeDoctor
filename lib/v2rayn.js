'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SUB_REMARK = 'KaringNodeDoctor';
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

function readState(db, url) {
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
  };
}

async function inspect(url) {
  const located = await locateDatabase();
  if (!located.available) return { ...located, running: await isV2rayNRunning() };

  let state = { schema: false, registered: false, nodes: 0 };
  try {
    const db = openDatabase(located.dbPath, true);
    try {
      state = readState(db, url);
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

  return { ...located, running: await isV2rayNRunning(), ...state };
}

function newId() {
  const hex = crypto.randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

module.exports = {
  SUB_REMARK,
  sqliteAvailable: () => Boolean(sqlite()),
  locateDatabase,
  isV2rayNRunning,
  inspect,
  register,
  unregister,
};
