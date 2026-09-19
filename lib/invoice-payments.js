// ============================================================
// lib/invoice-payments.js — Lien de paiement Stripe d'une facture
// ------------------------------------------------------------
// Fonctions PURES (aucune dépendance réseau) : les routes Stripe du
// serveur s'appuient dessus, ce qui rend le comportement testable :
//   - assertPayable      : garde-fous métier avant création du lien ;
//   - buildCheckoutParams: session Checkout (montant = TTC facture) ;
//   - applyPaidPayment   : passage à PAYEE, idempotent ;
//   - applyFailedPayment : retour d'échec, statut commercial intact.
// ============================================================
const { conflict } = require('./errors');

/**
 * Convertit un montant décimal en centimes Stripe (arrondi bancaire).
 * @param {number} amount
 * @returns {number}
 */
function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * Vérifie qu'une facture peut recevoir un lien de paiement et renvoie
 * son TTC de référence (montants recalculés côté serveur, jamais la
 * saisie client).
 * @param {Record<string, any>} invoice
 * @returns {number} TTC en unités décimales
 * @throws {import('./errors').AppError} 409 selon la cause
 */
function assertPayable(invoice) {
  if ((invoice?.type || 'FACTURE') !== 'FACTURE') {
    throw conflict('Seules les factures peuvent être encaissées en ligne.', 'NOT_AN_INVOICE');
  }
  const status = String(invoice?.status || 'BROUILLON');
  if (status === 'BROUILLON') {
    throw conflict('Validez la facture avant de créer un lien de paiement.', 'INVOICE_NOT_ISSUED');
  }
  if (status === 'PAYEE') {
    throw conflict('Cette facture est déjà payée.', 'INVOICE_ALREADY_PAID');
  }
  const ttc = Number(invoice?.amounts?.ttc ?? invoice?.totalTTC);
  if (!Number.isFinite(ttc) || ttc <= 0) {
    throw conflict('Montant TTC invalide pour un paiement en ligne.', 'INVALID_PAYMENT_AMOUNT');
  }
  return ttc;
}

/**
 * Construit les paramètres d'une session Checkout « paiement de facture » :
 * un seul article au TTC de la facture, des métadonnées permettant au
 * webhook de rattacher le paiement sans ambiguïté (kind + invoiceId + userId).
 * @param {Record<string, any>} invoice
 * @param {{ successUrl: string, cancelUrl: string }} urls
 * @returns {{ mode: 'payment', success_url: string, cancel_url: string,
 *   client_reference_id: string, line_items: Array<object>, metadata: Record<string, string> }}
 */
function buildCheckoutParams(invoice, { successUrl, cancelUrl }) {
  const ttc = assertPayable(invoice);
  return {
    mode: /** @type {'payment'} */ ('payment'),
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(invoice.number),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'eur',
        unit_amount: toCents(ttc),
        product_data: { name: `Facture ${invoice.number} — ${invoice.client}` }
      }
    }],
    metadata: {
      kind: 'invoice',
      invoiceId: String(invoice.id),
      invoiceNumber: String(invoice.number),
      userId: String(invoice.userId)
    }
  };
}

/**
 * Applique un paiement réussi (webhook checkout.session.completed).
 * Idempotent : un webhook rejoué par Stripe ne modifie rien une seconde fois.
 * @param {Record<string, any>} invoice facture telle que stockée
 * @param {Record<string, any>} session session Stripe
 * @returns {Record<string, any> | null} facture mise à jour, ou null si déjà traité
 */
function applyPaidPayment(invoice, session) {
  // PAYEE est un état terminal : tout webhook rejeté ou rejoué après
  // encaissement est un no-op (une facture ne peut pas être payée deux fois).
  if (invoice.paymentStatus === 'PAID') return null;
  // Le webhook est la source de vérité du paiement réel : même depuis un
  // statut inhabituel, une encaissement constaté devient PAYEE (une
  // écriture comptable se constate, elle ne se devine pas).
  return {
    ...invoice,
    status: 'PAYEE',
    paymentStatus: 'PAID',
    paymentSessionId: String(session.id),
    paymentPaidAt: new Date().toISOString()
  };
}

/**
 * Applique un retour d'échec (async_payment_failed, session expirée).
 * Le statut commercial reste inchangé : l'utilisateur peut générer un
 * nouveau lien de paiement.
 * @param {Record<string, any>} invoice
 * @param {Record<string, any>} session
 * @param {'FAILED'|'EXPIRED'} outcome
 * @returns {Record<string, any> | null}
 */
function applyFailedPayment(invoice, session, outcome = 'FAILED') {
  if (invoice.paymentSessionId === session.id && invoice.paymentStatus === outcome) return null;
  return {
    ...invoice,
    paymentStatus: outcome,
    paymentSessionId: String(session.id),
    paymentFailedAt: new Date().toISOString()
  };
}

module.exports = { toCents, assertPayable, buildCheckoutParams, applyPaidPayment, applyFailedPayment };
