// ============================================================
// check-setup.js — Diagnostic de configuration d'IZI
// ------------------------------------------------------------
// Vérifie : variables d'environnement, connexion Supabase,
// configuration SMTP (envoi réel d'un email de test),
// et présence de la clé Stripe.
//
// Usage :  node scripts/check-setup.js
// ============================================================
require('dotenv').config();
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || '587';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const MAIL_FROM = process.env.MAIL_FROM;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

function status(label, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${label} : ${detail}`);
  return ok;
}

(async () => {
  console.log('=== Diagnostic de configuration IZI ===\n');

  let allOk = true;

  // 1. Base de données
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY }
      });
      const ok = response.status === 200;
      allOk = status('Supabase', ok, ok ? 'connexion API OK' : `HTTP ${response.status}`) && allOk;
    } catch (error) {
      allOk = status('Supabase', false, error.message) && allOk;
    }
  } else {
    allOk = status('Supabase', false, 'non configuré — ajoutez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans .env (mode fichiers locaux actif)') && allOk;
  }

  // 2. Stripe (présence de la clé uniquement — le test réel dépend de l'admin)
  const stripeOk = STRIPE_SECRET_KEY.startsWith('sk_');
  allOk = status('Stripe', stripeOk, stripeOk ? 'clé secrète présente' : 'clé STRIPE_SECRET_KEY absente ou invalide (à configurer)') && allOk;

  // 3. SMTP — envoi d'un email de test vers MAIL_FROM
  if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
    });
    try {
      await transporter.sendMail({
        from: MAIL_FROM || SMTP_USER,
        to: MAIL_FROM || SMTP_USER,
        subject: 'IZI — Test de configuration SMTP',
        text: 'Si vous recevez cet email, la configuration SMTP d\'IZI fonctionne correctement.'
      });
      allOk = status('SMTP', true, `email de test envoyé à ${MAIL_FROM || SMTP_USER}`) && allOk;
    } catch (error) {
      allOk = status('SMTP', false, `échec de l'envoi : ${error.message}`) && allOk;
    }
  } else {
    allOk = status('SMTP', false, 'non configuré — ajoutez SMTP_HOST, SMTP_USER, SMTP_PASSWORD dans .env') && allOk;
  }

  console.log(`\n=== Résultat : ${allOk ? 'tout est prêt ✅' : 'des éléments restent à configurer, voir ci-dessus'}`);
  process.exit(allOk ? 0 : 1);
})();