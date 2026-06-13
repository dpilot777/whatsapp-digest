require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { parseConfig, getGroupsByCategory, getChatIdSet } = require('./config');
const { summarizeMessages, describeImage } = require('./summarize');
const { initBot, sendMessage } = require('./telegram');

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
            mediaId: m.id?._serialized || '',
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

        // Images & stickers: keep a placeholder + handle so they can be
        // described later (daily paths only). Caption is preserved either way.
        if (m.type === 'image' || m.type === 'sticker') {
          const caption = m.body && !isNoise(m.body) ? m.body : '';
          entries.push({
            author: m.author,
            body: caption ? `[Image — ${caption}]` : '[Image]',
            caption,
            timestamp: m.timestamp,
            mediaId: m.mediaId || '',
            isImage: true,
          });
          continue;
        }

        if (m.hasMedia && !m.body) {
          // Other media (video, audio, document…) without caption
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
      console.error(`  ✗ ${g.name}: ${err.message}`);
    }
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

client.on('qr', (qr) => {
  console.log('Scan this QR code with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp client ready!');
  console.log(`Monitoring ${groups.length} groups across ${getGroupsByCategory(groups).length} categories`);
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
    messageBuffer = {}; // Clear live buffer after daily digest
  } catch (err) {
    console.error('Digest cron error:', err);
  }
}, { timezone: 'Europe/Paris' });

// ── Telegram commands ───────────────────────────────────────
if (require.main === module) initBot({
  onResume: async () => {
    console.log('Fetching today\'s history...');
    const history = await fetchHistoricalMessages(1);
    const merged = mergeBuffers(messageBuffer, history);
    await describeImagesInBuffer(merged);
    await buildAndSendDigest(merged);
  },
  onResume7d: async () => {
    console.log('Fetching 7-day history...');
    const history = await fetchHistoricalMessages(7);
    // Images are left as [Image] here by design (daily-only description) to
    // bound vision API cost/latency over a 7-day window.
    await buildAndSendDigest(history, { title: 'Digest WhatsApp — 7 derniers jours' });
  },
});

// ── Start ───────────────────────────────────────────────────
if (require.main === module) {
  client.initialize();
  console.log('WhatsApp Digest starting... scan QR code when prompted.');
}

// Exported for unit tests — require()-ing this file must not start the client.
module.exports = {
  mergeBuffers,
  isImageEntry,
  isDescribedImage,
  mergeImageEntries,
  mapLimit,
};
