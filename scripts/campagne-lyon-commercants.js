// ============================================================
// campagne-lyon-commercants.js — Campagne de prospection B2B
// par email professionnel, ciblant les commerçants de Lyon.
// ------------------------------------------------------------
// Usage :
//   node scripts/campagne-lyon-commercants.js --list       -> liste des contacts retenus
//   node scripts/campagne-lyon-commercants.js              -> aperçu du message, aucun envoi
//   node scripts/campagne-lyon-commercants.js --test       -> envoi de contrôle vers SMTP_USER
//   node scripts/campagne-lyon-commercants.js --send --limit 10 -> envoi réel aux 10 premiers
//   --send exige toujours --limit N ; sans option, aucun envoi.
//
// Fichiers :
//   data/prospection/contacts-lyon.csv   -> contacts (commerce,contact,email)
//   data/prospection/opt-out.txt         -> adresses à ne jamais soliciter (demandes « STOP »)
//   data/prospection/envoyes-lyon.csv    -> journal des envois réussis (anti-doublon)
//   data/prospection/erreurs-lyon.csv    -> journal des échecs SMTP
//
// Identifiants SMTP lus dans .env (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).
// Aucun secret n'est écrit en dur dans ce fichier.
// ============================================================
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

// ---- Configuration ----
const ROOT = path.join(__dirname, '..');
const PROSP_DIR = path.join(ROOT, 'data', 'prospection');
const CONTACTS_CSV = path.join(PROSP_DIR, 'contacts-lyon.csv');
const OPTOUT_TXT = path.join(PROSP_DIR, 'opt-out.txt');
const SENT_CSV = path.join(PROSP_DIR, 'envoyes-lyon.csv');
const ERRORS_CSV = path.join(PROSP_DIR, 'erreurs-lyon.csv');

const SITE_URL = process.env.PROSPECTION_SITE_URL || 'https://51.158.106.168.nip.io';
const CONTACT_EMAIL = process.env.PROSPECTION_CONTACT || 'izifacturation@gmail.com';
const REPLY_TO = process.env.PROSPECTION_REPLY_TO || CONTACT_EMAIL;
const FROM = process.env.EMAIL_FROM || process.env.SMTP_USER;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

// Débit d'envoi ; vérifier séparément les quotas du fournisseur.
const BATCH_SIZE = Number(process.env.CAMPAGNE_BATCH_SIZE || 30);
const DELAY_MS = Number(process.env.CAMPAGNE_DELAY_MS || 3000);
const PAUSE_MS = Number(process.env.CAMPAGNE_PAUSE_MS || 60000);

const SUBJECT = 'Présentation IZI : devis et factures pour votre commerce';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---- Arguments ----
const MODES = ['--list', '--dry-run', '--test', '--send'];
function parseArgs(argv = []) {
  let mode = null;
  let limit = null;
  for (let i = 0; i < argv.length; i++) {
    if (MODES.includes(argv[i])) {
      if (mode) throw new Error('Un seul mode autorisé.');
      mode = argv[i];
    } else if (argv[i] === '--limit') {
      if (limit !== null || !/^[1-9]\d*$/.test(argv[i + 1] || '')) throw new Error('--limit attend un entier positif unique.');
      limit = Number(argv[++i]);
      if (!Number.isSafeInteger(limit)) throw new Error('--limit trop élevé.');
    } else throw new Error(`Argument inconnu : ${argv[i]}`);
  }
  if (mode === '--send' && limit === null) throw new Error('--send exige --limit N pour borner la campagne.');
  return { mode: mode || '--dry-run', limit };
}
const isEmail = (value) => typeof value === 'string'
  && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(value)
  && !/\.(invalid|test|example|localhost)$/i.test(value)
  && !/@(?:[^@]+\.)?example\.(com|net|org)$/i.test(value);

// ---- Utilitaires ----
const escapeHtml = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  .replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function parseCsvLine(line, delim) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseContacts() {
  const lines = readLines(CONTACTS_CSV)
    .filter((l) => !l.startsWith('#'))
    .filter((l) => !(/^commerce\b/i.test(l) && /email/i.test(l))); // en-tête
  if (!lines.length) return [];
  const delim = ((lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length) ? ';' : ',';
  return lines
    .map((l) => parseCsvLine(l, delim))
    .filter((c) => c.length >= 3 && c[2])
    .map((c) => ({ commerce: c[0] || '', contact: c[1] || '', email: c[2].trim().toLowerCase() }));
}

function loadTargets() {
  const optOut = new Set(readLines(OPTOUT_TXT).filter((l) => EMAIL_RE.test(l)).map((l) => l.toLowerCase()));
  const sent = new Set(readLines(SENT_CSV)
    .map((l) => (parseCsvLine(l, ',')[1] || '').trim().toLowerCase())
    .filter((e) => isEmail(e)));
  const stats = { total: 0, valid: 0, optOut: 0, already: 0 };
  const seen = new Set();
  const targets = [];
  for (const c of parseContacts()) {
    stats.total++;
    if (!isEmail(c.email)) continue;
    stats.valid++;
    if (optOut.has(c.email)) { stats.optOut++; continue; }
    if (sent.has(c.email)) { stats.already++; continue; }
    if (seen.has(c.email)) continue;
    seen.add(c.email);
    targets.push(c);
  }
  return { targets, stats };
}

function buildText({ commerce, contact }) {
  const commerceLabel = commerce || 'votre commerce';
  return `${contact ? `Bonjour ${contact},` : 'Bonjour,'}

Gérer devis et factures demande du temps — du temps qui n'est pas consacré à ${commerceLabel}.

IZI est un outil simple, pensé pour les commerces :
  • Devis et factures professionnels en quelques clics
  • Calcul automatique de la TVA (20 %, 10 %, 5,5 %, 0 %)
  • Suivi des paiements et relances depuis un tableau de bord clair

Je vous propose un échange de 15 minutes, sans engagement, pour voir ce que
IZI peut apporter à votre activité : répondez à cet email avec vos
disponibilités, je m'adapte.

Découvrir IZI : ${SITE_URL}

Bien cordialement,

${process.env.PROSPECTION_SENDER_NAME || "L'équipe IZI"}
${CONTACT_EMAIL}

--
Vous recevez ce message dans le cadre de votre activité professionnelle.
Pour ne plus recevoir de sollicitation, répondez « STOP » à cet email :
votre adresse sera retirée immédiatement de nos listes.${process.env.PROSPECTION_PRIVACY_URL ? `\nInformations sur vos données : ${process.env.PROSPECTION_PRIVACY_URL}` : ''}`;
}

function buildHtml({ commerce, contact }) {
  const commerceLabel = escapeHtml(commerce || 'votre commerce');
  const greeting = contact ? `Bonjour ${escapeHtml(contact)},` : 'Bonjour,';
  const sender = escapeHtml(process.env.PROSPECTION_SENDER_NAME || "L'équipe IZI");
  const siteHref = SITE_URL.replace(/["'<>\\]/g, '');
  const privacyHref = (process.env.PROSPECTION_PRIVACY_URL || '').replace(/["'<>\\]/g, '');
  const contactHref = CONTACT_EMAIL.replace(/["'<>\\]/g, '');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${SUBJECT}</title></head>
<body style="margin:0;padding:0;background-color:#f4f2fa">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f2fa;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
  <tr><td style="background-color:#5b21b6;background-image:linear-gradient(135deg,#5b21b6,#7c3aed);padding:24px 30px">
    <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px">IZI</span>
    <span style="color:#e9d5ff;font-size:13px;margin-left:8px">Devis &amp; factures</span>
  </td></tr>
  <tr><td style="padding:30px 30px 8px">
    <p style="font-size:15px;line-height:1.7;color:#172033;margin:0 0 14px">${greeting}</p>
    <p style="font-size:15px;line-height:1.7;color:#3f4a5a;margin:0 0 16px">G&eacute;rer devis et factures demande du temps &mdash; du temps qui n'est pas consacr&eacute; &agrave; <strong>${commerceLabel}</strong>. IZI est un outil simple, pens&eacute; pour les commerces&nbsp;:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f2ff;border-radius:10px;margin:0 0 18px">
      <tr><td style="padding:16px 20px;font-size:14px;line-height:1.9;color:#3f4a5a">
        <span style="color:#7c3aed;font-weight:700">&bull;</span>&nbsp; Devis et factures professionnels en quelques clics<br>
        <span style="color:#7c3aed;font-weight:700">&bull;</span>&nbsp; Calcul automatique de la TVA (20&nbsp;%, 10&nbsp;%, 5,5&nbsp;%, 0&nbsp;%)<br>
        <span style="color:#7c3aed;font-weight:700">&bull;</span>&nbsp; Suivi des paiements et relances depuis un tableau de bord clair
      </td></tr>
    </table>
    <p style="font-size:15px;line-height:1.7;color:#3f4a5a;margin:0 0 22px">Je vous propose un &eacute;change de 15&nbsp;minutes, sans engagement, pour voir ce que IZI peut apporter &agrave; votre activit&eacute;&nbsp;: r&eacute;pondez simplement &agrave; cet email avec vos disponibilit&eacute;s, je m'adapte.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
      <a href="${siteHref}" style="display:inline-block;background-color:#5b21b6;background-image:linear-gradient(135deg,#5b21b6,#7c3aed);color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;padding:14px 32px;font-size:15px;letter-spacing:.2px">D&eacute;couvrir IZI</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:10px 30px 26px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e9e4f7"><tr><td style="padding-top:18px">
      <p style="font-size:15px;line-height:1.7;color:#172033;margin:0">Bien cordialement,<br><strong>${sender}</strong><br><a href="mailto:${contactHref}" style="color:#7c3aed;text-decoration:none">${contactHref}</a></p>
    </td></tr></table>
  </td></tr>
  <tr><td style="background-color:#172033;color:#cbd5e1;text-align:center;padding:16px 22px;font-size:11px;line-height:1.7">
    Vous recevez ce message dans le cadre de votre activit&eacute; professionnelle.<br>
    Pour ne plus recevoir de sollicitation, r&eacute;pondez &laquo;&nbsp;STOP&nbsp;&raquo; &agrave; cet email&nbsp;: votre adresse sera retir&eacute;e imm&eacute;diatement de nos listes.<br>
    <a href="mailto:${contactHref}" style="color:#a78bfa;text-decoration:none">${contactHref}</a>${privacyHref ? ` &nbsp;&middot;&nbsp; <a href="${privacyHref}" style="color:#a78bfa;text-decoration:none">Donn&eacute;es personnelles</a>` : ''}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function appendCsv(file, fields) {
  if (fields.some((v) => /[\r\n]/.test(String(v)))) throw new Error('Journal : retour à la ligne interdit.');
  const line = fields.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
  fs.appendFileSync(file, line + '\n', { encoding: 'utf8', mode: 0o600 });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { targets, stats } = loadTargets();
  const selected = targets.slice(0, options.limit || targets.length);
  console.log(`Contacts : ${stats.total}, éligibles : ${targets.length}, oppositions : ${stats.optOut}, déjà envoyés : ${stats.already}.`);
  if (options.mode === '--list') {
    console.table(selected);
    return;
  }
  if (options.mode === '--dry-run') {
    const target = selected[0] || { commerce: 'votre commerce', contact: '' };
    const preview = path.join(require('node:os').tmpdir(), 'izi-campagne-preview.html');
    fs.writeFileSync(preview, buildHtml(target), 'utf8');
    console.log(`Objet : ${SUBJECT}\n\n${buildText(target)}`);
    console.log(`\nAperçu HTML (couleurs) : ${preview}`);
    console.log(`Simulation : ${selected.length} destinataire(s). Aucun email envoyé.`);
    return;
  }
  if (options.mode === '--send' && !selected.length) {
    console.log('Aucun contact éligible. Aucun email envoyé.');
    return;
  }
  const sending = options.mode === '--send' || options.mode === '--test';
  if (sending) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) throw new Error('Configuration SMTP manquante (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).');
    for (const address of [FROM, REPLY_TO, CONTACT_EMAIL, SMTP_USER]) {
      if (!isEmail(address)) throw new Error(`Adresse email invalide : ${address}`);
    }
    for (const [key, value] of [['PROSPECTION_SITE_URL', process.env.PROSPECTION_SITE_URL], ['PROSPECTION_PRIVACY_URL', process.env.PROSPECTION_PRIVACY_URL]]) {
      if (!value) throw new Error(`${key} requis dans .env (URL HTTPS).`);
      let url;
      try { url = new URL(value); } catch { throw new Error(`${key} : URL invalide.`); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${key} : URL HTTPS simple requise.`);
    }
    if (!process.env.PROSPECTION_SENDER_NAME?.trim()) throw new Error('PROSPECTION_SENDER_NAME requis dans .env (votre nom ou votre société).');
    // Un lien vers une adresse IP (nip.io) est un signal de spam fort : prévenir
    // sans bloquer, la campagne reste possible en phase de test.
    const siteHost = new URL(process.env.PROSPECTION_SITE_URL).hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(siteHost) || /\.nip\.io$/i.test(siteHost)) {
      console.warn(`⚠ PROSPECTION_SITE_URL (${process.env.PROSPECTION_SITE_URL}) est une adresse IP :`);
      console.warn('  Gmail et Outlook pénalisent fortement ce type de lien (risque de spam).');
      console.warn('  Utilisez le domaine après correction du DNS (SHARE.md, `npm run check:dns`).');
    }
    for (const [name, value] of Object.entries({ SMTP_PORT, BATCH_SIZE, DELAY_MS, PAUSE_MS })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error(`${name} invalide.`);
    }
  }
  fs.mkdirSync(PROSP_DIR, { recursive: true });
  const lock = path.join(PROSP_DIR, 'campagne.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  let transporter = null;
  try {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000
    });
    const pool = loadTargets().targets;
    const recipients = options.mode === '--test'
      ? [{ commerce: 'Commerce de contrôle', contact: '', email: SMTP_USER }]
      : pool.slice(0, options.limit || pool.length);
    let count = 0;
    for (const target of recipients) {
      // Prendre en compte les oppositions ajoutées pendant la campagne.
      if (options.mode === '--send' && readLines(OPTOUT_TXT).some((line) => line.toLowerCase() === target.email)) continue;
      let info;
      try {
        info = await transporter.sendMail({
          from: { name: process.env.PROSPECTION_SENDER_NAME, address: FROM },
          to: target.email, replyTo: REPLY_TO, subject: SUBJECT,
          text: buildText(target), html: buildHtml(target),
          headers: { 'List-Unsubscribe': `<mailto:${CONTACT_EMAIL}?subject=STOP>` }
        });
        if (!info.accepted?.length) throw new Error('Destinataire refusé par SMTP.');
      } catch (error) {
        const reason = String(error && error.message ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 200);
        appendCsv(ERRORS_CSV, [new Date().toISOString(), target.email, reason]);
        throw new Error(`Envoi interrompu pour ${target.email} : ${reason} — vérifier erreurs-lyon.csv avant toute reprise.`);
      }
      if (options.mode === '--send') appendCsv(SENT_CSV, [new Date().toISOString(), target.email, info.messageId || '']);
      console.log(`Accepté par SMTP : ${++count}/${recipients.length} (livraison non garantie).`);
      if (count < recipients.length) await sleep(count % BATCH_SIZE === 0 ? PAUSE_MS : DELAY_MS);
    }
  } finally {
    if (transporter) transporter.close();
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

module.exports = { parseCsvLine, parseContacts, loadTargets, parseArgs, buildText, buildHtml, isEmail };
if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});