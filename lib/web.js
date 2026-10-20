'use strict';

const { parseList } = require('./share');
const { cleanText } = require('./util');
const { NODE_TYPES } = require('./karing');

const DAY = 24 * 60 * 60 * 1000;
const WEB_PROFILE_ID = '__web__';
const WEB_PROFILE_REMARK = 'اینترنت (منابع عمومی)';

const DEFAULT_SOURCES = [
  {
    id: 'epodonios',
    label: 'Epodonios',
    url: 'https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt',
  },
  {
    id: 'mhdi-taheri',
    label: 'MhdiTaheri',
    url: 'https://raw.githubusercontent.com/MhdiTaheri/V2rayCollector/main/sub/mix',
  },
  {
    id: 'mahdibland-merge',
    label: 'mahdibland Merge',
    url: 'https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/sub/sub_merge.txt',
  },
  {
    id: 'mahdibland-ss',
    label: 'mahdibland Shadowsocks',
    url: 'https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/Eternity.txt',
  },
  {
    id: 'aliilapro',
    label: 'ALIILAPRO',
    url: 'https://raw.githubusercontent.com/ALIILAPRO/v2rayNG-Config/main/server.txt',
  },
  {
    id: 'ermaozi',
    label: 'ermaozi',
    url: 'https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt',
  },
  {
    id: 'pawdroid',
    label: 'Pawdroid',
    url: 'https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub',
  },
  {
    id: 'ripaojiedian',
    label: 'ripaojiedian',
    url: 'https://raw.githubusercontent.com/ripaojiedian/freenode/main/sub',
  },
  {
    id: 'kwinshadow',
    label: 'Kwinshadow',
    url: 'https://raw.githubusercontent.com/Kwinshadow/TelegramV2rayCollector/main/sublinks/mix.txt',
  },
  {
    id: 'nomorewalls',
    label: 'NoMoreWalls',
    url: 'https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.txt',
  },
  {
    id: 'freefq',
    label: 'freefq',
    url: 'https://raw.githubusercontent.com/freefq/free/master/v2',
  },
  {
    id: 'ts-sf',
    label: 'ts-sf',
    url: 'https://raw.githubusercontent.com/ts-sf/fly/main/v2',
  },
  {
    id: 'ermaozi01',
    label: 'ermaozi01',
    url: 'https://raw.githubusercontent.com/ermaozi01/free_clash_vpn/main/subscribe/v2ray.txt',
  },
];

const DEFAULT_ALLOWED_HOSTS = new Set(['raw.githubusercontent.com']);

function emptyStats() {
  return { fetchedBytes: 0, nodes: 0, byType: {}, unsupported: 0, invalid: 0, privateHost: 0 };
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('حجم پاسخ بیش از حد مجاز است');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('حجم پاسخ بیش از حد مجاز است');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

class WebManager {
  constructor(store, options = {}) {
    this.store = store;
    this.sources = options.sources || DEFAULT_SOURCES;
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
    this.allowedHosts = options.allowedHosts || DEFAULT_ALLOWED_HOSTS;
    this.requireHttps = options.requireHttps !== false;
    this.timeoutMs = options.timeoutMs || 25_000;
    this.maxBytes = options.maxBytes || 4 * 1024 * 1024;
    this.concurrency = options.concurrency || 3;
    this.deadTtlMs = options.deadTtlMs || 7 * DAY;
    this.releaseMisses = options.releaseMisses || 3;
    this.allowPrivateHosts = options.allowPrivateHosts === true;
  }

  get state() {
    return this.store.data.web;
  }

  enabled(settings = this.store.data.settings) {
    return Boolean(settings.webEnabled);
  }

  counts() {
    return {
      pool: Object.keys(this.state.pool || {}).length,
      dead: Object.keys(this.state.dead || {}).length,
      lastFetchAt: this.state.lastFetchAt || null,
      nextFetchAt: this.nextFetchAt(),
      lastError: this.state.lastError || null,
    };
  }

  nextFetchAt() {
    const settings = this.store.data.settings;
    if (!settings.webEnabled) return null;
    if (!this.state.lastFetchAt) return new Date().toISOString();
    const last = new Date(this.state.lastFetchAt).getTime();
    if (!Number.isFinite(last)) return new Date().toISOString();
    const interval = this.state.lastError
      ? Math.min(settings.webRefreshMinutes * 60_000, 60 * 60_000)
      : settings.webRefreshMinutes * 60_000;
    return new Date(last + interval).toISOString();
  }

  sourceStatus() {
    return this.sources.map((source) => {
      const info = this.state.sources[source.id] || {};
      return {
        id: source.id,
        label: source.label,
        url: source.url,
        lastFetchAt: info.lastFetchAt || null,
        status: info.status || 'never',
        nodes: info.nodes || 0,
        error: info.error || null,
      };
    });
  }

  candidates() {
    if (!this.enabled()) return [];
    const pool = this.state.pool || {};
    const records = this.store.data.nodes;
    const settings = this.store.data.settings;
    const now = Date.now();
    const list = [];

    for (const node of Object.values(pool)) {
      if (!node || !node.fp || !node.outbound) continue;
      if (!NODE_TYPES.has(node.outbound.type)) continue;
      const record = records[node.fp];
      if (record && record.unsupported) continue;
      if (record && (record.fails || 0) >= settings.failuresToDrop
        && now - (record.lastTestAt || 0) < settings.healthyTtlMinutes * 60_000) {
        continue;
      }
      list.push({
        fp: node.fp,
        tag: node.tag,
        profileId: WEB_PROFILE_ID,
        profileRemark: WEB_PROFILE_REMARK,
        type: node.type || node.outbound.type,
        transport: node.transport || (node.outbound.transport && node.outbound.transport.type) || 'tcp',
        outbound: node.outbound,
        sourceId: node.sourceId || null,
      });
    }
    return list;
  }

  validateSourceUrl(source) {
    let url;
    try { url = new URL(source.url); } catch { throw new Error('آدرس منبع معتبر نیست'); }
    if (this.requireHttps && url.protocol !== 'https:') throw new Error('منبع باید HTTPS باشد');
    if (!this.allowedHosts.has(url.hostname)) throw new Error('دامنه منبع مجاز نیست');
  }

  async fetchSource(source) {
    this.validateSourceUrl(source);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(source.url, {
        signal: controller.signal,
        redirect: 'follow',
        cache: 'no-store',
        headers: {
          Accept: 'text/plain, application/json, */*',
          'User-Agent': 'KaringNodeDoctor/1.1',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url) {
        let finalUrl;
        try { finalUrl = new URL(response.url); } catch { finalUrl = null; }
        if (finalUrl && (!this.allowedHosts.has(finalUrl.hostname)
          || (this.requireHttps && finalUrl.protocol !== 'https:'))) {
          throw new Error('منبع به دامنه غیرمجاز هدایت شد');
        }
      }
      const buffer = await readLimitedBody(response, this.maxBytes);
      return buffer.toString('utf8');
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('مهلت دریافت منبع تمام شد');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  mergeResults(results, settings) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const web = this.state;
    web.pool = web.pool || {};
    web.dead = web.dead || {};

    for (const [fp, deadAt] of Object.entries(web.dead)) {
      if (!Number.isFinite(Number(deadAt)) || now - Number(deadAt) > 30 * DAY) delete web.dead[fp];
    }

    const fetched = new Map();
    for (const result of results) {
      if (result.ok && result.nodes) {
        for (const node of result.nodes) {
          if (web.dead[node.fp] && now - Number(web.dead[node.fp]) < this.deadTtlMs) continue;
          if (!fetched.has(node.fp)) fetched.set(node.fp, { ...node, sourceId: result.source.id });
        }
      }
    }

    let added = 0;
    let refreshed = 0;
    for (const node of fetched.values()) {
      const existing = web.pool[node.fp];
      if (existing) {
        existing.lastSeenAt = nowIso;
        existing.missed = 0;
        existing.tag = node.tag;
        existing.outbound = node.outbound;
        refreshed += 1;
        continue;
      }
      if (Object.keys(web.pool).length >= settings.webMaxPool) continue;
      web.pool[node.fp] = {
        fp: node.fp,
        tag: node.tag,
        type: node.type,
        transport: node.transport,
        outbound: node.outbound,
        sourceId: node.sourceId,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        missed: 0,
      };
      added += 1;
    }

    let removedMissed = 0;
    const completeSourceIds = new Set(
      results.filter((result) => result.ok && result.complete).map((result) => result.source.id)
    );
    for (const [fp, node] of Object.entries(web.pool)) {
      if (fetched.has(fp)) continue;
      if (!completeSourceIds.has(node.sourceId)) continue;
      node.missed = (node.missed || 0) + 1;
      if (node.missed >= this.releaseMisses) {
        delete web.pool[fp];
        removedMissed += 1;
      }
    }

    web.lastFetchAt = nowIso;
    const failed = results.filter((result) => !result.ok);
    web.lastError = failed.length === results.length && failed.length
      ? failed.map((result) => `${result.source.label}: ${result.error}`).join(' • ').slice(0, 300)
      : null;

    for (const result of results) {
      web.sources[result.source.id] = {
        lastFetchAt: nowIso,
        status: result.ok ? 'ok' : 'error',
        nodes: result.ok && result.nodes ? result.nodes.length : 0,
        fetchedBytes: result.bytes || 0,
        byType: result.stats ? result.stats.byType : {},
        error: result.ok ? null : cleanText(result.error, 200),
      };
    }

    this.store.save();
    return { added, refreshed, removedMissed, pool: Object.keys(web.pool).length };
  }

  async refresh(settings = this.store.data.settings) {
    const startedAt = Date.now();
    const results = [];
    let index = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, this.sources.length) }, async () => {
      while (index < this.sources.length) {
        const source = this.sources[index];
        index += 1;
        try {
          const text = await this.fetchSource(source);
          const parsed = parseList(text, { allowPrivateHosts: this.allowPrivateHosts });
          const limit = settings.webMaxPerSource;
          let nodes = parsed.nodes;
          if (nodes.length > limit) {
            const offset = (Math.floor(Date.now() / DAY) * limit) % nodes.length;
            nodes = nodes.slice(offset).concat(nodes.slice(0, offset)).slice(0, limit);
          }
          results.push({
            source,
            ok: true,
            nodes,
            complete: parsed.nodes.length <= limit,
            stats: parsed.stats,
            bytes: Buffer.byteLength(text, 'utf8'),
          });
        } catch (error) {
          results.push({
            source,
            ok: false,
            nodes: [],
            stats: emptyStats(),
            bytes: 0,
            error: cleanText(error.message, 200) || 'دریافت منبع ناموفق بود',
          });
        }
      }
    });
    await Promise.all(workers);

    const summary = this.mergeResults(results, settings);
    const okSources = results.filter((result) => result.ok).length;
    return {
      ...summary,
      durationMs: Date.now() - startedAt,
      sourcesOk: okSources,
      sourcesFailed: results.length - okSources,
      errors: results.filter((result) => !result.ok).map((result) => `${result.source.label}: ${result.error}`),
    };
  }

  async refreshIfDue(settings = this.store.data.settings, force = false) {
    if (!settings.webEnabled) return { skipped: 'disabled' };
    if (!force) {
      const last = this.state.lastFetchAt ? new Date(this.state.lastFetchAt).getTime() : 0;
      const interval = this.state.lastError
        ? Math.min(settings.webRefreshMinutes * 60_000, 60 * 60_000)
        : settings.webRefreshMinutes * 60_000;
      if (Number.isFinite(last) && Date.now() - last < interval) {
        return { skipped: 'fresh', nextFetchAt: this.nextFetchAt() };
      }
    }
    return this.refresh(settings);
  }

  markDead(fp) {
    if (!fp) return;
    const web = this.state;
    web.pool = web.pool || {};
    web.dead = web.dead || {};
    delete web.pool[fp];
    web.dead[fp] = Date.now();
  }

  remove(fp) {
    const web = this.state;
    if (web.pool) delete web.pool[fp];
  }
}

module.exports = {
  WebManager,
  DEFAULT_SOURCES,
  WEB_PROFILE_ID,
  WEB_PROFILE_REMARK,
};
