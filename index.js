// Point d'entrée Vercel — expose simplement l'application Express.
// La configuration Supabase se fait via les variables d'environnement
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) — aucune clé en dur.
module.exports = require('./server.js');

