const TelegramBot = require('node-telegram-bot-api');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot;
let handlers = {};

async function initBot({ onResume, onResume7d, onListGroups }) {
  handlers = { onResume, onResume7d, onListGroups };
  // Stop any stale polling session first
  const tmp = new TelegramBot(TELEGRAM_BOT_TOKEN);
  await tmp.deleteWebHook({ drop_pending_updates: true });

  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: { interval: 2000, autoStart: true, params: { timeout: 10 } },
  });

  // /resume7d — must be BEFORE /resume to avoid partial match
  bot.onText(/\/resume7d/, async (msg) => {
    if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    await sendMessage('⏳ Récupération des 7 derniers jours en cours...');
    try {
      await onResume7d();
    } catch (err) {
      console.error('Error generating 7d digest:', err);
      await sendMessage('❌ Erreur lors de la génération du résumé 7j.');
    }
  });

  // /resume — today's buffer
  bot.onText(/\/resume$/, async (msg) => {
    if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    await sendMessage('⏳ Génération du résumé en cours...');
    try {
      await onResume();
    } catch (err) {
      console.error('Error generating on-demand digest:', err);
      await sendMessage('❌ Erreur lors de la génération du résumé.');
    }
  });

  // /groupes — list every group the account is in (flags new vs monitored)
  bot.onText(/\/groupes/, async (msg) => {
    if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    await sendMessage('⏳ Récupération de la liste des groupes...');
    try {
      await onListGroups();
    } catch (err) {
      console.error('Error listing groups:', err);
      await sendMessage('❌ Erreur lors de la récupération des groupes.');
    }
  });

  // Inline button callbacks
  bot.on('callback_query', async (query) => {
    if (String(query.message.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    try {
      await bot.answerCallbackQuery(query.id);
    } catch (e) { /* ignore */ }

    if (query.data === 'resume') {
      await sendMessage('⏳ Génération du résumé en cours...');
      try {
        await handlers.onResume();
      } catch (err) {
        console.error('Error generating on-demand digest:', err);
        await sendMessage('❌ Erreur lors de la génération du résumé.');
      }
    } else if (query.data === 'resume7d') {
      await sendMessage('⏳ Récupération des 7 derniers jours en cours...');
      try {
        await handlers.onResume7d();
      } catch (err) {
        console.error('Error generating 7d digest:', err);
        await sendMessage('❌ Erreur lors de la génération du résumé 7j.');
      }
    }
  });

  bot.on('polling_error', (err) => {
    if (err.message && err.message.includes('409')) return; // ignore transient 409
    console.error('Telegram polling error:', err.message);
  });

  console.log('Telegram bot started, listening for /resume, /resume7d and /groupes commands');
  return bot;
}

async function sendMessage(text, { withButtons = false } = {}) {
  if (!bot) throw new Error('Telegram bot not initialized');
  // Telegram message limit is 4096 chars; split if needed
  const chunks = [];
  for (let i = 0; i < text.length; i += 4096) {
    chunks.push(text.slice(i, i + 4096));
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;
    const opts = { parse_mode: 'HTML' };
    if (withButtons && isLast) {
      opts.reply_markup = {
        inline_keyboard: [[
          { text: '🔄 Régénérer', callback_data: 'resume' },
          { text: '📅 7 jours', callback_data: 'resume7d' },
        ]],
      };
    }
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID, chunk, opts);
    } catch (err) {
      console.error('HTML send failed, retrying as plain text:', err.message);
      const plain = chunk.replace(/<\/?[^>]+>/g, '');
      const fallbackOpts = isLast && withButtons ? { reply_markup: opts.reply_markup } : {};
      await bot.sendMessage(TELEGRAM_CHAT_ID, plain, fallbackOpts);
    }
  }
}

// ── Media sending (day's images/videos/documents appended to digest) ──
// items: [{ type:'photo'|'video', media:Buffer, fileOptions:{filename, contentType} }]
async function sendMediaAlbum(items) {
  if (!bot) throw new Error('Telegram bot not initialized');
  if (!items || items.length === 0) return;
  if (items.length === 1) {
    const it = items[0];
    if (it.type === 'video') return bot.sendVideo(TELEGRAM_CHAT_ID, it.media, {}, it.fileOptions);
    return bot.sendPhoto(TELEGRAM_CHAT_ID, it.media, {}, it.fileOptions);
  }
  // sendMediaGroup accepts 2–10 items; Buffers packaged via fileOptions
  return bot.sendMediaGroup(TELEGRAM_CHAT_ID, items);
}

async function sendDocumentFile(buffer, fileOptions) {
  if (!bot) throw new Error('Telegram bot not initialized');
  return bot.sendDocument(TELEGRAM_CHAT_ID, buffer, {}, fileOptions);
}

module.exports = { initBot, sendMessage, sendMediaAlbum, sendDocumentFile };
