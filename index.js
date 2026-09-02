require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { parseConfig, getGroupsByCategory, getChatIdSet } = require('./config');
const { summarizeMessages, describeImage } = require('./summarize');
const { initBot, sendMessage, sendMediaAlbum, sendDocumentFile } = require('./telegram');
const { initCalendarWatch } = require('./calendar');

// ── Config ──────────────────────────────────────────────────
const groups = parseConfig();
const chatIdSet = getChatIdSet(groups);
const groupMap = {};
for (const g of groups) groupMap[g.chatId] = g;

// ── Live message buffer (captures messages in real-time) ────
// { chatId: [ { author, body, timestamp } ] }
let messageBuffer = {};

// Noise filter: ignore emoji-only, "Ok", thumbs up, laughing
const NOISE_RE = /^[\s\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]*$/u;
const NOISE_WORDS = new Set(['ok', 'ok!', 'ok.', 'oui', 'd\'accord']);
const NOISE_EMOJIS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '😂', '🤣', '😅']);

// WhatsApp media type → French label used in the text digest.
const MEDIA_LABEL = {
  image: 'Image', sticker: 'Image', video: 'Vidéo', gif: 'Vidéo',
  document: 'Document', audio: 'Audio', ptt: 'Audio',
};
// Media types re-sent to Telegram after the digest (skip stickers/audio).
const MEDIA_APPEND_TYPES = new Set(['image', 'video', 'gif', 'document']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isNoise(body) {
  if (!body || !body.trim()) return true;
  const t = body.trim();
  if (NOISE_EMOJIS.has(t)) return true;
  if (NOISE_WORDS.has(t.toLowerCase())) return true;
  if (NOISE_RE.test(t) && t.length < 10) return true;
  return false;
}

// ── Fetch historical messages via Puppeteer (bypasses broken fetchMessages) ──
async function fetchHistoricalMessages(days = 1) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const historyBuffer = {};
  let pageDead = 0;

  for (const g of groups) {
    try {
      const limit = days <= 1 ? 200 : Math.min(days * 100, 500);

      // Use raw Puppeteer evaluate to bypass broken fetchMessages
      const rawMsgs = await client.pupPage.evaluate(async (chatId, msgLimit) => {
        const chat = await window.WPP?.chat?.get(chatId)
          || window.Store?.Chat?.get(chatId);
        if (!chat) return null;

        let msgs;
        // Try WPP first (newer versions)
        if (window.WPP?.chat?.getMessages) {
          msgs = await window.WPP.chat.getMessages(chatId, { count: msgLimit });
        } else if (chat.msgs && chat.msgs._models) {
          msgs = chat.msgs._models.slice(-msgLimit);
        } else {
          return null;
        }

        return msgs.map(m => {
          // Extract author name — try multiple fields
          let author = '';
          if (m.notifyName) {
            author = m.notifyName;
          } else if (m.senderObj?.pushname) {
            author = m.senderObj.pushname;
          } else if (m.senderObj?.notifyName) {
            author = m.senderObj.notifyName;
          } else if (m.senderObj?.name) {
            author = m.senderObj.name;
          } else if (typeof m.author === 'string') {
            author = m.author.split('@')[0];
          } else if (m.author?.user) {
            author = m.author.user;
          } else if (typeof m.from === 'string') {
            author = m.from.split('@')[0];
          } else if (m.from?.user) {
            author = m.from.user;
          }
          return {
            body: m.body || m.caption || '',
            author: author || 'Inconnu',
            timestamp: m.t || 0,
            fromMe: m.id?.fromMe || false,
            type: m.type || 'chat',
            hasMedia: !!(m.mediaData || m.isMedia),
            // WPP's MsgKey has no `_serialized` prop, but String(m.id) yields the
            // serialized form (e.g. "false_<chat>@g.us_<id>_<participant>").
            mediaId: (() => {
              const s = m.id ? String(m.id) : '';
              return s && s !== '[object Object]' ? s : (m.id && m.id._serialized) || '';
            })(),
            filename: m.filename || '',
            size: m.size || 0,
          };
        });
      }, g.chatId, limit);

      if (!rawMsgs) {
        console.log(`  - ${g.name}: chat introuvable`);
        continue;
      }

      const entries = [];
      for (const m of rawMsgs) {
        if (m.fromMe) continue;
        if (m.timestamp < since) continue;

        // Any media: keep a placeholder + handle (mediaId/type/size) so it can
        // be described (images) and/or re-sent to Telegram after the digest.
        const label = MEDIA_LABEL[m.type];
        if (label) {
          const caption = m.body && !isNoise(m.body) ? m.body : '';
          const isImg = m.type === 'image' || m.type === 'sticker';
          entries.push({
            author: m.author,
            body: caption ? `[${label} — ${caption}]` : `[${label}]`,
            caption,
            timestamp: m.timestamp,
            mediaId: m.mediaId || '',
            isImage: isImg,
            mediaType: m.type,
            filename: m.filename || '',
            size: m.size || 0,
          });
          continue;
        }

        if (m.hasMedia && !m.body) {
          // Unknown media kind without caption
          entries.push({ author: m.author, body: '[Média]', timestamp: m.timestamp });
          continue;
        }
        if (!m.body || isNoise(m.body)) continue;
        entries.push({ author: m.author, body: m.body, timestamp: m.timestamp });
      }

      if (entries.length > 0) {
        historyBuffer[g.chatId] = entries;
        console.log(`  ✓ ${g.name}: ${entries.length} messages`);
      }
    } catch (err) {
      if (isPageDeadError(err)) pageDead++;
      console.error(`  ✗ ${g.name}: ${err.message}`);
    }
  }

  // Detached frame / dead page: every group failed and nothing came back.
  // Signal the caller so it alerts + heals instead of sending a false
  // "Aucun message" digest.
  if (pageDead > 0 && Object.keys(historyBuffer).length === 0) {
    const e = new Error('WhatsApp page detached during fetch');
    e.code = 'WA_PAGE_DEAD';
    throw e;
  }

  return historyBuffer;
}

// ── Image entry helpers ─────────────────────────────────────
// An image entry can be: live described "[Image : …]", historical placeholder
// "[Image]" / "[Image — caption]". Detect them so dedup & description work.
function isImageEntry(m) {
  return m.isImage === true || (typeof m.body === 'string' && m.body.startsWith('[Image'));
}

function isDescribedImage(m) {
  return typeof m.body === 'string' && m.body.startsWith('[Image :');
}

// When the same image appears in both buffers, keep the described version and
// preserve the mediaId so an undescribed copy can still be filled in later.
function mergeImageEntries(x, y) {
  const base = isDescribedImage(x) ? x : (isDescribedImage(y) ? y : x);
  const other = base === x ? y : x;
  return {
    ...base,
    mediaId: base.mediaId || other.mediaId || '',
    caption: base.caption || other.caption || '',
    isImage: true,
  };
}

// ── Merge buffers (live + history, deduplicated) ────────────
function mergeBuffers(a, b) {
  const merged = {};
  const allIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const chatId of allIds) {
    const msgsA = a[chatId] || [];
    const msgsB = b[chatId] || [];
    // Deduplicate by timestamp+author. Images use a body-agnostic key so a
    // described copy and a bare "[Image]" copy collapse into one.
    const byKey = new Map();
    for (const m of [...msgsA, ...msgsB]) {
      const img = isImageEntry(m);
      const key = img
        ? `${m.timestamp}|${m.author}|IMG`
        : `${m.timestamp}|${m.author}|${(m.body || '').slice(0, 30)}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, m);
      } else if (img) {
        byKey.set(key, mergeImageEntries(existing, m));
      }
      // non-image duplicate → keep the first occurrence
    }
    const all = [...byKey.values()];
    if (all.length > 0) merged[chatId] = all;
  }
  return merged;
}

// ── Concurrency-limited map (no extra dependency) ───────────
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Describe images in a buffer, in place (daily paths only) ─
// Skips already-described images, caps per group to bound vision API
// cost/latency, and parallelises the downloads/descriptions.
async function describeImagesInBuffer(buffer, { capPerGroup = 8, concurrency = 4 } = {}) {
  const toDescribe = [];
  for (const chatId of Object.keys(buffer)) {
    let queued = 0;
    let skipped = 0;
    const groupName = groupMap[chatId]?.name || chatId;
    for (const entry of buffer[chatId]) {
      if (!isImageEntry(entry) || isDescribedImage(entry)) continue;
      if (!entry.mediaId) continue; // no handle to download the media
      if (queued >= capPerGroup) { skipped++; continue; }
      queued++;
      toDescribe.push(entry);
    }
    if (skipped > 0) {
      console.log(`  … ${groupName}: ${skipped} image(s) au-delà du plafond (${capPerGroup}), laissées en [Image]`);
    }
  }

  if (toDescribe.length === 0) return;
  console.log(`Describing ${toDescribe.length} image(s) from history...`);

  await mapLimit(toDescribe, concurrency, async (entry) => {
    try {
      const msg = await client.getMessageById(entry.mediaId);
      const media = msg && (await msg.downloadMedia());
      if (media && media.data) {
        const desc = await describeImage(media.data, media.mimetype);
        const cap = entry.caption ? ` — ${entry.caption}` : '';
        entry.body = `[Image : ${desc}${cap}]`;
      }
    } catch (err) {
      console.error(`  ✗ image ${entry.mediaId}: ${err.message}`);
      // leave the placeholder body as-is
    }
  });
}

// ── Send the day's media (images/videos/documents) after the digest ──
// Grouped by WhatsApp group as Telegram albums, capped per group. Videos or
// files above Telegram's ~50 MB bot limit are listed, not attached.
// Uses the historical buffer (has mediaId/type/size for every media of the day).
async function sendDayMedia(history, { capPerGroup = 20, maxBytes = 49 * 1024 * 1024, concurrency = 4 } = {}) {
  const categorized = getGroupsByCategory(groups);
  for (const { groups: catGroups } of categorized) {
    for (const g of catGroups) {
      const wanted = (history[g.chatId] || []).filter(
        (e) => e.mediaId && MEDIA_APPEND_TYPES.has(e.mediaType),
      );
      if (wanted.length === 0) continue;
      const capped = wanted.slice(0, capPerGroup);
      const overflow = wanted.length - capped.length;

      let downloaded;
      try {
        downloaded = await mapLimit(capped, concurrency, async (e) => {
          if (e.size && e.size > maxBytes) return { e, oversized: true };
          const msg = await client.getMessageById(e.mediaId);
          const media = msg && (await msg.downloadMedia());
          if (!media || !media.data) return { e, failed: true };
          const buf = Buffer.from(media.data, 'base64');
          if (buf.length > maxBytes) return { e, oversized: true };
          return { e, buf, mimetype: media.mimetype, filename: media.filename || e.filename };
        });
      } catch (err) {
        if (isPageDeadError(err)) { recover('media: page dead'); return; }
        console.error(`sendDayMedia ${g.name}: ${err.message}`);
        continue;
      }

      const ok = downloaded.filter((d) => d && d.buf);
      const oversized = downloaded.filter((d) => d && d.oversized);
      const failed = downloaded.filter((d) => d && d.failed);
      if (ok.length === 0 && oversized.length === 0) continue;

      let header = `📎 <b>Médias — ${g.name}</b> · ${ok.length} joint(s)`;
      const notes = [];
      if (overflow) notes.push(`+${overflow} au-delà du plafond (${capPerGroup})`);
      if (oversized.length) notes.push(`${oversized.length} trop volumineux (>50 Mo)`);
      if (failed.length) notes.push(`${failed.length} indisponible(s)`);
      if (notes.length) header += `\n<i>${notes.join(' · ')}</i>`;
      await sendMessage(header).catch(() => {});

      // Photos + videos → albums of up to 10
      const album = ok
        .filter((d) => d.e.mediaType !== 'document')
        .map((d) => ({
          type: d.e.mediaType === 'image' ? 'photo' : 'video',
          media: d.buf,
          fileOptions: {
            filename: d.filename || (d.e.mediaType === 'image' ? 'photo.jpg' : 'video.mp4'),
            contentType: d.mimetype || undefined,
          },
        }));
      for (let i = 0; i < album.length; i += 10) {
        try {
          await sendMediaAlbum(album.slice(i, i + 10));
        } catch (err) {
          console.error(`album send ${g.name}: ${err.message}`);
        }
        await sleep(1200); // stay under Telegram's per-chat rate limit
      }

      // Documents individually
      for (const d of ok.filter((x) => x.e.mediaType === 'document')) {
        try {
          await sendDocumentFile(d.buf, {
            filename: d.filename || 'document',
            contentType: d.mimetype || undefined,
          });
        } catch (err) {
          console.error(`doc send ${g.name}: ${err.message}`);
        }
        await sleep(1200);
      }
    }
  }
}

// ── Build & send digest ─────────────────────────────────────
async function buildAndSendDigest(buffer, { title } = {}) {
  const categorized = getGroupsByCategory(groups);
  const allEntries = [];

  for (const { category, groups: catGroups } of categorized) {
    for (const g of catGroups) {
      const msgs = buffer[g.chatId] || [];
      allEntries.push({ group: g, category, messages: msgs, count: msgs.length });
    }
  }

  const activeEntries = allEntries.filter(e => e.count > 0);

  if (activeEntries.length === 0) {
    await sendMessage('📭 Aucun message dans les groupes surveillés pour cette période.');
    return;
  }

  // Summarize each active group
  const summaries = new Map();
  for (const entry of activeEntries) {
    try {
      const summary = await summarizeMessages(entry.group.name, entry.messages);
      summaries.set(entry.group.chatId, summary);
    } catch (err) {
      console.error(`Error summarizing ${entry.group.name}:`, err.message);
      summaries.set(entry.group.chatId, '(résumé indisponible)');
    }
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const totalMsg = activeEntries.reduce((s, e) => s + e.count, 0);
  const heading = title || `Digest WhatsApp — ${dateStr}`;
  const catEmoji = { 'Air France': '✈️', 'Famille': '👨‍👩‍👧‍👦', 'Provinciaux': '🏔️', 'Amis': '🤝', 'École': '🎒', 'Patinage': '⛸️' };

  // Global progress bar (compact), full at 100+ messages
  // Total visible width on line 2 must fit ~19 chars (iOS preview)
  const ratio = Math.min(totalMsg / 100, 1);
  const filled = Math.max(1, Math.round(ratio * 12));
  const bar = '■'.repeat(filled) + '□'.repeat(12 - filled);

  let output = `📋 <b>${heading}</b>\n`;
  output += `${bar} ${totalMsg} mess. / ${activeEntries.length} gr.\n`;
  output += `━━━━━━━━━━━━━━━━━━━`;

  for (const { category, groups: catGroups } of categorized) {
    const catEntries = activeEntries
      .filter(e => e.category === category)
      .sort((a, b) => b.count - a.count);

    if (catEntries.length === 0) continue;

    const catMsgTotal = catEntries.reduce((s, e) => s + e.count, 0);
    output += `\n\n${catEmoji[category] || '📁'} <b>${category}</b> · ${catMsgTotal} msg\n`;

    for (const entry of catEntries) {
      const summary = summaries.get(entry.group.chatId) || '';
      output += `\n   ◆ <b>${entry.group.name}</b> (${entry.count})\n`;
      if (summary) {
        const lines = summary.split('\n');
        for (const line of lines) {
          output += `      ${line}\n`;
        }
      }
    }
    output += `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`;
  }

  // Replace trailing separator
  output = output.replace(/┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄$/, '━━━━━━━━━━━━━━━━━━━');

  await sendMessage(output, { withButtons: true });
  console.log(`Digest sent at ${now.toISOString()}`);
}

// ── WhatsApp client ─────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
});

// ── Health & auto-recovery ──────────────────────────────────
// WhatsApp Web periodically reloads its own page; the old Puppeteer frame then
// becomes "detached" and every evaluate() throws. The client keeps a dead page,
// so the digest silently sees zero messages ("Aucun message") for days. We
// detect that and exit — pm2 relaunches a clean session (LocalAuth persists).
let recovering = false;
function recover(reason) {
  if (recovering) return;
  recovering = true;
  console.error(`Recovering WhatsApp session (pm2 will restart) — ${reason}`);
  setTimeout(() => process.exit(1), 1000);
}

function isPageDeadError(err) {
  const m = (err && err.message) || String(err || '');
  return /detached Frame|Session closed|Target closed|Execution context was destroyed|Protocol error|page has been closed/i.test(m);
}

client.on('qr', (qr) => {
  console.log('Scan this QR code with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp client ready!');
  console.log(`Monitoring ${groups.length} groups across ${getGroupsByCategory(groups).length} categories`);
  // Optional boot sanity check: run one real fetch and log the count (no Telegram).
  if (process.env.BOOT_SELFTEST === '1') {
    setTimeout(async () => {
      try {
        const h = await fetchHistoricalMessages(1);
        const all = Object.values(h).flat();
        const media = all.filter((e) => e.mediaType);
        const withId = media.filter((e) => e.mediaId);
        console.log(`[SELFTEST] ${Object.keys(h).length} groups, ${all.length} msgs, media=${media.length}, withMediaId=${withId.length}`);
        // Validate the full download chain on the first media entry.
        if (withId.length) {
          const e0 = withId[0];
          try {
            const msg = await client.getMessageById(e0.mediaId);
            const dl = msg && (await msg.downloadMedia());
            console.log(`[SELFTEST] download ${e0.mediaType}: ${dl && dl.data ? `OK ${dl.mimetype} ${Buffer.from(dl.data, 'base64').length}b` : 'NO DATA'}`);
          } catch (err) {
            console.error(`[SELFTEST] download failed: ${err.message}`);
          }
        }
      } catch (e) {
        console.error(`[SELFTEST] ${e.code || e.message}`);
      }
    }, 20000);
  }
});

client.on('disconnected', (reason) => {
  console.error(`WhatsApp disconnected: ${reason}`);
  recover(`disconnected: ${reason}`);
});

// ── Live message listener ───────────────────────────────────
client.on('message', async (msg) => {
  const chatId = msg.from;
  if (!chatIdSet.has(chatId)) return;

  const author = msg._data.notifyName || msg.author || 'Unknown';

  // Handle images in real-time
  if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const desc = await describeImage(media.data, media.mimetype);
        const caption = msg.body ? ` — ${msg.body}` : '';
        if (!messageBuffer[chatId]) messageBuffer[chatId] = [];
        messageBuffer[chatId].push({ author, body: `[Image : ${desc}${caption}]`, timestamp: msg.timestamp });
      }
    } catch (e) {
      if (!messageBuffer[chatId]) messageBuffer[chatId] = [];
      messageBuffer[chatId].push({ author, body: '[Image]', timestamp: msg.timestamp });
    }
    return;
  }

  if (isNoise(msg.body)) return;

  if (!messageBuffer[chatId]) messageBuffer[chatId] = [];
  messageBuffer[chatId].push({
    author,
    body: msg.body,
    timestamp: msg.timestamp,
  });
});

// ── Cron: every day at 19:00 Paris ──────────────────────────
if (require.main === module) cron.schedule('0 19 * * *', async () => {
  console.log('Cron triggered: fetching daily history...');
  try {
    const history = await fetchHistoricalMessages(1);
    const merged = mergeBuffers(messageBuffer, history);
    await describeImagesInBuffer(merged);
    await buildAndSendDigest(merged);
    await sendDayMedia(history);
    messageBuffer = {}; // Clear live buffer after daily digest
  } catch (err) {
    if (err.code === 'WA_PAGE_DEAD') {
      console.error('Daily digest: WhatsApp page was detached — recovering.');
      await sendMessage('⚠️ Connexion WhatsApp perdue au moment du digest quotidien. Reconnexion automatique en cours — relancez /resume dans ~1 min.').catch(() => {});
      recover('daily digest: page dead');
    } else {
      console.error('Digest cron error:', err);
    }
  }
}, { timezone: 'Europe/Paris' });

// ── Telegram commands ───────────────────────────────────────
if (require.main === module) initBot({
  onResume: async () => {
    console.log('Fetching today\'s history...');
    try {
      const history = await fetchHistoricalMessages(1);
      const merged = mergeBuffers(messageBuffer, history);
      await describeImagesInBuffer(merged);
      await buildAndSendDigest(merged);
      await sendDayMedia(history);
    } catch (err) {
      if (err.code !== 'WA_PAGE_DEAD') throw err;
      await sendMessage('⚠️ Connexion WhatsApp perdue — reconnexion automatique en cours. Réessayez /resume dans ~1 min.').catch(() => {});
      recover('resume: page dead');
    }
  },
  onResume7d: async () => {
    console.log('Fetching 7-day history...');
    try {
      const history = await fetchHistoricalMessages(7);
      // Images are left as [Image] here by design (daily-only description) to
      // bound vision API cost/latency over a 7-day window.
      await buildAndSendDigest(history, { title: 'Digest WhatsApp — 7 derniers jours' });
    } catch (err) {
      if (err.code !== 'WA_PAGE_DEAD') throw err;
      await sendMessage('⚠️ Connexion WhatsApp perdue — reconnexion automatique en cours. Réessayez /resume7d dans ~1 min.').catch(() => {});
      recover('resume7d: page dead');
    }
  },
  onListGroups: async () => {
    console.log('Listing all WhatsApp groups...');
    let all;
    try {
      all = await client.pupPage.evaluate(() => {
        if (!window.Store || !window.Store.Chat || !window.Store.Chat.getModelsArray) return null;
        return window.Store.Chat.getModelsArray()
          .filter((c) => c && c.id && c.id.server === 'g.us')
          .map((c) => ({
            id: c.id._serialized,
            name: c.formattedTitle || c.name || (c.groupMetadata && c.groupMetadata.subject) || '',
          }));
      });
    } catch (err) {
      if (!isPageDeadError(err)) throw err;
      await sendMessage('⚠️ Connexion WhatsApp perdue — reconnexion automatique en cours. Réessayez /groupes dans ~1 min.').catch(() => {});
      recover('groupes: page dead');
      return;
    }

    if (!all) {
      await sendMessage('⚠️ Liste indisponible (WhatsApp pas encore prêt). Réessayez dans ~1 min.');
      return;
    }

    const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'fr');
    const presentIds = new Set(all.map((g) => g.id));
    const fresh = all.filter((g) => !chatIdSet.has(g.id)).sort(byName);
    const monitored = all.filter((g) => chatIdSet.has(g.id)).sort(byName);
    const missing = groups.filter((g) => !presentIds.has(g.chatId)); // configured but not found now

    let out = `👥 <b>Groupes WhatsApp</b>\n${fresh.length} nouveau(x) · ${monitored.length} suivi(s) · ${missing.length} introuvable(s)\n`;
    out += `\n🆕 <b>Nouveaux (non suivis)</b>\n`;
    out += fresh.length
      ? fresh.map((g) => `• ${esc(g.name) || '(sans nom)'}\n<code>${g.id}</code>`).join('\n') + '\n'
      : '(aucun)\n';
    if (missing.length) {
      out += `\n⚠️ <b>Configurés mais introuvables</b> (quittés/renommés ?)\n`;
      out += missing.map((g) => `• ${esc(g.name)}`).join('\n') + '\n';
    }
    out += `\n✅ <b>Déjà dans le digest</b>\n`;
    out += monitored.map((g) => `• ${esc(g.name) || '(sans nom)'}`).join('\n') + '\n';

    await sendMessage(out);
  },
});

// ── Start ───────────────────────────────────────────────────
if (require.main === module) {
  client.initialize();
  console.log('WhatsApp Digest starting... scan QR code when prompted.');

  // Calendar "XCM" H-24 alerts (no-op unless CALENDAR_ICS_URL is set).
  initCalendarWatch(sendMessage);

  // Health watchdog: a detached/dead page is caught within minutes and healed
  // (pm2 relaunch) instead of silently sending empty digests for days.
  setInterval(async () => {
    if (recovering) return;
    try {
      if (client.pupPage) await client.pupPage.evaluate('1');
    } catch (err) {
      if (isPageDeadError(err)) recover(`watchdog: ${err.message}`);
    }
  }, 5 * 60 * 1000);
}

// Exported for unit tests — require()-ing this file must not start the client.
module.exports = {
  mergeBuffers,
  isImageEntry,
  isDescribedImage,
  mergeImageEntries,
  mapLimit,
  isPageDeadError,
};
