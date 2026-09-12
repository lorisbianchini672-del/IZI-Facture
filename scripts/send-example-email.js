// ============================================================
// send-example-email.js — Envoi d'un email d'exemple IZI
// ------------------------------------------------------------
// Usage : node scripts/send-example-email.js
// Envoie une facture d'exemple au format IZI vers MAIL_FROM.
// ============================================================
require('dotenv').config();
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || '587';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
  console.error('❌ SMTP non configuré — ajoutez SMTP_HOST, SMTP_USER, SMTP_PASSWORD dans .env');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASSWORD }
});

const invoiceNumber = 'FAC-2026-001';
const client = 'Exemple SARL';
const issueDate = '11/09/2026';
const dueDate = '11/10/2026';
const totalHT = '1 000,00 €';
const totalTVA = '200,00 €';
const totalTTC = '1 200,00 €';

(async () => {
  try {
    await transporter.sendMail({
      from: `"IZI" <${MAIL_FROM}>`,
      to: MAIL_FROM,
      subject: `Votre facture ${invoiceNumber} — IZI SAS (exemple)`,
      text: `Madame, Monsieur ${client},

Veuillez trouver ci-joint votre facture ${invoiceNumber} (email d'exemple).
Date d'émission : ${issueDate}
Date d'échéance : ${dueDate}
Total HT : ${totalHT}
TVA : ${totalTVA}
Total TTC : ${totalTTC}

Nous restons à votre disposition pour toute information complémentaire.

Cordialement,
IZI SAS`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;border:1px solid #e2e6ef;border-radius:14px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#4c1d95,#7c3aed 65%,#9333ea);padding:22px;text-align:center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:#ffffff;border-radius:10px;width:46px;height:46px;text-align:center;vertical-align:middle"><span style="color:#4c1d95;font-size:17px;font-weight:800;letter-spacing:1px">IZI</span></td></tr></table>
          <div style="color:#ede9fe;font-size:12px;margin-top:10px;letter-spacing:2px">FACTURATION PROFESSIONNELLE</div>
        </div>
        <div style="padding:26px">
          <h1 style="font-size:18px;color:#172033;margin:0 0 12px">Votre facture ${invoiceNumber}</h1>
          <p style="font-size:15px;line-height:1.6">Madame, Monsieur ${client},</p>
          <p style="font-size:15px;line-height:1.6">Veuillez trouver ci-joint votre facture ${invoiceNumber} (email d'exemple).</p>
          <table style="width:100%;border-collapse:collapse;margin-top:14px">
            <tr><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;color:#6b7280">Date d'émission</td><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;font-weight:600">${issueDate}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;color:#6b7280">Date d'échéance</td><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;font-weight:600">${dueDate}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;color:#6b7280">Total HT</td><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;font-weight:600">${totalHT}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;color:#6b7280">TVA</td><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;font-weight:600">${totalTVA}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;font-weight:700">Total TTC</td><td style="padding:8px;border:1px solid #e2e6ef;font-size:13px;font-weight:700;color:#7c3aed">${totalTTC}</td></tr>
          </table>
          <p style="font-size:15px;line-height:1.6;margin-top:16px">Nous restons à votre disposition pour toute information complémentaire.</p>
          <p style="font-size:15px">Cordialement,<br><strong>IZI SAS</strong></p>
          <p style="font-size:11px;color:#6b7280;border-top:1px solid #e2e6ef;padding-top:12px;margin-top:18px">Cet email de démonstration et sa pièce jointe sont destinés exclusivement à leur destinataire. © 2026 IZI SAS — contact@izifacture.fr</p>
        </div>
      </div>`
    });
    console.log(`✅ Email d'exemple envoyé à ${MAIL_FROM} (sujet : « Votre facture ${invoiceNumber} — IZI SAS (exemple) »)`);
  } catch (error) {
    console.error(`❌ Échec de l'envoi : ${error.message}`);
    process.exit(1);
  }
})();