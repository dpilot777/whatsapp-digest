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

// ── Fetch historical messages from WhatsApp ─────────────────
async function fetchHistoricalMessages(days = 1) {
  const since = Date.now() / 1000 - days * 86400;
  const historyBuffer = {};

  // Load all chats once and index by ID
  let allChats;
  try {
    allChats = await client.getChats();
  } catch (err) {
    console.error('Failed to load chats:', err.message);
    return historyBuffer;
  }
  const chatIndex = {};
  for (const c of allChats) chatIndex[c.id._serialized] = c;

  for (const g of groups) {
    try {
      const chat = chatIndex[g.chatId];
      if (!chat) {
        console.log(`Chat not found: ${g.name}`);
        continue;
      }
      const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
      const limit = days <= 1 ? 200 : Math.min(days * 100, 500);
      const msgs = await Promise.race([chat.fetchMessages({ limit }), timeout(30000)]);

      const entries = [];
      for (const m of msgs) {
        if (m.fromMe) continue;
        if (m.timestamp < since) continue;

        const author = m._data.notifyName || m.author || 'Unknown';

        // Handle image messages
        if (m.hasMedia && (m.type === 'image' || m.type === 'sticker')) {
          try {
            const media = await Promise.race([m.downloadMedia(), timeout(10000)]);
            if (media && media.data) {
              const desc = await describeImage(media.data, media.mimetype);
              const caption = m.body ? ` — ${m.body}` : '';
              entries.push({ author, body: `[Image : ${desc}${caption}]`, timestamp: m.timestamp });
            }
          } catch (imgErr) {
            entries.push({ author, body: '[Image]', timestamp: m.timestamp });
          }
          continue;
        }

        // Text messages
        if (!m.body) continue;
        if (isNoise(m.body)) continue;
        entries.push({ author, body: m.body, timestamp: m.timestamp });
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

// ── Merge buffers (live + history, deduplicated) ────────────
function mergeBuffers(a, b) {
  const merged = {};
  const allIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const chatId of allIds) {
    const msgsA = a[chatId] || [];
    const msgsB = b[chatId] || [];
    // Deduplicate by timestamp+author
    const seen = new Set();
    const all = [];
    for (const m of [...msgsA, ...msgsB]) {
      const key = `${m.timestamp}|${m.author}|${m.body?.slice(0, 30)}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(m);
      }
    }
    if (all.length > 0) merged[chatId] = all;
  }
  return merged;
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

  let output = `📋 <b>${heading}</b>\n`;
  output += `📊 ${totalMsg} messages · ${activeEntries.length} groupes actifs\n`;
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
cron.schedule('0 19 * * *', async () => {
  console.log('Cron triggered: fetching daily history...');
  try {
    const history = await fetchHistoricalMessages(1);
    const merged = mergeBuffers(messageBuffer, history);
    await buildAndSendDigest(merged);
    messageBuffer = {}; // Clear live buffer after daily digest
  } catch (err) {
    console.error('Digest cron error:', err);
  }
}, { timezone: 'Europe/Paris' });

// ── Telegram commands ───────────────────────────────────────
initBot({
  onResume: async () => {
    console.log('Fetching today\'s history...');
    const history = await fetchHistoricalMessages(1);
    const merged = mergeBuffers(messageBuffer, history);
    await buildAndSendDigest(merged);
  },
  onResume7d: async () => {
    console.log('Fetching 7-day history...');
    const history = await fetchHistoricalMessages(7);
    await buildAndSendDigest(history, { title: 'Digest WhatsApp — 7 derniers jours' });
  },
});

// ── Start ───────────────────────────────────────────────────
client.initialize();
console.log('WhatsApp Digest starting... scan QR code when prompted.');
