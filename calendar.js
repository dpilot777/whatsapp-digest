// Calendar watch: alert on Telegram 24h before any "XCM" event on the iCloud
// calendar "Dim". Reads a public .ics subscription URL (CALENDAR_ICS_URL);
// stays disabled if that env var is absent. Independent of the WhatsApp digest.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ical = require('node-ical');
const cron = require('node-cron');

const RAW_URL = process.env.CALENDAR_ICS_URL || '';
const ICS_URL = RAW_URL.replace(/^webcal:\/\//i, 'https://'); // accept webcal:// too
const TZ = 'Europe/Paris';
const ALERT_LEAD_MS = 24 * 3600 * 1000; // H-24
const WINDOW_MS = 26 * 3600 * 1000; // how far ahead to expand recurring events
const ALL_DAY_LEAD_MS = 15 * 3600 * 1000; // all-day → day before ~09:00 local
const STATE_FILE = path.join(__dirname, 'alerted_events.json');
const PRUNE_MS = 30 * 24 * 3600 * 1000;

// ── Pure helpers (exported for tests) ───────────────────────
function matchesXCM(summary) {
  return typeof summary === 'string' && /xcm/i.test(summary);
}

// Instant at which the H-24 alert for one occurrence should fire.
function alertTimeFor(start, isAllDay) {
  const lead = isAllDay ? ALL_DAY_LEAD_MS : ALERT_LEAD_MS;
  return new Date(start.getTime() - lead);
}

function dedupKey(uid, start) {
  return `${uid}::${new Date(start).toISOString()}`;
}

// Which occurrences are due for an alert right now (and not yet alerted).
// occ: { uid, start:Date, isAllDay, summary, location }
function dueAlerts(occurrences, now, alerted) {
  const due = [];
  for (const o of occurrences) {
    if (o.start <= now) continue; // already started / past
    if (now < alertTimeFor(o.start, o.isAllDay)) continue; // not yet time
    const key = dedupKey(o.uid, o.start);
    if (alerted.has(key)) continue; // already alerted
    due.push({ ...o, key });
  }
  return due;
}

// ── ICS → occurrences ───────────────────────────────────────
function occFromEvent(e, start) {
  return {
    uid: e.uid || e.summary,
    start,
    isAllDay: e.datetype === 'date',
    summary: e.summary || '',
    location: typeof e.location === 'string' ? e.location : '',
  };
}

function extractOccurrences(data, now, windowMs = WINDOW_MS) {
  const out = [];
  const windowEnd = new Date(now.getTime() + windowMs);
  for (const k in data) {
    const e = data[k];
    if (!e || e.type !== 'VEVENT') continue;
    if (!matchesXCM(e.summary)) continue;
    if (e.rrule) {
      // Recurring: expand occurrences within the look-ahead window.
      const dates = e.rrule.between(new Date(now.getTime() - 3600 * 1000), windowEnd, true);
      const exdates = e.exdate ? Object.values(e.exdate).map((d) => +new Date(d)) : [];
      for (const d of dates) {
        if (exdates.includes(+d)) continue;
        out.push(occFromEvent(e, d));
      }
    } else if (e.start instanceof Date) {
      out.push(occFromEvent(e, e.start));
    }
  }
  return out;
}

// ── State (survives restarts) ───────────────────────────────
function loadAlerted() {
  try {
    return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    return new Set();
  }
}

function saveAlerted(set) {
  const cutoff = Date.now() - PRUNE_MS;
  for (const key of set) {
    const t = Date.parse(key.split('::')[1] || '');
    if (!Number.isNaN(t) && t < cutoff) set.delete(key);
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...set]));
  } catch (e) {
    console.error('calendar: cannot persist state:', e.message);
  }
}

// ── Formatting ──────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtWhen(start, isAllDay) {
  const datePart = start.toLocaleDateString('fr-FR', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ,
  });
  if (isAllDay) return `${datePart} · journée`;
  const timePart = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  return `${datePart} · début <b>${timePart}</b>`;
}

function formatAlert(o) {
  let s = `📅 <b>Rappel H-24</b>\n<b>${esc(o.summary)}</b>\n🗓 ${fmtWhen(o.start, o.isAllDay)}`;
  if (o.location) s += `\n📍 ${esc(o.location)}`;
  return s;
}

// ── Check + alert (I/O) ─────────────────────────────────────
async function checkCalendar(sendMessage) {
  if (!ICS_URL) return;
  let data;
  try {
    const res = await axios.get(ICS_URL, { timeout: 20000, responseType: 'text' });
    data = ical.sync.parseICS(res.data);
  } catch (e) {
    console.error('calendar: fetch/parse failed:', e.message);
    return;
  }
  const now = new Date();
  const due = dueAlerts(extractOccurrences(data, now), now, loadAlerted());
  if (due.length === 0) return;

  const alerted = loadAlerted();
  for (const o of due) {
    try {
      await sendMessage(formatAlert(o));
      alerted.add(o.key);
      console.log(`calendar: alerted "${o.summary}" (${o.start.toISOString()})`);
    } catch (e) {
      console.error('calendar: send failed:', e.message);
    }
  }
  saveAlerted(alerted);
}

// ── Init ────────────────────────────────────────────────────
function initCalendarWatch(sendMessage, { intervalMinutes = 15 } = {}) {
  if (!ICS_URL) {
    console.log('Calendar watch disabled (CALENDAR_ICS_URL not set)');
    return;
  }
  console.log(`Calendar watch enabled — every ${intervalMinutes} min, "XCM" H-24 alerts`);
  // First check shortly after boot (let the Telegram bot settle), then on cron.
  setTimeout(() => checkCalendar(sendMessage).catch((e) => console.error('calendar first check:', e.message)), 20000);
  cron.schedule(`*/${intervalMinutes} * * * *`, () => {
    checkCalendar(sendMessage).catch((e) => console.error('calendar cron:', e.message));
  });
}

module.exports = {
  initCalendarWatch,
  matchesXCM,
  alertTimeFor,
  dedupKey,
  dueAlerts,
  formatAlert,
  extractOccurrences,
};
