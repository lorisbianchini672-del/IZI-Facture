// check-tables.js — Vérifie que les tables Supabase d'IZI existent
require('dotenv').config();
const u = process.env.SUPABASE_URL;
const k = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!u || !k) { console.log('Supabase non configuré'); process.exit(0); }

(async () => {
  const tables = ['profiles', 'sessions', 'invoices', 'settings', 'orders'];
  for (const t of tables) {
    try {
      const r = await fetch(`${u}/rest/v1/${t}?select=*&limit=1`, {
        headers: { apikey: k, Authorization: `Bearer ${k}` }
      });
      console.log(`${t}: HTTP ${r.status} → ${r.status < 300 ? '✅ table OK' : '❌ table absente / accès refusé'}`);
    } catch (e) {
      console.log(`${t}: ERR ${e.message}`);
    }
  }
})();