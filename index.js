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

// ── Progress bar helper ─────────────────────────────────────
function progressBar(count, maxCount, width = 15) {
  const filled = Math.round((count / maxCount) * width) || (count > 0 ? 1 : 0);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Build & send digest ─────────────────────────────────────
async function buildAndSendDigest() {
  const categorized = getGroupsByCategory(groups);
  const allEntries = [];

  // Collect counts
  for (const { category, groups: catGroups } of categorized) {
    for (const g of catGroups) {
      const msgs = messageBuffer[g.chatId] || [];
      allEntries.push({ group: g, category, messages: msgs, count: msgs.length });
    }
  }

  const maxCount = Math.max(...allEntries.map(e => e.count), 1);
  const activeEntries = allEntries.filter(e => e.count > 0);

  if (activeEntries.length === 0) {
    await sendMessage('📭 Aucun message dans les groupes surveillés aujourd\'hui.');
    clearBuffer();
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

  let output = `📋 <b>Digest WhatsApp — ${dateStr}</b>\n`;
  output += `${activeEntries.reduce((s, e) => s + e.count, 0)} messages dans ${activeEntries.length} groupes\n`;

  for (const { category, groups: catGroups } of categorized) {
    const catEntries = activeEntries
      .filter(e => e.category === category)
      .sort((a, b) => b.count - a.count);

    if (catEntries.length === 0) continue;

    const catEmoji = { 'Air France': '✈️', 'Famille': '👨‍👩‍👧‍👦', 'Provinciaux': '🏔️', 'Amis': '🤝', 'École': '🎒', 'Patinage': '⛸️' };
    output += `\n${catEmoji[category] || '📁'} <b>${category}</b>\n`;

    for (const entry of catEntries) {
      const bar = progressBar(entry.count, maxCount);
      const summary = summaries.get(entry.group.chatId) || '';
      output += `\n<b>${entry.group.name}</b> (${entry.count})\n`;
      output += `${bar}\n`;
      if (summary) output += `${summary}\n`;
    }
  }

  await sendMessage(output);
  clearBuffer();
  console.log(`Digest sent at ${now.toISOString()}`);
}

// ── WhatsApp client ─────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox'] },
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
  buildAndSendDigest().catch(err => console.error('Digest cron error:', err));
});

// ── Telegram /resume command ────────────────────────────────
initBot(async () => {
  await buildAndSendDigest();
});

// ── Start ───────────────────────────────────────────────────
client.initialize();
console.log('WhatsApp Digest starting... scan QR code when prompted.');
