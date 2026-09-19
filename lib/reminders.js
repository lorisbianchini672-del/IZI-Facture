// ============================================================
// lib/reminders.js — Module de relance des impayés
// ------------------------------------------------------------
// Escalade en trois niveaux selon le retard de paiement :
//   J+1   : relance courtoise (souvent un simple oubli)
//   J+7   : relance ferme, rappel des pénalités légales
//   J+15  : dernière relance avant mise en demeure
// Règles métier :
//   - une seule relance PAR NIVEAU et par facture (déduplication) ;
//   - seules les factures ENVOYEE / RETARD sont relançables ;
//   - jamais de relance pour une facture PAYEE ou BROUILLON.
// Le texte des emails est généré ici, côté serveur uniquement :
// aucune donnée client n'atteint le HTML sans échappement.
// ============================================================
const { badRequest } = require('./errors');
const { escapeHtml } = require('./validate');

/**
 * Niveaux de relance, du plus doux au plus ferme.
 * @type {readonly [{ level: string, minDaysLate: number, tone: string }]}
 */
const LEVELS = [
  { level: 'courtoise', minDaysLate: 1, tone: 'friendly' },
  { level: 'ferme', minDaysLate: 7, tone: 'firm' },
  { level: 'avant-mise-en-demeure', minDaysLate: 15, tone: 'final' }
];

/**
 * Détermine le niveau de relance applicable à un retard donné.
 * @param {number} daysLate jours de retard
 * @returns {{ level: string, minDaysLate: number, tone: string } | null}
 *   null si aucun niveau applicable (retard < 1 jour)
 */
function levelForDaysLate(days) {
  if (!Number.isFinite(days) || days < LEVELS[0].minDaysLate) return null;
  // On retient le niveau le plus sévère dont le seuil est atteint.
  let matched = null;
  for (const level of LEVELS) {
    if (days >= level.minDaysLate) matched = level;
  }
  return matched;
}

/**
 * Calcule le retard en jours calendaires entre la date d'échéance et aujourd'hui.
 * @param {string} dueDate date ISO « AAAA-MM-JJ »
 * @param {Date} [now] date de référence (tests)
 * @returns {number} jours de retard (0 si pas en retard, négatif si avant échéance)
 */
function daysLate(dueDate, now = new Date()) {
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.floor((today.getTime() - due.getTime()) / 86_400_000);
}

/**
 * Détermine si une facture est relançable et à quel niveau.
 * @param {{ status?: unknown, dueDate?: unknown }} invoice
 * @param {{ now?: Date, sent?: readonly string[] }} [context]
 *   sent : niveaux déjà envoyés pour cette facture (ex. ['courtoise'])
 * @returns {{ eligible: true, level: { level: string, minDaysLate: number, tone: string }, daysLate: number }
 *          | { eligible: false, reason: string }}
 */
function evaluateReminder(invoice, context = {}) {
  const { now = new Date(), sent = [] } = context;
  const status = String(invoice.status || '');
  if (status === 'PAYEE') return { eligible: false, reason: 'already_paid' };
  if (status !== 'ENVOYEE' && status !== 'RETARD') return { eligible: false, reason: 'draft' };

  const late = daysLate(String(invoice.dueDate || ''), now);
  if (late < 1) return { eligible: false, reason: 'not_due_yet' };

  const level = levelForDaysLate(late);
  if (!level) return { eligible: false, reason: 'not_due_yet' };
  // Déduplication : chaque niveau ne part qu'une fois.
  if (sent.includes(level.level)) return { eligible: false, reason: 'already_sent' };

  return { eligible: true, level, daysLate: late };
}

/**
 * Construit l'objet et le corps d'un email de relance (HTML échappé + texte brut).
 * @param {{ number: string, client: string, dueDate: string, totalTTC: string }} invoice
 * @param {{ level: { level: string, tone: string, minDaysLate: number }, daysLate: number }} evaluation
 * @param {{ companyName?: string, paymentUrl?: string }} [options]
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildReminderEmail(invoice, evaluation, options = {}) {
  const { number, client, dueDate, totalTTC } = invoice;
  const { level, daysLate: late } = evaluation;
  if (!number || !client || !dueDate || !totalTTC) {
    throw badRequest('Facture incomplète : numéro, client, échéance et montant TTC sont requis pour une relance.', 'REMINDER_MISSING_DATA');
  }
  const companyName = options.companyName || 'IZI SAS';
  const payUrl = typeof options.paymentUrl === 'string' ? options.paymentUrl.trim() : '';

  /** @type {Record<string, { subject: string, intro: string, closing: string }>} */
  const templates = {
    friendly: {
      subject: `Rappel : facture ${number} arrivée à échéance`,
      intro: `Sauf erreur de notre part, la facture ${number} arrivée à échéance le ${dueDate} semble ne pas encore être réglée.`,
      closing: 'Il s’agit probablement d’un simple oubli — merci de procéder au règlement dès que possible.'
    },
    firm: {
      subject: `Relance — facture ${number} en retard de ${late} jours`,
      intro: `Malgré notre précédent rappel, la facture ${number} d’un montant de ${totalTTC} reste impayée à ce jour (${late} jours de retard).`,
      closing: 'Nous vous rappelons que conformément à l’article L441-10 du Code de commerce, tout retard de paiement entraîne des pénalités au taux légal ainsi qu’une indemnité forfaitaire de 40 € pour frais de recouvrement.'
    },
    final: {
      subject: `Dernier rappel avant mise en demeure — facture ${number}`,
      intro: `La facture ${number} d’un montant de ${totalTTC} est impayée depuis ${late} jours, malgré nos relances précédentes.`,
      closing: 'Sans règlement sous 8 jours, nous engagerons une procédure de recouvrement avec mise en demeure formelle.'
    }
  };
  const template = templates[level.tone] || templates.friendly;

  const text = `Madame, Monsieur ${client},\n\n${template.intro}\n\n${template.closing}`
    + (payUrl ? `\n\nRégler en ligne : ${payUrl}` : '')
    + `\n\nCordialement,\n${companyName}`;

  // Le HTML n'embarque que des valeurs échappées ; le gabarit lui-même est du
  // code approuvé, les interpolations du gabarit sont ré-échappées après coup.
  const safe = value => escapeHtml(String(value ?? ''));
  const safeIntro = template.intro
    .replaceAll(number, safe(number))
    .replaceAll(String(late), safe(late))
    .replaceAll(dueDate, safe(dueDate))
    .replaceAll(totalTTC, safe(totalTTC));
  const safePay = payUrl ? safe(payUrl) : '';
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;border:1px solid #e2e6ef;border-radius:14px;overflow:hidden">
<div style="background:linear-gradient(135deg,#4c1d95,#7c3aed 65%,#9333ea);padding:22px;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:#ffffff;border-radius:10px;width:46px;height:46px;text-align:center;vertical-align:middle"><span style="color:#4c1d95;font-size:17px;font-weight:800;letter-spacing:1px">IZI</span></td></tr></table></div>
<div style="padding:26px">
<p style="font-size:15px;line-height:1.6">Madame, Monsieur ${safe(client)},</p>
<p style="font-size:15px;line-height:1.6">${safeIntro}</p>
<p style="font-size:15px;line-height:1.6">${safe(template.closing)}</p>
${safePay ? `<p style="margin:18px 0"><a href="${safePay}" style="display:inline-block;background:#4c1d95;color:#ffffff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:700">Régler la facture en ligne</a></p>` : ''}
<p style="font-size:15px">Cordialement,<br><strong>${safe(companyName)}</strong></p>
<p style="font-size:11px;color:#6b7280;border-top:1px solid #e2e6ef;padding-top:12px;margin-top:18px">Cet email est destiné exclusivement à son destinataire. © ${new Date().getFullYear()} ${safe(companyName)}</p>
</div></div>`;
  return { subject: template.subject, text, html };
}

module.exports = {
  LEVELS,
  levelForDaysLate,
  daysLate,
  evaluateReminder,
  buildReminderEmail
};
