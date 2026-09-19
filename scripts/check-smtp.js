// Vérification manuelle de la configuration SMTP (non exécutée par `npm test`) :
//   node scripts/check-smtp.js        (ou `npm run check:smtp`)
// Contrôle la présence des variables, la cohérence entre le compte
// d'authentification (SMTP_USER) et l'expéditeur affiché (MAIL_FROM), puis
// ouvre la session SMTP réelle (transporter.verify()).
// Aucun email n'est envoyé et aucun secret n'est affiché (maskSecret).
const nodemailer = require('nodemailer');
const env = require('../lib/env');

const SMTP_HOST = env.get('SMTP_HOST');
const SMTP_PORT = Number(env.get('SMTP_PORT') || 587);
const SMTP_USER = env.get('SMTP_USER');
const SMTP_PASSWORD = env.get('SMTP_PASSWORD');
const MAIL_FROM = env.get('MAIL_FROM') || SMTP_USER;

// Gmail réécrit l'expéditeur si l'adresse n'est pas un alias vérifié du compte.
function warnOnFromMismatch() {
  if (!SMTP_HOST.endsWith('gmail.com')) return;
  if (!MAIL_FROM || MAIL_FROM === SMTP_USER) return;
  console.warn(`⚠ MAIL_FROM (${MAIL_FROM}) diffère du compte SMTP (${SMTP_USER}).`);
  console.warn('  Gmail exige que cette adresse soit un alias vérifié du compte :');
  console.warn('  Paramètres Gmail → Comptes → « Envoyer des emails en tant que ».');
  console.warn('  Sinon les envois sont refusés (550 5.7.1 From address not authorized).');
}

async function main() {
  console.log('Hôte             :', SMTP_HOST || '(absent)');
  console.log('Port             :', SMTP_PORT);
  console.log('Compte SMTP      :', SMTP_USER || '(absent)');
  console.log('Mot de passe     :', env.maskSecret(SMTP_PASSWORD));
  console.log('Expéditeur       :', MAIL_FROM || '(absent)');

  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']
    .filter(name => env.isPlaceholder(env.get(name)));
  if (missing.length > 0) {
    throw new Error(`configuration incomplète : ${missing.join(', ')}`);
  }

  warnOnFromMismatch();

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
  });

  await transporter.verify();
  console.log('✅ Authentification SMTP réussie : les emails peuvent être envoyés.');
}

main().catch(error => {
  console.error('❌ Vérification SMTP échouée :', error.code || '', error.response || error.message);
  process.exitCode = 1;
});
