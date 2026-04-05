const TelegramBot = require('node-telegram-bot-api');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot;

function initBot(onResumeCommand) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot.onText(/\/resume/, async (msg) => {
    if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) return;
    await sendMessage('⏳ Génération du résumé en cours...');
    try {
      await onResumeCommand();
    } catch (err) {
      console.error('Error generating on-demand digest:', err);
      await sendMessage('❌ Erreur lors de la génération du résumé.');
    }
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });

  console.log('Telegram bot started, listening for /resume command');
  return bot;
}

async function sendMessage(text) {
  if (!bot) throw new Error('Telegram bot not initialized');
  // Telegram message limit is 4096 chars; split if needed
  const chunks = [];
  for (let i = 0; i < text.length; i += 4096) {
    chunks.push(text.slice(i, i + 4096));
  }
  for (const chunk of chunks) {
    await bot.sendMessage(TELEGRAM_CHAT_ID, chunk, { parse_mode: 'HTML' });
  }
}

module.exports = { initBot, sendMessage };
