'use strict';

const $ = (id) => document.getElementById(id);
const faNumber = new Intl.NumberFormat('fa-IR');
const relative = new Intl.RelativeTimeFormat('fa', { numeric: 'auto' });
const clockFormat = new Intl.DateTimeFormat('fa-IR-u-ca-gregory', { hour: '2-digit', minute: '2-digit' });
const shortDateFormat = new Intl.DateTimeFormat('fa-IR-u-ca-gregory', { month: 'short', day: 'numeric' });

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let lastStatus = null;
let healthyNodes = [];
let failingNodes = [];
let historyRows = [];
let settingsDirty = false;
let wasRunning = false;
let autostartBusy = false;
let nodesSignature = '';
let profileSignature = '';
let statsSignature = '';
let historySignature = '';
let webSignature = '';
let syncSignature = '';
let webToggleBusy = false;
let toastTimer = null;

function fmt(value) {
  const number = Number(value);
  return faNumber.format(Number.isFinite(number) ? number : 0);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function relTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'همین حالا';
  if (abs < HOUR) return relative.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return relative.format(Math.round(diff / HOUR), 'hour');
  return relative.format(Math.round(diff / DAY), 'day');
}

function fmtWhen(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? clockFormat.format(date) : `${shortDateFormat.format(date)} ${clockFormat.format(date)}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return '—';
  const seconds = Math.round(Number(ms) / 1000);
  if (seconds < 60) return `${fmt(seconds)} ثانیه`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${fmt(minutes)} دقیقه و ${fmt(rest)} ثانیه` : `${fmt(minutes)} دقیقه`;
}

function toast(message, isError = false) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('error', Boolean(isError));
  box.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3400);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    throw new Error((data && data.error) || 'ارتباط با برنامه برقرار نشد.');
  }
  return data;
}

/* ---------- status ---------- */

function renderStatus(status) {
  lastStatus = status;
  const run = status.run || {};
  const appReady = Boolean(status.app && status.app.coreReady);
  const karingError = status.karing && status.karing.error;
  const lastRun = status.lastRun;

  let pillClass = 'pill pill-ready';
  let pillText = 'آماده';
  if (run.running) {
    pillClass = 'pill pill-running';
    pillText = 'در حال تست';
  } else if (!appReady) {
    pillClass = 'pill pill-error';
    pillText = 'موتور تست پیدا نشد';
  } else if (karingError) {
    pillClass = 'pill pill-error';
    pillText = 'Karing در دسترس نیست';
  } else if ((run.phase === 'error') || (lastRun && lastRun.error)) {
    pillClass = 'pill pill-error';
    pillText = 'خطای آخرین دوره';
  }
  $('statusPill').className = pillClass;
  $('statusPillText').textContent = pillText;

  const runBtn = $('runBtn');
  runBtn.disabled = Boolean(run.running) || !appReady || Boolean(karingError);
  $('runBtnText').textContent = run.running ? 'در حال تست…' : 'اجرای تست';

  const planned = Number(run.planned) || 0;
  const tested = Number(run.tested) || 0;
  let title;
  let desc;
  let percent = 0;

  if (run.running) {
    if (run.phase === 'fetch') {
      title = 'در حال دریافت منابع اینترنتی';
      desc = 'کانفیگ‌های تازه از مخازن عمومی دریافت و برای تست آماده می‌شوند.';
      percent = 2;
    } else if (run.phase === 'scan') {
      title = 'در حال خواندن کانفیگ Karing';
      desc = 'نودهای فعلی بررسی و کاندیدهای مناسب دوره بعدی انتخاب می‌شوند.';
      percent = 4;
    } else if (run.phase === 'geo') {
      title = 'در حال حذف نودهای روسیه';
      desc = 'موقعیت سرورها بررسی می‌شود تا نودهای روسی از تست و ساب‌سکریپشن حذف شوند.';
      percent = 6;
    } else {
      title = 'در حال تست نودها';
      desc = planned
        ? `${fmt(tested)} از ${fmt(planned)} نود تست شده است؛ نتیجه‌ها زنده ذخیره می‌شوند.`
        : 'در حال آماده‌سازی بسته‌های تست…';
      percent = planned ? Math.min(99, Math.round((tested / planned) * 100)) : 8;
    }
  } else if (karingError) {
    title = 'Karing در دسترس نیست';
    desc = karingError;
    percent = 0;
  } else if (!appReady) {
    title = 'موتور تست پیدا نشد';
    desc = 'فایل core\\sing-box.exe را بررسی کنید.';
    percent = 0;
  } else if (run.phase === 'error') {
    title = 'خطا در اجرای دوره';
    desc = run.error || 'جزئیات در گزارش آخرین اجرا ثبت شده است.';
    percent = 100;
  } else if (lastRun) {
    title = 'آخرین دوره کامل شد';
    desc = lastRun.error
      ? `دوره با خطا تمام شد: ${lastRun.error}`
      : 'نودهای سالم به‌روز شده‌اند و ساب‌سکریپشن آماده دریافت است.';
    percent = 100;
  } else {
    title = 'آماده شروع';
    desc = 'دکمه «اجرای تست» را بزنید یا منتظر اجرای خودکار بمانید.';
  }

  $('phaseTitle').textContent = title;
  $('phaseDesc').textContent = desc;
  $('progressFill').style.width = `${percent}%`;
  $('progressBar').setAttribute('aria-valuenow', String(percent));
  $('progressBar').classList.toggle('is-running', Boolean(run.running));
  $('progressLabel').textContent = run.running
    ? (planned ? `${fmt(tested)} از ${fmt(planned)}` : 'آماده‌سازی…')
    : (lastRun ? 'تمام شده' : 'در انتظار شروع');
  $('progressPercent').textContent = `${fmt(percent)}٪`;

  $('runBadge').textContent = run.running ? 'در حال اجرا' : (run.phase === 'error' ? 'خطا' : 'آماده');
  $('runBadge').className = `soft-badge${run.running ? ' warn' : (run.phase === 'error' ? ' danger' : '')}`;

  const chips = [];
  if (run.trigger) {
    chips.push(`<span class="chip ok"><b>${fmt(run.ok)}</b> سالم</span>`);
    chips.push(`<span class="chip bad"><b>${fmt(run.failed)}</b> ناموفق</span>`);
    chips.push(`<span class="chip warn"><b>${fmt(run.unsupported)}</b> ناسازگار</span>`);
    if (run.web && run.web.added) {
      chips.push(`<span class="chip ok">+${fmt(run.web.added)} از اینترنت</span>`);
    }
    if (run.geoRemoved) {
      chips.push(`<span class="chip warn"><b>${fmt(run.geoRemoved)}</b> روسیه حذف شد</span>`);
    }
    chips.push(`<span class="chip">اجرای ${run.trigger === 'auto' ? 'خودکار' : 'دستی'}</span>`);
  }
  $('runStats').innerHTML = chips.join('');

  if (lastRun) {
    const when = relTime(lastRun.finishedAt);
    const triggerText = lastRun.trigger === 'auto' ? 'خودکار' : 'دستی';
    const geoText = lastRun.geoRemoved ? ` • ${fmt(lastRun.geoRemoved)} روسیه حذف شد` : '';
    $('lastRunLine').textContent = lastRun.error
      ? `آخرین اجرا ${when} با خطا: ${lastRun.error}`
      : `آخرین اجرا ${when} • ${fmt(lastRun.tested)} تست • ${formatDuration(lastRun.durationMs)} • ${triggerText}${geoText}`;
  } else {
    $('lastRunLine').textContent = 'هنوز دوره‌ای اجرا نشده است.';
  }

  const url = `${location.origin}${status.subscription.path}`;
  if ($('subUrl').value !== url) $('subUrl').value = url;
  $('subCount').textContent = fmt(status.subscription.output);
  $('subHealthy').textContent = fmt(status.subscription.healthy);
  $('subBadge').textContent = `${fmt(status.subscription.output)} نود`;

  renderKaringSync(status);
  renderV2ray(status);
  renderTun(status);
  renderStats(status);
  renderWeb(status);
  populateSettings(status.settings);
  renderAutostart(status.autostart);

  if (wasRunning && !run.running) {
    refreshResults();
    refreshProfiles();
  }
  wasRunning = Boolean(run.running);
}

function renderKaringSync(status) {
  const box = $('karingSync');
  const sync = status.karingSync;
  if (!sync) {
    box.hidden = true;
    return;
  }

  const expected = Number(sync.expected) || 0;
  const nodes = Number(sync.nodes) || 0;
  const signature = JSON.stringify([sync, Math.round(Date.now() / MINUTE)]);
  if (signature === syncSignature) return;
  syncSignature = signature;
  box.hidden = false;

  let kind = 'warn';
  let title;
  let desc;
  let badge;

  if (!sync.found) {
    kind = 'warn';
    title = 'پروفایل در Karing پیدا نشد';
    desc = 'آدرس ساب‌سکریپشن را در بخش My Profiles کادرینگ اضافه کنید.';
    badge = 'اضافه نشده';
  } else if (!sync.enabled) {
    kind = 'warn';
    title = 'پروفایل در Karing خاموش است';
    desc = 'پروفایل «فقط سالم‌ها» را در Karing روشن کنید تا نودها دیده شوند.';
    badge = 'خاموش';
  } else if (expected === 0) {
    kind = 'warn';
    title = 'هنوز نود سالمی آماده نیست';
    desc = 'پس از اولین دوره تست موفق، ساب‌سکریپشن پر می‌شود.';
    badge = 'در انتظار تست';
  } else if (nodes < expected) {
    kind = 'danger';
    title = 'Karing عقب‌تر از ساب‌سکریپشن است';
    desc = `داخل Karing ${fmt(nodes)} نود است، اما ${fmt(expected)} نود سالم آماده ارسال است.`;
    badge = 'نیاز به رفرش';
  } else {
    kind = 'ok';
    title = 'Karing با ساب‌سکریپشن همگام است';
    desc = `داخل Karing ${fmt(nodes)} نود از ${fmt(expected)} نود سالم ساب را دارد.`;
    badge = 'به‌روز';
  }

  const meta = [];
  if (sync.found) {
    meta.push(`آخرین رفرش: ${sync.updateAt ? `${relTime(new Date(sync.updateAt).toISOString())} • ${fmtWhen(sync.updateAt)}` : '—'}`);
    if (sync.nextAt) meta.push(`رفرش خودکار بعدی: ${fmtWhen(sync.nextAt)}`);
    if (sync.refreshMinutes) {
      const hours = sync.refreshMinutes / 60;
      meta.push(`بازه به‌روزرسانی: هر ${hours >= 1 ? `${fmt(Number(hours.toFixed(1)))} ساعت` : `${fmt(sync.refreshMinutes)} دقیقه`}`);
    }
  }

  box.className = `sync-box is-${kind}`;
  $('syncTitle').textContent = title;
  $('syncDesc').textContent = desc;
  $('syncBadge').textContent = badge;
  $('syncBadge').className = `soft-badge ${kind === 'ok' ? 'accent' : (kind === 'danger' ? 'danger' : 'warn')}`;
  $('syncMeta').innerHTML = meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('');
}

let v2SkippedSignature = '';

const SKIPPED_LABELS = {
  hysteria: 'hysteria v1',
  tuic: 'tuic',
  anytls: 'anytls',
  shadowtls: 'shadowtls',
  wireguard: 'wireguard',
};

function renderV2ray(status) {
  const info = status.subscription && status.subscription.v2ray;
  if (!info) return;
  const url = `${location.origin}${info.path}`;
  if ($('v2Url').value !== url) $('v2Url').value = url;
  $('v2Count').textContent = fmt(info.count);
  $('v2Skipped').textContent = fmt(info.skippedCount || 0);
  $('v2Badge').textContent = `${fmt(info.count)} لینک`;

  const skipped = Object.entries(info.skipped || {});
  const row = $('v2SkippedRow');
  const signature = skipped.map(([type, count]) => `${type}:${count}`).join(',');
  if (v2SkippedSignature !== signature) {
    v2SkippedSignature = signature;
    row.innerHTML = skipped.map(([type, count]) => `<span class="chip warn"><b>${fmt(count)}</b> ${escapeHtml(SKIPPED_LABELS[type] || type)}</span>`).join('');
  }
  row.hidden = !skipped.length;
}

let tunBusy = false;
let tunSignature = '';

function renderTun(status) {
  const tun = status.karingTun;
  const badge = $('tunBadge');
  const button = $('tunBtn');
  const note = $('tunNote');
  const running = status.karingRunning;

  if (!tun || !tun.available) {
    if (tunSignature !== 'missing') {
      tunSignature = 'missing';
      badge.textContent = 'نامشخص';
      badge.className = 'soft-badge warn';
      $('tunDesc').textContent = (tun && tun.error) || 'تنظیمات Karing در دسترس نیست.';
      $('tunMeta').innerHTML = '';
      button.disabled = true;
      button.textContent = 'تنظیمات Karing پیدا نشد';
      note.hidden = true;
    }
    return;
  }

  const enabled = Boolean(tun.enable);
  const signature = JSON.stringify([enabled, tun.stack, tun.autoRoute, tun.strictRoute, tun.hijackDns, tun.mtu, tun.proxyAll, running]);
  if (tunSignature === signature) return;
  tunSignature = signature;

  badge.textContent = enabled ? 'روشن' : 'خاموش';
  badge.className = `soft-badge ${enabled ? 'accent' : 'warn'}`;
  $('tunDesc').textContent = enabled
    ? 'حالت TUN در تنظیمات Karing روشن است؛ ترافیک کل سیستم ازVPN عبور می‌کند.'
    : 'حالت TUN خاموش است. با روشن کردن آن، مرورگرها و اپ‌های هوش مصنوعی هم (بدون تنظیم پراکسی دستی) از مسیر عبور می‌کنند.';

  const meta = [
    `پشته شبکه: ${tun.stack || 'mixed'}`,
    `مسیردهی خودکار: ${tun.autoRoute ? 'روشن' : 'خاموش'}`,
    `مسیردهی سخت: ${tun.strictRoute ? 'روشن' : 'خاموش'}`,
    `ربط DNS: ${tun.hijackDns ? 'روشن' : 'خاموش'}`,
  ];
  if (tun.mtu) meta.push(`MTU: ${fmt(tun.mtu)}`);
  $('tunMeta').innerHTML = meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('');

  if (!tunBusy) {
    button.disabled = false;
    button.textContent = enabled ? 'خاموش کردن TUN' : 'روشن کردن TUN';
  }

  if (running === true) {
    note.hidden = false;
    note.textContent = enabled
      ? 'Karing الان اجراست. برای اینکه TUN واقعاً فعال شود، آن را کامل ببندید (راست‌کلیک روی آیکون کنار ساعت → Quit) و دوباره باز کنید و متصل شوید.'
      : 'Karing الان اجراست؛ اگر پیش‌تر تنظیم را تغییر داده‌اید، برای دیدن وضعیت واقعی آن را ببندید و باز کنید.';
  } else if (running === false) {
    note.hidden = false;
    note.textContent = enabled
      ? 'Karing بسته است؛ تنظیم ذخیره شده و با اجرای بعدی و اتصال، TUN فعال می‌شود.'
      : 'Karing بسته است؛ می‌توانید بدون نگرانی از بازنویسی تنظیم را روشن کنید.';
  } else {
    note.hidden = true;
  }
}

function renderStats(status) {
  const counts = status.counts || {};
  const karingStats = (status.karing && status.karing.stats) || null;
  const settings = status.settings || {};
  const web = status.web || {};
  const webPool = Number(web.pool) || 0;
  const signature = JSON.stringify([counts, karingStats, settings.maxWorkingNodes, webPool, web.enabled]);
  if (signature === statsSignature) return;
  statsSignature = signature;

  const cards = [
    {
      label: 'نود سالم',
      value: fmt(counts.healthy),
      sub: 'تأییدشده و قابل استفاده',
      tone: 'accent',
    },
    {
      label: 'در ساب‌سکریپشن',
      value: fmt(counts.output),
      sub: `سقف تنظیمات: ${fmt(settings.maxWorkingNodes)}`,
      tone: 'accent',
    },
    {
      label: 'تست‌شده',
      value: fmt(counts.tested),
      sub: 'رکورد ذخیره‌شده در برنامه',
      tone: 'info',
    },
    {
      label: 'ناموفق',
      value: fmt(counts.failing),
      sub: 'در آستانه حذف یا تأیید مجدد',
      tone: 'danger',
    },
    {
      label: 'ناسازگار',
      value: fmt(counts.unsupported),
      sub: 'کانفیگ نامعتبر برای موتور تست',
      tone: 'warn',
    },
    {
      label: 'نودهای منبع',
      value: karingStats ? fmt(karingStats.unique + webPool) : fmt(webPool),
      sub: karingStats
        ? `Karing: ${fmt(karingStats.unique)} • اینترنت: ${fmt(webPool)}`
        : `اینترنت: ${fmt(webPool)}`,
      title: karingStats
        ? `${fmt(karingStats.duplicates)} نود تکراری ادغام شد • ${fmt(karingStats.xhttp)} نود xhttp رد شد • ${fmt(webPool)} کاندید اینترنتی`
        : `${fmt(webPool)} کاندید اینترنتی`,
      tone: '',
    },
  ];

  $('statsGrid').innerHTML = cards.map((card) => `
    <article class="stat-card ${card.tone}">
      <div class="stat-label">${card.label}</div>
      <div class="stat-value">${card.value}</div>
      <div class="stat-sub" title="${escapeHtml(card.title || card.sub)}">${escapeHtml(card.sub)}</div>
    </article>
  `).join('');
}

/* ---------- settings ---------- */

function populateSettings(settings, force = false) {
  const form = $('settingsForm');
  if (!settings) return;
  if (!force && (settingsDirty || form.contains(document.activeElement))) return;

  $('setTestUrl').value = settings.testUrl || '';
  $('setTimeout').value = Math.round((settings.timeoutMs || 8000) / 1000);
  $('setConcurrency').value = settings.concurrency;
  $('setMaxTests').value = settings.maxTestsPerCycle;
  $('setMaxWorking').value = settings.maxWorkingNodes;
  $('setCycle').value = settings.cycleMinutes;
  $('setFails').value = settings.failuresToDrop;
  $('setTtl').value = Number((settings.healthyTtlMinutes / 60).toFixed(1));
  $('setWebRefreshHours').value = Math.round((settings.webRefreshMinutes || 1440) / 60);
  $('setWebMaxPerSource').value = settings.webMaxPerSource;
  $('setWebMaxPool').value = settings.webMaxPool;
  $('setAutoRun').checked = Boolean(settings.autoRun);
}

$('settingsForm').addEventListener('input', () => { settingsDirty = true; });

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = $('settingsForm');
  if (!form.reportValidity()) return;

  const payload = {
    testUrl: $('setTestUrl').value.trim(),
    timeoutMs: Number($('setTimeout').value) * 1000,
    concurrency: Number($('setConcurrency').value),
    maxTestsPerCycle: Number($('setMaxTests').value),
    maxWorkingNodes: Number($('setMaxWorking').value),
    cycleMinutes: Number($('setCycle').value),
    failuresToDrop: Number($('setFails').value),
    healthyTtlMinutes: Math.round(Number($('setTtl').value) * 60),
    webRefreshMinutes: Math.round(Number($('setWebRefreshHours').value) * 60),
    webMaxPerSource: Number($('setWebMaxPerSource').value),
    webMaxPool: Number($('setWebMaxPool').value),
    autoRun: $('setAutoRun').checked,
  };

  const button = $('saveSettingsBtn');
  button.disabled = true;
  button.textContent = 'در حال ذخیره…';
  try {
    const result = await api('/api/settings', { method: 'POST', body: JSON.stringify({ settings: payload }) });
    settingsDirty = false;
    if (lastStatus) lastStatus.settings = result.settings;
    populateSettings(result.settings, true);
    statsSignature = '';
    toast('تنظیمات ذخیره شد.');
    refreshStatus();
    refreshProfiles();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'ذخیره تنظیمات';
  }
});

/* ---------- internet sources ---------- */

function renderWeb(status) {
  const web = status.web || {};
  const counts = status.counts || {};
  const sources = Array.isArray(web.sources) ? web.sources : [];
  const pool = Number(web.pool) || 0;
  const appReady = Boolean(status.app && status.app.coreReady);
  const running = Boolean(status.run && status.run.running);
  const signature = JSON.stringify([
    web.enabled, pool, counts.webHealthy, web.lastFetchAt, web.nextFetchAt, sources, running, appReady,
  ]);
  if (signature === webSignature) return;
  webSignature = signature;

  $('webBadge').textContent = web.enabled ? `${fmt(pool)} کاندید` : 'خاموش';
  $('webBadge').className = `soft-badge ${web.enabled ? 'accent' : 'warn'}`;
  $('webLastFetch').textContent = web.lastFetchAt ? relTime(web.lastFetchAt) : 'هنوز انجام نشده';
  $('webNextFetch').textContent = web.enabled
    ? (web.nextFetchAt ? relTime(web.nextFetchAt) : '—')
    : 'خاموش';
  $('webPoolCount').textContent = fmt(pool);
  $('webHealthyCount').textContent = fmt(counts.webHealthy || 0);
  $('webEnabledToggle').checked = Boolean(web.enabled);
  $('webEnabledToggle').disabled = webToggleBusy;
  $('webRefreshBtn').disabled = running || !web.enabled || !appReady;

  const okCount = sources.filter((source) => source.status === 'ok').length;
  $('webSourceOk').textContent = fmt(okCount);
  $('webSourceTotal').textContent = fmt(sources.length);

  $('webSourcesList').innerHTML = sources.map((source) => {
    const statusClass = source.status === 'ok' ? 'is-ok' : (source.status === 'error' ? 'is-error' : '');
    const meta = source.status === 'ok'
      ? `${fmt(source.nodes)} کانفیگ • ${relTime(source.lastFetchAt)}`
      : (source.status === 'error' ? 'آخرین دریافت ناموفق' : 'هنوز دریافت نشده');
    return `
      <div class="web-source ${statusClass}">
        <span class="name">${escapeHtml(source.label)}</span>
        <span class="meta">${meta}</span>
        ${source.error ? `<span class="err" title="${escapeHtml(source.error)}">${escapeHtml(source.error)}</span>` : ''}
      </div>
    `;
  }).join('');
}

$('webEnabledToggle').addEventListener('change', async (event) => {
  const toggle = event.target;
  webToggleBusy = true;
  toggle.disabled = true;
  try {
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ settings: { webEnabled: toggle.checked } }),
    });
    if (lastStatus) lastStatus.settings = result.settings;
    webSignature = '';
    statsSignature = '';
    toast(toggle.checked
      ? 'دریافت خودکار روزانه فعال شد.'
      : 'دریافت اینترنتی خاموش شد؛ نودهای اینترنتی از ساب حذف شدند.');
    await refreshStatus();
  } catch (error) {
    toggle.checked = !toggle.checked;
    toast(error.message, true);
  } finally {
    webToggleBusy = false;
    toggle.disabled = false;
  }
});

$('webRefreshBtn').addEventListener('click', async () => {
  const button = $('webRefreshBtn');
  button.disabled = true;
  try {
    const result = await api('/api/web/refresh', { method: 'POST', body: '{}' });
    toast('دریافت منابع اینترنتی و تست آغاز شد.');
    if (lastStatus) {
      lastStatus.run = result.run;
      renderStatus(lastStatus);
    }
  } catch (error) {
    toast(error.message, true);
    await refreshStatus();
  } finally {
    const running = Boolean(lastStatus && lastStatus.run && lastStatus.run.running);
    const enabled = Boolean(lastStatus && lastStatus.web && lastStatus.web.enabled);
    button.disabled = running || !enabled;
  }
});

/* ---------- profiles ---------- */

function renderProfiles(data) {
  const profiles = (data && data.profiles) || [];
  const signature = JSON.stringify(profiles.map((p) => [p.id, p.enabled, p.healthy, p.unique]));
  if (signature === profileSignature) return;
  profileSignature = signature;

  const container = $('profilesList');
  if (!profiles.length) {
    container.innerHTML = '<p class="muted small">پروفایلی در Karing پیدا نشد.</p>';
    return;
  }

  container.innerHTML = profiles.map((profile) => `
    <label class="profile-row ${profile.enabled ? '' : 'is-off'}">
      <input type="checkbox" data-profile-id="${escapeHtml(profile.id)}" ${profile.enabled ? 'checked' : ''} />
      <span class="profile-main">
        <span class="profile-name" title="${escapeHtml(profile.remark)}">${escapeHtml(profile.remark)}</span>
        <span class="profile-meta">${fmt(profile.unique)} نود یکتا • <b>${fmt(profile.healthy)}</b> سالم</span>
      </span>
    </label>
  `).join('');
}

$('profilesList').addEventListener('change', async (event) => {
  const input = event.target.closest('input[data-profile-id]');
  if (!input || !lastStatus) return;
  const id = input.getAttribute('data-profile-id');
  const map = { ...(lastStatus.settings.includeProfiles || {}) };
  if (input.checked) delete map[id];
  else map[id] = false;

  input.disabled = true;
  try {
    const result = await api('/api/settings', { method: 'POST', body: JSON.stringify({ settings: { includeProfiles: map } }) });
    lastStatus.settings = result.settings;
    profileSignature = '';
    toast(input.checked ? 'پروفایل فعال شد.' : 'پروفایل از دوره بعدی غیرفعال شد.');
    await refreshProfiles();
    await refreshStatus();
  } catch (error) {
    input.checked = !input.checked;
    toast(error.message, true);
  } finally {
    input.disabled = false;
  }
});

async function refreshProfiles() {
  try {
    const data = await api('/api/profiles');
    renderProfiles(data);
  } catch {}
}

/* ---------- nodes ---------- */

function latencyClass(ms) {
  if (!Number.isFinite(Number(ms))) return 'slow';
  if (ms < 700) return 'fast';
  if (ms < 1800) return 'mid';
  return 'slow';
}

function renderNodes() {
  const query = $('nodeSearch').value.trim().toLowerCase();
  const filtered = query
    ? healthyNodes.filter((node) => `${node.tag} ${node.profileRemark}`.toLowerCase().includes(query))
    : healthyNodes;

  const signature = JSON.stringify([
    query,
    filtered.map((node) => [node.tag, node.lastMs, node.lastOkAt]),
  ]);
  if (signature === nodesSignature) return;
  nodesSignature = signature;

  $('nodeCount').textContent = query
    ? `${fmt(filtered.length)} از ${fmt(healthyNodes.length)}`
    : fmt(healthyNodes.length);

  const body = $('nodesBody');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${query ? 'نودی با این جستجو پیدا نشد.' : 'هنوز نودی تأیید نشده است. اولین دوره تست را اجرا کنید.'}</td></tr>`;
    return;
  }

  body.innerHTML = filtered.map((node) => {
    const proto = node.transport && node.transport !== 'tcp'
      ? `${node.type} · ${node.transport}`
      : node.type;
    const latency = Number.isFinite(Number(node.lastMs))
      ? `<span class="latency ${latencyClass(node.lastMs)}">${fmt(node.lastMs)} ms</span>`
      : '<span class="verified">—</span>';
    return `
      <tr>
        <td>
          <div class="node-name">
            <span class="node-dot"></span>
            <span class="node-tag" title="${escapeHtml(node.tag)}">${escapeHtml(node.tag)}</span>
          </div>
        </td>
        <td><span class="proto">${escapeHtml(proto)}</span></td>
        <td class="profile-cell" title="${escapeHtml(node.profileRemark)}">${escapeHtml(node.profileRemark)}</td>
        <td>${latency}</td>
        <td class="verified">${relTime(node.lastOkAt)}</td>
      </tr>
    `;
  }).join('');
}

$('nodeSearch').addEventListener('input', renderNodes);

/* ---------- failures / history ---------- */

function renderFailures(counts) {
  const badge = $('failuresBadge');
  badge.textContent = fmt((counts && counts.failing) || failingNodes.length);

  const container = $('failuresList');
  if (!failingNodes.length) {
    container.innerHTML = '<p class="muted small">در حال حاضر نود ناموفقی ثبت نشده است.</p>';
    return;
  }

  container.innerHTML = failingNodes.map((node) => `
    <div class="failure-row">
      <span class="name" title="${escapeHtml(node.tag)}">${escapeHtml(node.tag)}</span>
      <span class="error" title="${escapeHtml(node.lastError || '')}">${escapeHtml(node.lastError || 'بدون جزئیات')}</span>
      <span class="fails">${fmt(node.fails)} خطا • ${relTime(node.lastTestAt)}</span>
    </div>
  `).join('');
}

function renderHistory() {
  const signature = JSON.stringify(historyRows);
  if (signature === historySignature) return;
  historySignature = signature;

  const container = $('historyList');
  if (!historyRows.length) {
    container.innerHTML = '<p class="muted small">هنوز دوره‌ای ثبت نشده است.</p>';
    return;
  }

  container.innerHTML = historyRows.map((row) => `
    <div class="history-row ${row.error ? 'is-error' : ''}">
      <span class="when">${relTime(row.finishedAt)}</span>
      <span class="what">
        <b>${fmt(row.tested)}</b> تست • <b>${fmt(row.healthy)}</b> سالم${row.webAdded ? ` • <b>${fmt(row.webAdded)}</b> از اینترنت` : ''} • ${formatDuration(row.durationMs)}
      </span>
    </div>
  `).join('');
}

async function refreshResults() {
  try {
    const data = await api('/api/results');
    healthyNodes = data.healthy || [];
    failingNodes = data.failing || [];
    historyRows = data.history || [];
    nodesSignature = '';
    renderNodes();
    renderFailures(data.counts);
    renderHistory();
  } catch {}
}

/* ---------- autostart ---------- */

function renderAutostart(info) {
  const card = $('autostartCard');
  if (!info || !info.supported) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  if (!autostartBusy) $('autostartToggle').checked = Boolean(info.enabled);
}

$('autostartToggle').addEventListener('change', async (event) => {
  const toggle = event.target;
  autostartBusy = true;
  toggle.disabled = true;
  try {
    const result = await api('/api/autostart', {
      method: 'POST',
      body: JSON.stringify({ enabled: toggle.checked }),
    });
    toast(result.enabled ? 'اجرای خودکار با ویندوز فعال شد.' : 'اجرای خودکار با ویندوز غیرفعال شد.');
  } catch (error) {
    toggle.checked = !toggle.checked;
    toast(error.message, true);
  } finally {
    autostartBusy = false;
    toggle.disabled = false;
  }
});

/* ---------- actions ---------- */

$('runBtn').addEventListener('click', async () => {
  const button = $('runBtn');
  button.disabled = true;
  $('runBtnText').textContent = 'در حال شروع…';
  try {
    const result = await api('/api/run', { method: 'POST', body: '{}' });
    toast('دوره تست آغاز شد.');
    if (lastStatus) {
      lastStatus.run = result.run;
      renderStatus(lastStatus);
    }
    if (window.KND_DEBUG) console.log(result);
  } catch (error) {
    toast(error.message, true);
    await refreshStatus();
  }
});

$('copyBtn').addEventListener('click', async () => {
  const input = $('subUrl');
  try {
    await navigator.clipboard.writeText(input.value);
    toast('آدرس ساب‌سکریپشن کپی شد.');
  } catch {
    input.select();
    try {
      document.execCommand('copy');
      toast('آدرس ساب‌سکریپشن کپی شد.');
    } catch {
      toast('کپی خودکار ممکن نشد؛ آدرس را دستی انتخاب کنید.', true);
    }
  }
});

$('copyV2Btn').addEventListener('click', async () => {
  const input = $('v2Url');
  try {
    await navigator.clipboard.writeText(input.value);
    toast('آدرس لینک‌های v2ray کپی شد.');
  } catch {
    input.select();
    try {
      document.execCommand('copy');
      toast('آدرس لینک‌های v2ray کپی شد.');
    } catch {
      toast('کپی خودکار ممکن نشد؛ آدرس را دستی انتخاب کنید.', true);
    }
  }
});

$('tunBtn').addEventListener('click', async () => {
  const button = $('tunBtn');
  const target = !(lastStatus && lastStatus.karingTun && lastStatus.karingTun.enable);
  tunBusy = true;
  button.disabled = true;
  button.textContent = 'در حال ذخیره…';
  try {
    const result = await api('/api/karing/tun', {
      method: 'POST',
      body: JSON.stringify({ enable: target }),
    });
    tunSignature = '';
    toast(target
      ? `حالت TUN روشن شد. ${result.note || ''}`
      : `حالت TUN خاموش شد. ${result.note || ''}`);
    await refreshStatus(false);
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = target ? 'روشن کردن TUN' : 'خاموش کردن TUN';
  } finally {
    tunBusy = false;
  }
});

/* ---------- polling ---------- */

let statusBusy = false;

async function refreshStatus(showError = false) {
  if (statusBusy) return;
  statusBusy = true;
  try {
    const status = await api('/api/status');
    renderStatus(status);
  } catch (error) {
    $('statusPill').className = 'pill pill-error';
    $('statusPillText').textContent = 'ارتباط با برنامه قطع شد';
    $('runBtn').disabled = true;
    if (showError) toast(error.message, true);
  } finally {
    statusBusy = false;
  }
}

(async function init() {
  await refreshStatus(true);
  await Promise.all([refreshResults(), refreshProfiles()]);
  setInterval(() => refreshStatus(false), 2500);
  setInterval(() => { if (!document.hidden) refreshResults(); }, 12_000);
  setInterval(() => { if (!document.hidden) refreshProfiles(); }, 30_000);
})();
