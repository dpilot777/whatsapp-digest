const fs = require('fs');
const path = require('path');

const CATEGORY_ORDER = [
  'Air France',
  'Famille',
  'Provinciaux',
  'Amis',
  'École',
  'Patinage',
];

function parseConfig(filePath) {
  const content = fs.readFileSync(filePath || path.join(__dirname, 'whatsapp_config.txt'), 'utf-8');
  const lines = content.split('\n');

  let currentCategory = null;
  const groups = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect category header
    const catMatch = trimmed.match(/^#\s+CATEGORIE\s*:\s*(.+?)(\s+[🔵🟠🟡🟤🟢⚪])?$/u);
    if (catMatch) {
      currentCategory = catMatch[1].trim();
      continue;
    }

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse group line: NAME | CHAT_ID | OPTIONS
    const parts = trimmed.split('|').map(p => p.trim());
    if (parts.length < 2) continue;

    const name = parts[0];
    const chatId = parts[1];
    const options = parts[2] || '';

    const surveiller = /SURVEILLER=OUI/i.test(options);

    if (surveiller && currentCategory) {
      groups.push({ name, chatId, category: currentCategory });
    }
  }

  return groups;
}

function getGroupsByCategory(groups) {
  const byCategory = {};
  for (const g of groups) {
    if (!byCategory[g.category]) byCategory[g.category] = [];
    byCategory[g.category].push(g);
  }

  // Return ordered by CATEGORY_ORDER
  const ordered = [];
  for (const cat of CATEGORY_ORDER) {
    if (byCategory[cat]) {
      ordered.push({ category: cat, groups: byCategory[cat] });
    }
  }
  // Add any remaining categories not in CATEGORY_ORDER
  for (const cat of Object.keys(byCategory)) {
    if (!CATEGORY_ORDER.includes(cat)) {
      ordered.push({ category: cat, groups: byCategory[cat] });
    }
  }

  return ordered;
}

function getChatIdSet(groups) {
  return new Set(groups.map(g => g.chatId));
}

module.exports = { parseConfig, getGroupsByCategory, getChatIdSet, CATEGORY_ORDER };
