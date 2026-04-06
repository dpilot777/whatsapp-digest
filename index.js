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
      const limit = days <= 1 ? 200 : Math.min(days * 100, 500);
      const msgs = await chat.fetchMessages({ limit });

      const entries = [];
      for (const m of msgs) {
        if (m.fromMe) continue;
        if (m.timestamp < since) continue;

        const author = m._data.notifyName || m.author || 'Unknown';

        // Handle image messages
        if (m.hasMedia && (m.type === 'image' || m.type === 'sticker')) {
          try {
            const media = await m.downloadMedia();
            if (media && media.data) {
              const desc = await describeImage(media.data, media.mimetype);
              const caption = m.body ? ` — ${m.body}` : '';
              entries.push({ author, body: `[Image : ${desc}${caption}]`, timestamp: m.timestamp });
            }
          } catch (imgErr) {
            entries.push({ author, body: '[Image non téléchargeable]', timestamp: m.timestamp });
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
      }
    } catch (err) {
      console.error(`Error fetching history for ${g.name}:`, err.message);
    }
  }

  return historyBuffer;
}

// ── Build & send digest ─────────────────────────────────────
async function buildAndSendDigest(buffer, { title } = {}) {
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

// ── Cron: every day at 19:00 ────────────────────────────────
cron.schedule('0 19 * * *', async () => {
  console.log('Cron triggered: fetching daily history...');
  try {
    const history = await fetchHistoricalMessages(1);
    await buildAndSendDigest(history);
  } catch (err) {
    console.error('Digest cron error:', err);
  }
});

// ── Telegram commands ───────────────────────────────────────
initBot({
  onResume: async () => {
    console.log('Fetching today\'s history...');
    const history = await fetchHistoricalMessages(1);
    await buildAndSendDigest(history);
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
