# WhatsApp Digest

Lit les messages de groupes WhatsApp et envoie un résumé quotidien sur Telegram via Claude API.

## Fonctionnalités

- Connexion WhatsApp via QR code (session persistante)
- Résumé automatique chaque soir à 19h00
- Résumé sur demande via la commande Telegram `/resume`
- Résumés par catégorie avec barres de progression
- Interprétation des images (description automatique via Claude vision)
- Longueur du résumé adaptée au volume de messages du groupe
- Filtrage du bruit (emojis seuls, "Ok", "👍", "😂")

## Installation

```bash
git clone https://github.com/dpilot777/whatsapp-digest.git
cd whatsapp-digest
npm install
```

## Configuration

1. Copier le fichier d'environnement :
```bash
cp .env.example .env
```

2. Remplir les variables dans `.env` :
   - `TELEGRAM_BOT_TOKEN` — token du bot Telegram (via @BotFather)
   - `TELEGRAM_CHAT_ID` — votre chat ID Telegram
   - `ANTHROPIC_API_KEY` — clé API Anthropic (Claude)

3. Modifier `whatsapp_config.txt` pour ajouter/retirer des groupes.

## Lancement

```bash
npm start
```

Au premier lancement, un QR code s'affiche dans le terminal. Scannez-le avec WhatsApp (Appareils associés). La session est ensuite persistante dans `.wwebjs_auth/`.

## Commandes Telegram

- `/resume` — génère et envoie immédiatement le résumé des messages accumulés

## Format du résumé

Les groupes sont regroupés par catégorie (Air France, Famille, Provinciaux, Amis, École, Patinage), triés par volume de messages décroissant, avec :
- Une barre de progression relative
- Un résumé textuel dont la longueur s'adapte au volume : 300 caractères (≤ 15 messages), 500 (≤ 40), 700 (≤ 100), 900 au-delà
- Les images sont décrites automatiquement (digest quotidien et `/resume`) ; le résumé 7 jours les laisse en `[Image]` pour limiter le coût

## Stack technique

- `whatsapp-web.js` + `qrcode-terminal` — connexion WhatsApp
- `node-cron` — planification quotidienne 19h
- `node-telegram-bot-api` — envoi Telegram + commande /resume
- `axios` — appels Claude API (claude-sonnet-4-6)
- `dotenv` — variables d'environnement
