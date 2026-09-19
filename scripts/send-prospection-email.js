// ============================================================
// send-prospection-email.js — Email de prospection IZI
// ------------------------------------------------------------
// Usage :
//   node scripts/send-prospection-email.js                  -> test vers SMTP_USER
//   node scripts/send-prospection-email.js a@b.fr c@d.fr    -> vers les adresses données
//   node scripts/send-prospection-email.js --dry-run        -> affiche sans envoyer
//
// Identifiants lus dans .env (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).
// Aucun secret n'est écrit en dur dans ce fichier.
// ============================================================
require('dotenv').config();
const nodemailer = require('nodemailer');

// ---- Configuration ----
const SITE_URL = process.env.PROSPECTION_SITE_URL || 'https://51.158.106.168.nip.io';
const CONTACT_EMAIL = process.env.PROSPECTION_CONTACT || 'izifacture@gmail.com';
// Adresse de réponse (Reply-To). Doit impérativement être une boîte RÉELLE :
// izifacture.fr n'a aucun enregistrement MX aujourd'hui, donc les réponses à
// une adresse @izifacture.fr rebondissent. On utilise donc l'adresse Gmail de
// l'entreprise (izifacture@gmail.com), qui est bien relevée.
const REPLY_TO = process.env.PROSPECTION_REPLY_TO || CONTACT_EMAIL;
// Gmail réécrit l'expéditeur s'il diffère du compte authentifié : on utilise
// donc SMTP_USER par défaut. Définir EMAIL_FROM dans .env une fois une adresse
// professionnelle vérifiée (Gmail « Envoyer en tant que » ou Brevo/OVH).
const FROM = process.env.EMAIL_FROM || process.env.SMTP_USER;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const recipients = args.filter((a) => !a.startsWith('--'));
if (!recipients.length) recipients.push(SMTP_USER);

const SUBJECT = 'Facture électronique 2026 : votre entreprise est-elle prête ?';

const PREHEADER =
  'Recevoir et émettre des factures électroniques deviendra obligatoire. IZI vous met en conformité en quelques minutes.';

const TEXT = `Madame, Monsieur,

À partir du 1er septembre 2026, toutes les entreprises françaises devront
pouvoir recevoir des factures électroniques. L'obligation d'émission suivra,
en 2027 pour les grandes entreprises, puis en 2028 pour les TPE et PME.

Le calendrier officiel :
  • 2026 — réception des factures, pour toutes les entreprises
  • 2027 — émission, pour les grandes entreprises
  • 2028 — émission, pour les TPE et PME

IZI est une solution française de facturation conçue pour cette échéance,
sans complexité :
  • Devis et factures professionnels en quelques clics
  • Conformité Factur-X 2026 intégrée, sans logiciel supplémentaire
  • Calcul automatique de la TVA (20 %, 10 %, 5,5 %, 0 %)
  • Export FEC transmis directement à votre expert-comptable
  • Tableau de bord, suivi des paiements et relances clients

La mise en place prend quelques minutes : aucune installation, aucun engagement.

Créer mon espace : ${SITE_URL}/auth.html

Nous accompagnons des entreprises partout en France dans leur mise en
conformité. Si vous préférez être guidé, répondez simplement à cet email :
nous fixerons un créneau ensemble.

Bien cordialement,

L'équipe IZI
${CONTACT_EMAIL}

--
Vous recevez ce message à titre professionnel. Pour ne plus recevoir nos
informations, répondez à cet email avec le mot « STOP » : votre adresse sera
retirée immédiatement.

IZI SAS — Paris`;

const HTML = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f4f2fb">
<span style="display:none!important;font-size:1px;color:#f4f2fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${PREHEADER}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f2fb">
<tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e9e4f7;border-radius:18px;overflow:hidden;font-family:'Segoe UI',Roboto,Arial,Helvetica,sans-serif">
    <tr><td style="background:#4c1d95;background-image:linear-gradient(135deg,#4c1d95,#7c3aed 60%,#a855f7);padding:34px 28px 30px;text-align:center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
        <td width="56" height="56" style="width:56px;height:56px;background:#ffffff;border-radius:14px;text-align:center;vertical-align:middle;font-size:20px;font-weight:800;color:#6d28d9;letter-spacing:1px">IZI</td>
      </tr></table>
      <div style="color:#ffffff;font-size:17px;font-weight:700;margin-top:14px;letter-spacing:.3px">Votre facturation, simplifi&eacute;e</div>
      <div style="color:#e9d5ff;font-size:10px;margin-top:7px;letter-spacing:2.6px;text-transform:uppercase">Logiciel de facturation fran&ccedil;ais</div>
    </td></tr>
    <tr><td style="padding:32px 32px 30px">
      <div style="display:inline-block;background:#f3e8ff;color:#6d28d9;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;border-radius:20px;padding:6px 14px;margin-bottom:18px">&Eacute;ch&eacute;ance 2026</div>
      <h1 style="font-size:23px;line-height:1.3;color:#172033;margin:0 0 16px;font-weight:800">Votre facturation est-elle pr&ecirc;te pour 2026&nbsp;?</h1>
      <p style="font-size:15px;line-height:1.7;color:#3f4a5a;margin:0 0 16px">Madame, Monsieur,</p>
      <p style="font-size:15px;line-height:1.7;color:#3f4a5a;margin:0 0 22px">&Agrave; partir du <strong>1<sup>er</sup> septembre 2026</strong>, toutes les entreprises fran&ccedil;aises devront pouvoir <strong>recevoir des factures &eacute;lectroniques</strong>. L'obligation d'&eacute;mission suivra, en 2027 puis en 2028, selon la taille de l'entreprise.</p>
      <div style="font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#7c3aed;margin:0 0 10px">Le calendrier officiel</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">
        <tr>
          <td width="33%" valign="top" style="padding:0 5px 0 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background-color:#f3e8ff;border:1px solid #e9d5ff;border-radius:12px;padding:14px 12px;text-align:center">
                <div style="font-size:16px;font-weight:800;color:#6d28d9">2026</div>
                <div style="font-size:11px;line-height:1.5;color:#4b5563;margin-top:5px">R&eacute;ception<br>pour tous</div>
              </td></tr>
            </table>
          </td>
          <td width="33%" valign="top" style="padding:0 5px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background-color:#f3e8ff;border:1px solid #e9d5ff;border-radius:12px;padding:14px 12px;text-align:center">
                <div style="font-size:16px;font-weight:800;color:#6d28d9">2027</div>
                <div style="font-size:11px;line-height:1.5;color:#4b5563;margin-top:5px">&Eacute;mission<br>grandes entreprises</div>
              </td></tr>
            </table>
          </td>
          <td width="33%" valign="top" style="padding:0 0 0 5px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background-color:#f3e8ff;border:1px solid #e9d5ff;border-radius:12px;padding:14px 12px;text-align:center">
                <div style="font-size:16px;font-weight:800;color:#6d28d9">2028</div>
                <div style="font-size:11px;line-height:1.5;color:#4b5563;margin-top:5px">&Eacute;mission<br>TPE et PME</div>
              </td></tr>
            </table>
          </td>
        </tr>
      </table>
      <div style="font-size:15px;font-weight:700;color:#172033;margin:0 0 14px">IZI r&eacute;pond &agrave; cette &eacute;ch&eacute;ance, sans complexit&eacute;&nbsp;:</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:1.6;color:#3f4a5a">
        <tr><td width="26" valign="top" style="padding:0 10px 12px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="20" height="20" style="width:20px;height:20px;background:#ede9fe;border-radius:50%;text-align:center;vertical-align:middle;font-size:12px;color:#6d28d9;font-weight:700">&#10003;</td></tr></table></td><td valign="top" style="padding-bottom:12px">Devis et factures professionnels en quelques clics</td></tr>
        <tr><td width="26" valign="top" style="padding:0 10px 12px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="20" height="20" style="width:20px;height:20px;background:#ede9fe;border-radius:50%;text-align:center;vertical-align:middle;font-size:12px;color:#6d28d9;font-weight:700">&#10003;</td></tr></table></td><td valign="top" style="padding-bottom:12px">Conformit&eacute; <strong>Factur-X 2026</strong> int&eacute;gr&eacute;e, sans logiciel suppl&eacute;mentaire</td></tr>
        <tr><td width="26" valign="top" style="padding:0 10px 12px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="20" height="20" style="width:20px;height:20px;background:#ede9fe;border-radius:50%;text-align:center;vertical-align:middle;font-size:12px;color:#6d28d9;font-weight:700">&#10003;</td></tr></table></td><td valign="top" style="padding-bottom:12px">Calcul automatique de la TVA (20&nbsp;%, 10&nbsp;%, 5,5&nbsp;%, 0&nbsp;%)</td></tr>
        <tr><td width="26" valign="top" style="padding:0 10px 12px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="20" height="20" style="width:20px;height:20px;background:#ede9fe;border-radius:50%;text-align:center;vertical-align:middle;font-size:12px;color:#6d28d9;font-weight:700">&#10003;</td></tr></table></td><td valign="top" style="padding-bottom:12px">Export FEC transmis directement &agrave; votre expert-comptable</td></tr>
        <tr><td width="26" valign="top" style="padding:0 10px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="20" height="20" style="width:20px;height:20px;background:#ede9fe;border-radius:50%;text-align:center;vertical-align:middle;font-size:12px;color:#6d28d9;font-weight:700">&#10003;</td></tr></table></td><td valign="top">Tableau de bord, suivi des paiements et relances clients</td></tr>
      </table>

      <p style="font-size:15px;line-height:1.7;color:#3f4a5a;margin:22px 0 0">La mise en place prend quelques minutes&nbsp;: aucune installation, aucun engagement.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 4px">
        <tr><td align="center">
          <a href="${SITE_URL}/auth.html" style="display:inline-block;background-color:#5b21b6;background-image:linear-gradient(135deg,#5b21b6,#7c3aed);color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;padding:15px 34px;font-size:15px;letter-spacing:.2px">Cr&eacute;er mon espace</a>
        </td></tr>
      </table>

      <p style="font-size:15px;line-height:1.7;color:#3f4a5a;margin:20px 0 0">Nous accompagnons des entreprises partout en France dans leur mise en conformit&eacute;. Si vous pr&eacute;f&eacute;rez &ecirc;tre guid&eacute;, r&eacute;pondez simplement &agrave; cet email&nbsp;: nous fixerons un cr&eacute;neau ensemble.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">
        <tr><td style="border-top:1px solid #e9e4f7;padding-top:20px">
          <p style="font-size:15px;line-height:1.7;color:#172033;margin:0">Bien cordialement,<br><strong>L'&eacute;quipe IZI</strong><br><a href="mailto:${CONTACT_EMAIL}" style="color:#7c3aed;text-decoration:none">${CONTACT_EMAIL}</a></p>
        </td></tr>
      </table>
      </td>
    </tr>
    <tr>
      <td style="background-color:#172033;color:#cbd5e1;text-align:center;padding:18px 22px;font-size:11px;line-height:1.7">
        &copy; 2026 IZI SAS &mdash; Paris<br>
        Vous recevez ce message &agrave; titre professionnel.<br>
        Pour ne plus recevoir nos informations, r&eacute;pondez &agrave; cet email avec le mot &laquo;&nbsp;STOP&nbsp;&raquo;&nbsp;: votre adresse sera retir&eacute;e imm&eacute;diatement.
      </td>
    </tr>
  </table>
</td>
</tr>
</table>
</body>
</html>`;

module.exports = { SUBJECT, PREHEADER, TEXT, HTML };
if (require.main === module) {
  (async () => {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
      console.error('❌ SMTP non configuré : SMTP_HOST, SMTP_USER et SMTP_PASSWORD sont requis dans .env');
      process.exit(1);
    }

    if (dryRun) {
      console.log(`Destinataires : ${recipients.join(', ')}`);
      console.log(`De        : IZI <${FROM}>`);
      console.log(`Répondre à: ${REPLY_TO}${REPLY_TO !== CONTACT_EMAIL ? ' (affiché dans l\'email : ' + CONTACT_EMAIL + ')' : ''}`);
      console.log(`Objet     : ${SUBJECT}`);
      console.log(`Lien      : ${SITE_URL}/auth.html`);
      console.log('\n----- VERSION TEXTE -----\n' + TEXT);
      const preview = require('node:path').join(require('node:os').tmpdir(), 'izi-prospection-preview.html');
      require('node:fs').writeFileSync(preview, HTML, 'utf8');
      console.log(`\nAperçu HTML écrit dans : ${preview}`);
      console.log('(dry-run : aucun email envoyé)');
      process.exit(0);
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
    });

    const results = [];
    for (const to of recipients) {
      try {
        const info = await transporter.sendMail({
          from: `"IZI" <${FROM}>`,
          to,
          replyTo: REPLY_TO,
          subject: SUBJECT,
          text: TEXT,
          html: HTML
        });
        results.push({ to, ok: true });
        console.log(`✅ Envoyé à ${to} — ${info.messageId}`);
      } catch (error) {
        results.push({ to, ok: false });
        console.error(`❌ Échec pour ${to} : ${error.message}`);
      }
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\nBilan : ${results.length - failed.length}/${results.length} envoyé(s).`);
    process.exit(failed.length ? 1 : 0);
  })();
}