// NEXUS browser configuration example (public values only)
//
// The published index.html intentionally does NOT load keys.js. Configure the
// relay URL and Supabase anon public key on the CLOUD page instead. These are
// addresses/public identifiers, not provider or service-role credentials.
//
// Secrets belong only in server/.env on the host:
//   SUPABASE_SERVICE_ROLE_KEY
//   TWELVEDATA_KEYS
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_*_CHAT
//
// Never add Twelve Data keys, Telegram bot tokens, private chat IDs, or a
// Supabase service-role key to frontend files, build artifacts, or localStorage.

// Example public values for documentation only; not loaded by the app.
window.NEXUS_API_URL = "https://your-nexus-api.example.com";
window.NEXUS_SB_URL = "https://your-project.supabase.co";
window.NEXUS_SB_ANON = "<public-anon-key>";
