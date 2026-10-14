// ═══════════════════════════════════════════════════════════
// keys.example.js — template for NEXUS optional permanent keys
//
// NORMAL PATH (recommended): use the ten 🔑 key slots in the app
// and press "SAVE ALL KEYS" — they persist in your browser's
// localStorage only, rotate automatically, cool down on quota,
// and never touch this repository.
//
// This file is only for OPTIONAL permanent keys:
//   1. Copy this file to:  keys.js
//   2. Put your keys between the quotes below (up to 10).
//   3. keys.js is gitignored — it will NOT be committed, and the
//      Pages deploy refuses to publish if it ever appears.
//
// ⚠ SECURITY: this repository is PUBLIC. Never commit keys.js.
// ═══════════════════════════════════════════════════════════

// Twelve Data market-data keys (0–10 — merged with browser slots, auto-rotating)
window.NEXUS_KEYS = [
  "", // Twelve Data key 1
  "", // key 2 (optional — auto-rotates)
  "", // key 3 (optional)
  "", // key 4 (optional)
  "", // key 5 (optional)
  "", // key 6 (optional)
  "", // key 7 (optional)
  "", // key 8 (optional)
  "", // key 9 (optional)
  "", // key 10 (optional)
];

// Telegram bot (from @BotFather) — used for signal delivery
// Changing token/chat in the app revokes send authorization automatically.
window.NEXUS_TG_TOKEN = "";   // e.g. "123456789:AAH..."
window.NEXUS_TG_CHAT  = "";   // chat id (numeric) or "@yourchannel"
