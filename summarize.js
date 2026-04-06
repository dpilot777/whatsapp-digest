const axios = require('axios');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

async function summarizeMessages(groupName, messages) {
  if (!messages || messages.length === 0) return null;

  const conversation = messages
    .map(m => `${m.author}: ${m.body}`)
    .join('\n');

  const prompt = `Résume cette conversation WhatsApp du groupe "${groupName}".

Règles :
- Mentionne QUI dit quoi (utilise les prénoms des auteurs)
- Résumé en français, MAX 400 caractères
- Si des messages sont en tchèque ou autre langue étrangère, ajoute à la fin sur une nouvelle ligne le texte original le plus pertinent entre guillemets (max 1-2 phrases clés)
- Format : résumé en français\\n"texte original si langue étrangère"
- Sois concis, factuel, pas de mots coupés
- Ne commence pas par "Le groupe..." ou "Les membres..."

Messages :
${conversation}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: MODEL,
      max_tokens: 400,
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

  let text = response.data.content[0].text.trim();

  // Wrap quoted foreign text in italics for Telegram HTML
  text = text.replace(/\n"(.+)"$/s, '\n<i>"$1"</i>');

  // Hard limit
  return text.length > 500 ? text.slice(0, 497) + '...' : text;
}

async function describeImage(base64Data, mimeType) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: base64Data },
            },
            {
              type: 'text',
              text: 'Décris cette image en UNE phrase courte en français (max 80 caractères). Sois factuel et concis.',
            },
          ],
        }],
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
    return text.length > 100 ? text.slice(0, 97) + '...' : text;
  } catch (err) {
    console.error('Error describing image:', err.message);
    return 'image partagée';
  }
}

module.exports = { summarizeMessages, describeImage };
