require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { parseConfig, getGroupsByCategory, getChatIdSet } = require('./config');
const { summarizeMessages } = require('./summarize');
const { initBot, sendMessage } = require('./telegram');

// ── Config ──────────────────────────────────────────────────
const groups = parseConfig();
const chatIdSet = getChatIdSet(groups);
const groupMap = {};
for (const g of groups) groupMap[g.chatId] = g;

// ── Message buffer (cleared after each digest) ─────────────
// { chatId: [ { author, body, timestamp } ] }
let messageBuffer = {};

function clearBuffer() {
  messageBuffer = {};
}

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

  for (const g of groups) {
    try {
      const chat = await client.getChatById(g.chatId);
      // Fetch enough messages to cover the period (limit to avoid overload)
      const limit = days <= 1 ? 200 : Math.min(days * 100, 500);
      const msgs = await chat.fetchMessages({ limit });

      const filtered = msgs.filter(m => {
        if (!m.body || m.fromMe) return false;
        if (m.timestamp < since) return false;
        if (isNoise(m.body)) return false;
        return true;
      });

      if (filtered.length > 0) {
        historyBuffer[g.chatId] = filtered.map(m => ({
          author: m._data.notifyName || m.author || 'Unknown',
          body: m.body,
          timestamp: m.timestamp,
        }));
      }
    } catch (err) {
      console.error(`Error fetching history for ${g.name}:`, err.message);
    }
  }

  return historyBuffer;
}

// ── Build & send digest ─────────────────────────────────────
async function buildAndSendDigest(sourceBuffer, { title, clearAfter = false } = {}) {
  const buffer = sourceBuffer || messageBuffer;
  const categorized = getGroupsByCategory(groups);
  const allEntries = [];

  // Collect counts
  for (const { category, groups: catGroups } of categorized) {
    for (const g of catGroups) {
      const msgs = buffer[g.chatId] || [];
      allEntries.push({ group: g, category, messages: msgs, count: msgs.length });
    }
  }

  const activeEntries = allEntries.filter(e => e.count > 0);

  if (activeEntries.length === 0) {
    await sendMessage('📭 Aucun message dans les groupes surveillés pour cette période.');
    if (clearAfter) clearBuffer();
    return;
  }

  // Summarize each active group (sequential to respect rate limits)
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

  // Build output grouped by category, sorted by count within each category
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const heading = title || `Digest WhatsApp — ${dateStr}`;
  let output = `📋 <b>${heading}</b>\n`;
  output += `${activeEntries.reduce((s, e) => s + e.count, 0)} messages dans ${activeEntries.length} groupes\n`;

  for (const { category, groups: catGroups } of categorized) {
    const catEntries = activeEntries
      .filter(e => e.category === category)
      .sort((a, b) => b.count - a.count);

    if (catEntries.length === 0) continue;

    const catEmoji = { 'Air France': '✈️', 'Famille': '👨‍👩‍👧‍👦', 'Provinciaux': '🏔️', 'Amis': '🤝', 'École': '🎒', 'Patinage': '⛸️' };
    output += `\n${catEmoji[category] || '📁'} <b>${category}</b>\n`;

    for (const entry of catEntries) {
      const summary = summaries.get(entry.group.chatId) || '';
      output += `\n<b>${entry.group.name}</b> (${entry.count} msg)\n`;
      if (summary) output += `${summary}\n`;
    }
  }

  await sendMessage(output);
  if (clearAfter) clearBuffer();
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

client.on('message', (msg) => {
  const chatId = msg.from;
  if (!chatIdSet.has(chatId)) return;
  if (isNoise(msg.body)) return;

  if (!messageBuffer[chatId]) messageBuffer[chatId] = [];
  messageBuffer[chatId].push({
    author: msg._data.notifyName || msg.author || 'Unknown',
    body: msg.body,
    timestamp: msg.timestamp,
  });
});

// ── Cron: every day at 19:00 ────────────────────────────────
cron.schedule('0 19 * * *', () => {
  console.log('Cron triggered: building daily digest...');
  buildAndSendDigest(null, { clearAfter: true }).catch(err => console.error('Digest cron error:', err));
});

// ── Telegram commands ───────────────────────────────────────
initBot({
  onResume: async () => {
    await buildAndSendDigest(null, { clearAfter: false });
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
