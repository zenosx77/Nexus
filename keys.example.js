// ═══════════════════════════════════════════════════════════
// keys.example.js — template for NEXUS permanent keys
//
// HOW TO USE:
//   1. Copy this file to:  keys.js
//   2. Put your keys between the quotes below.
//   3. keys.js is gitignored — it will NOT be committed.
//
// ⚠ SECURITY: this repository is PUBLIC. Never commit keys.js.
// ═══════════════════════════════════════════════════════════

// Twelve Data market-data keys (1 or more — auto-rotating)
window.NEXUS_KEYS = [
  "", // Twelve Data key 1
  "", // key 2 (optional — auto-rotates)
];

// Telegram bot (from @BotFather) — used for signal delivery
window.NEXUS_TG_TOKEN = "";   // e.g. "123456789:AAH..."
window.NEXUS_TG_CHAT  = "";   // chat id (numeric) or "@yourchannel"
