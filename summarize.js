const axios = require('axios');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

async function summarizeMessages(groupName, messages) {
  if (!messages || messages.length === 0) return null;

  const conversation = messages
    .map(m => `${m.author}: ${m.body}`)
    .join('\n');

  const prompt = `Résume cette conversation WhatsApp du groupe "${groupName}" en MAXIMUM 300 caractères (pas de mots coupés). Sois concis, factuel, en français. Ne commence pas par "Le groupe..." ou "Les membres...". Va droit au sujet principal.

Messages :
${conversation}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const text = response.data.content[0].text.trim();
  // Enforce 300 char hard limit
  return text.length > 300 ? text.slice(0, 297) + '...' : text;
}

module.exports = { summarizeMessages };
