const axios = require('axios');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

async function summarizeMessages(groupName, messages) {
  if (!messages || messages.length === 0) return null;

  const conversation = messages
    .map(m => `${m.author}: ${m.body}`)
    .join('\n');

  const prompt = `Tu es un assistant qui résume des conversations WhatsApp. Réponds UNIQUEMENT avec le résumé, sans explication, sans raisonnement, sans préambule.

Résume cette conversation du groupe "${groupName}".

Règles STRICTES :
- Réponds DIRECTEMENT avec le résumé, rien d'autre
- Mentionne QUI dit quoi (utilise les prénoms des auteurs)
- Résumé en français UNIQUEMENT, MAX 400 caractères
- Si des messages sont en tchèque ou autre langue étrangère, ajoute à la fin sur une nouvelle ligne le texte original le plus pertinent entre guillemets (max 1-2 phrases clés)
- Mets les mots-clés et sujets importants entre balises <b>gras</b> (format HTML)
- Sois concis, factuel, pas de mots coupés
- Ne commence PAS par "Le groupe...", "Les membres...", "Let me...", "Here is..."
- JAMAIS de texte en anglais

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

  // Strip any thinking tags or reasoning preamble from Claude
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
  text = text.replace(/^(Let me|Here is|I'll|The messages?)[\s\S]*?\n\n/i, '').trim();
  // Strip any non-Telegram HTML tags (keep only b, i, u, s, a, code, pre)
  text = text.replace(/<\/?(?!b>|\/b>|i>|\/i>|u>|\/u>)[a-z][^>]*>/gi, '');

  // Hard limit BEFORE wrapping in tags to avoid breaking HTML
  if (text.length > 500) text = text.slice(0, 497) + '...';

  // Wrap quoted foreign text in italics for Telegram HTML
  text = text.replace(/\n"([^"]+?)"\s*\.?\.?\.?$/s, (m, inner) => `\n<i>"${inner}"</i>`);

  // Safety: ensure no orphan opening tags
  const openI = (text.match(/<i>/g) || []).length;
  const closeI = (text.match(/<\/i>/g) || []).length;
  if (openI > closeI) text += '</i>'.repeat(openI - closeI);
  const openB = (text.match(/<b>/g) || []).length;
  const closeB = (text.match(/<\/b>/g) || []).length;
  if (openB > closeB) text += '</b>'.repeat(openB - closeB);

  return text;
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
