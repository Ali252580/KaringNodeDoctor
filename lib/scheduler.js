'use strict';

const { loadKaring } = require('./karing');
const { filterRussian, purgeRussianRecords } = require('./geo');
const { testCandidates } = require('./tester');
const { buildSubscription, healthyRecords } = require('./subgen');
const { isHealthy } = require('./state');
const { WebManager, WEB_PROFILE_ID, WEB_PROFILE_REMARK } = require('./web');
const { cleanText } = require('./util');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeRunState() {
  return {
    running: false,
    phase: 'idle',
    trigger: null,
    startedAt: null,
    finishedAt: null,
    planned: 0,
    tested: 0,
    ok: 0,
    failed: 0,
    unsupported: 0,
    geoRemoved: 0,
    error: null,
    web: null,
    throttled: null,
  };
}

class Scheduler {
  constructor(store, options = {}) {
    this.store = store;
    this.web = new WebManager(store, options.web || {});
    this.throttle = options.throttle || null;
    this.runState = makeRunState();
    this.timer = null;
    this.scanCache = null;
    this.loopStarted = false;
  }

  scanKaring(maxAgeMs = 30_000) {
    const now = Date.now();
    if (this.scanCache && now - this.scanCache.loadedAt <= maxAgeMs) {
      return this.scanCache.scan;
    }
    const scan = loadKaring();
    this.scanCache = { scan, loadedAt: now };
    return scan;
  }

  selectCandidates(scan, settings) {
    const now = Date.now();
    const records = this.store.data.nodes;
    const profileSize = new Map(scan.profiles.map((profile) => [profile.id, profile.unique]));
    const webFresh = [];
    const fresh = [];
    const healthyDue = [];
    const retry = [];
    const revive = [];

    for (const candidate of scan.candidates) {
      const isWeb = candidate.profileId === WEB_PROFILE_ID;
      if (!isWeb && settings.includeProfiles[candidate.profileId] === false) continue;
      const record = records[candidate.fp];

      if (!record) {
        (isWeb ? webFresh : fresh).push(candidate);
        continue;
      }
      if (record.unsupported) continue;

      if (isHealthy(record, settings, now)) {
        const dueAfter = Math.min(settings.cycleMinutes, 60) * 60_000;
        if (now - (record.lastTestAt || 0) >= dueAfter) healthyDue.push(candidate);
      } else if ((record.fails || 0) < settings.failuresToDrop) {
        retry.push(candidate);
      } else if (now - (record.lastTestAt || 0) >= 6 * HOUR) {
        revive.push(candidate);
      }
    }

    const sizeOf = (candidate) => profileSize.get(candidate.profileId) || Number.MAX_SAFE_INTEGER;
    fresh.sort((a, b) => sizeOf(a) - sizeOf(b) || a.tag.localeCompare(b.tag, 'en'));
    webFresh.sort((a, b) => a.tag.localeCompare(b.tag, 'en'));
    healthyDue.sort((a, b) => (records[a.fp].lastTestAt || 0) - (records[b.fp].lastTestAt || 0));
    retry.sort((a, b) => (records[b.fp].fails || 0) - (records[a.fp].fails || 0)
      || (records[a.fp].lastTestAt || 0) - (records[b.fp].lastTestAt || 0));
    revive.sort((a, b) => (records[a.fp].lastTestAt || 0) - (records[b.fp].lastTestAt || 0));

    const budget = settings.maxTestsPerCycle;
    const picks = [];
    const used = new Set();
    const take = (list, limit) => {
      let added = 0;
      for (const candidate of list) {
        if (picks.length >= budget || added >= limit) break;
        if (used.has(candidate.fp)) continue;
        picks.push(candidate);
        used.add(candidate.fp);
        added += 1;
      }
    };

    take(webFresh, Math.floor(budget * 0.5));
    take(healthyDue, Math.floor(budget * 0.3));
    take(retry, Math.floor(budget * 0.2));
    take(fresh, Math.floor(budget * 0.3));
    take(revive, Math.floor(budget * 0.05));
    take(webFresh, budget);
    take(fresh, budget);
    take(retry, budget);
    take(healthyDue, budget);

    return {
      picks,
      counts: {
        webFresh: webFresh.length,
        fresh: fresh.length,
        healthyDue: healthyDue.length,
        retry: retry.length,
        revive: revive.length,
      },
    };
  }

  recordResult(result, candidate) {
    const records = this.store.data.nodes;
    const now = Date.now();
    let record = records[result.fp];

    if (!record) {
      record = {
        fp: result.fp,
        tag: candidate.tag,
        profileId: candidate.profileId,
        profileRemark: candidate.profileRemark,
        type: candidate.type,
        transport: candidate.transport,
        firstSeenAt: now,
        lastTestAt: null,
        lastOkAt: null,
        lastMs: null,
        fails: 0,
        totalOk: 0,
        totalFail: 0,
        lastError: null,
        unsupported: false,
        unsupportedAt: null,
        outbound: null,
      };
      records[result.fp] = record;
    }

    record.tag = candidate.tag;
    record.profileId = candidate.profileId;
    record.profileRemark = candidate.profileRemark;
    record.type = candidate.type;
    record.transport = candidate.transport;
    record.lastTestAt = now;

    if (result.unsupported) {
      record.unsupported = true;
      record.unsupportedAt = now;
      record.lastError = cleanText(result.error, 300) || 'ناسازگار با موتور تست';
      record.outbound = null;
      record.lastMs = null;
      record.fails = 0;
      if (candidate.profileId === WEB_PROFILE_ID) {
        delete records[result.fp];
        this.web.markDead(result.fp);
      }
      return;
    }

    if (result.ok) {
      record.outbound = candidate.outbound;
      record.lastOkAt = now;
      record.lastMs = result.ms;
      record.fails = 0;
      record.totalOk = (record.totalOk || 0) + 1;
      record.unsupported = false;
      record.unsupportedAt = null;
      record.lastError = null;
      return;
    }

    record.lastMs = null;
    record.fails = (record.fails || 0) + 1;
    record.totalFail = (record.totalFail || 0) + 1;
    record.lastError = cleanText(result.error, 300) || 'اتصال برقرار نشد';

    if (record.fails >= this.store.data.settings.failuresToDrop) {
      record.outbound = null;
      if (record.profileId === WEB_PROFILE_ID) {
        delete records[result.fp];
        this.web.markDead(result.fp);
      }
    }
  }

  prune(scan) {
    const settings = this.store.data.settings;
    const now = Date.now();
    const source = new Set(scan.candidates.map((candidate) => candidate.fp));
    const records = this.store.data.nodes;

    for (const [fp, record] of Object.entries(records)) {
      if (source.has(fp)) continue;
      const healthy = !record.unsupported && isHealthy(record, settings, now);
      if (healthy && record.outbound) continue;
      const stale = now - (record.lastTestAt || record.firstSeenAt || now) > 7 * DAY;
      if (!record.outbound || stale) delete records[fp];
    }
  }

  async resolveThrottle() {
    if (!this.throttle) return null;
    try {
      const value = await this.throttle();
      if (!value || !Number.isInteger(value.concurrency) || value.concurrency < 1) return null;
      return value;
    } catch {
      return null;
    }
  }

  async runCycle(trigger = 'manual', options = {}) {
    if (this.runState.running) {
      return { started: false, reason: 'running' };
    }

    this.runState = {
      ...makeRunState(),
      running: true,
      phase: 'scan',
      trigger,
      startedAt: new Date().toISOString(),
    };

    const startedMs = Date.now();
    const settings = { ...this.store.data.settings };
    const throttle = await this.resolveThrottle();
    if (throttle) {
      settings.concurrency = Math.min(settings.concurrency, throttle.concurrency);
      this.runState.throttled = {
        concurrency: settings.concurrency,
        reason: cleanText(throttle.reason, 120) || null,
      };
    }
    let scan;
    let selection;
    let webRefresh = null;

    try {
      if (settings.webEnabled) {
        this.runState.phase = 'fetch';
        try {
          webRefresh = await this.web.refreshIfDue(settings, Boolean(options.forceWeb));
          this.runState.web = webRefresh;
        } catch (error) {
          webRefresh = { error: cleanText(error.message, 300) };
          this.runState.web = webRefresh;
        }
      }

      this.runState.phase = 'scan';
      scan = this.scanKaring(0);
      const webCandidates = this.web.candidates();
      if (webCandidates.length) {
        const known = new Set(scan.candidates.map((candidate) => candidate.fp));
        scan.candidates = scan.candidates.concat(webCandidates.filter((candidate) => !known.has(candidate.fp)));
        scan.profiles = scan.profiles.concat({
          id: WEB_PROFILE_ID,
          remark: WEB_PROFILE_REMARK,
          type: 'web',
          enabled: true,
          total: webCandidates.length,
          unique: webCandidates.length,
        });
        scan.stats = {
          ...scan.stats,
          webCandidates: webCandidates.length,
          webPool: Object.keys(this.store.data.web.pool).length,
        };
      }
      this.runState.phase = 'geo';
      try {
        const geo = await filterRussian(scan.candidates);
        if (geo.removed.length) {
          scan.candidates = geo.kept;
          for (const candidate of geo.removed) {
            if (candidate && candidate.fp && this.store.data.nodes[candidate.fp]) {
              delete this.store.data.nodes[candidate.fp];
            }
          }
          this.store.save();
          this.runState.geoRemoved = geo.removed.length;
          scan.stats = { ...scan.stats, geoRemoved: geo.removed.length };
        }
      } catch {}

      selection = this.selectCandidates(scan, settings);
    } catch (error) {
      const nowIso = new Date().toISOString();
      this.runState = {
        ...this.runState,
        running: false,
        phase: 'error',
        finishedAt: nowIso,
        error: cleanText(error.message, 300),
      };
      this.store.setLastRun({
        startedAt: this.runState.startedAt,
        finishedAt: nowIso,
        trigger,
        error: cleanText(error.message, 300),
        ok: 0,
        failed: 0,
        unsupported: 0,
        tested: 0,
        planned: 0,
        healthy: 0,
        output: 0,
        durationMs: Date.now() - startedMs,
        web: null,
      });
      this.store.addHistory({ finishedAt: nowIso, trigger, error: this.runState.error, tested: 0, ok: 0 });
      this.store.save();
      return { started: true, ok: false, error: this.runState.error };
    }

    this.runState.phase = selection.picks.length ? 'testing' : 'idle';
    this.runState.planned = selection.picks.length;

    let batchResult = { results: [], durationMs: 0, tested: 0 };
    try {
      if (selection.picks.length) {
        batchResult = await testCandidates(selection.picks, settings, {
          onResult: (result, candidate) => {
            this.recordResult(result, candidate);
            this.runState.tested += 1;
            if (result.unsupported) this.runState.unsupported += 1;
            else if (result.ok) this.runState.ok += 1;
            else this.runState.failed += 1;
          },
        });
      }
    } catch (error) {
      this.runState.error = cleanText(error.message, 300);
    }

    const finishedIso = new Date().toISOString();
    const healthy = healthyRecords(this.store).length;
    const output = buildSubscription(this.store).count;
    const summary = {
      startedAt: this.runState.startedAt,
      finishedAt: finishedIso,
      trigger,
      tested: batchResult.tested,
      ok: this.runState.ok,
      failed: this.runState.failed,
      unsupported: this.runState.unsupported,
      planned: this.runState.planned,
      healthy,
      output,
      geoRemoved: this.runState.geoRemoved,
      durationMs: Date.now() - startedMs,
      error: this.runState.error,
      source: scan.stats,
      web: webRefresh && !webRefresh.skipped
        ? {
          added: webRefresh.added || 0,
          refreshed: webRefresh.refreshed || 0,
          removedMissed: webRefresh.removedMissed || 0,
          pool: webRefresh.pool || 0,
          sourcesOk: webRefresh.sourcesOk || 0,
          sourcesFailed: webRefresh.sourcesFailed || 0,
          errors: (webRefresh.errors || []).slice(0, 3),
          error: webRefresh.error || null,
        }
        : null,
    };

    try {
      this.prune(scan);
    } catch {}
    this.store.setLastRun(summary);
    this.store.addHistory({
      finishedAt: finishedIso,
      trigger,
      tested: summary.tested,
      ok: summary.ok,
      failed: summary.failed,
      healthy,
      output,
      webAdded: summary.web ? summary.web.added : 0,
      durationMs: summary.durationMs,
      error: summary.error,
    });
    this.store.save();

    this.runState.running = false;
    this.runState.phase = this.runState.error ? 'error' : 'idle';
    this.runState.finishedAt = finishedIso;

    return { started: true, ok: !this.runState.error, summary };
  }

  schedule(delayMs) {
    if (!this.store.data.settings.autoRun) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.store.data.settings.autoRun) return;
      try {
        await this.runCycle('auto');
      } catch {}
      this.schedule(this.store.data.settings.cycleMinutes * 60_000);
    }, Math.max(1000, delayMs));
  }

  start() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    purgeRussianRecords(this.store).catch(() => {});
    if (this.store.data.settings.autoRun) this.schedule(15_000);
  }

  refreshAuto() {
    if (!this.store.data.settings.autoRun) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (!this.timer) this.schedule(5_000);
  }
}

module.exports = { Scheduler };
