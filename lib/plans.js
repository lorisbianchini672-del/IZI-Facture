// ============================================================
// lib/plans.js — Offres commerciales, prix et quotas
// ------------------------------------------------------------
// Source UNIQUE de vérité pour :
//   - les plans vendables (clé Stripe, libellé, montant en centimes) ;
//   - le plan gratuit appliqué par défaut à toute inscription ;
//   - le plafond de factures du plan gratuit et les fonctions
//     réservées aux plans payants.
//
// server.js ne définit plus ses propres prix : il lit ce module.
// Les montants sont exprimés en CENTIMES (convention Stripe).
// ============================================================

/** Plan appliqué à toute nouvelle inscription (aucun paiement requis). */
const DEFAULT_PLAN = 'gratuit';

/**
 * Plafond de factures du plan gratuit, calculé par mois civil.
 * Un client gratuit peut essayer le produit ; au-delà il doit payer.
 */
const FREE_INVOICE_QUOTA = 5;

/**
 * Catalogues : clé technique → offre commerciale.
 * `amount` est en centimes : 990 = 9,90 €.
 * `free: false` signifie que l'offre passe par Stripe Checkout.
 * @type {Record<string, { name: string, amount: number, description: string, free: boolean }>}
 */
const PLANS = {
  gratuit: {
    name: 'Gratuit',
    amount: 0,
    description: 'Pour tester la facturation simplement',
    free: true
  },
  pro: {
    name: 'Pro',
    amount: 990,
    description: 'Abonnement mensuel Pro',
    free: false
  },
  business: {
    name: 'Business & Équipe',
    amount: 2490,
    description: 'Abonnement mensuel Business & Équipe',
    free: false
  }
};

/** Clés payantes : celles que /api/checkout accepte. */
const PAID_PLANS = Object.keys(PLANS).filter(key => !PLANS[key].free);

/** Toutes les clés connues, dans l'ordre d'affichage. */
const PLAN_KEYS = Object.keys(PLANS);

/**
 * Normalise un plan stocké en base vers une clé connue.
 * Une valeur absente, vide ou inconnue devient le plan gratuit : un compte
 * ne peut jamais se retrouver sans plan exploitable.
 * @param {unknown} value
 * @returns {keyof typeof PLANS}
 */
function normalizePlan(value) {
  const key = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLANS, key) ? key : DEFAULT_PLAN;
}

/**
 * Un plan payant est-il actif ?
 * @param {unknown} value
 * @returns {boolean}
 */
function isPaid(value) {
  return normalizePlan(value) !== DEFAULT_PLAN;
}

/**
 * Fonctions réservées aux plans payants.
 * Le plan gratuit permet d'émettre des factures ; il ne donne pas accès
 * à l'automatisation comptable et commerciale.
 */
const PAID_FEATURES = {
  reminders: 'Relances d’impayés',
  facturx: 'Factur-X',
  fec: 'Export FEC'
};

/**
 * Le plan donne-t-il accès à une fonction réservée ?
 * @param {unknown} plan
 * @param {keyof typeof PAID_FEATURES} feature
 * @returns {boolean}
 */
function allows(plan, feature) {
  if (!Object.prototype.hasOwnProperty.call(PAID_FEATURES, feature)) {
    throw new Error(`Fonction inconnue : ${feature}`);
  }
  return isPaid(plan);
}

/**
 * Plafond de factures du plan (null = illimité).
 * @param {unknown} plan
 * @returns {number | null}
 */
function invoiceLimit(plan) {
  return isPaid(plan) ? null : FREE_INVOICE_QUOTA;
}

/**
 * Mois civil d'une date, au format AAAA-MM (fuseau du serveur).
 * Sert de clé de comptage pour le quota mensuel du plan gratuit.
 * @param {Date} [date]
 * @returns {string}
 */
function monthKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Décompte les factures créées pendant le mois civil courant.
 * Toute facture porte `createdAt` (ISO) : une date illisible est ignorée
 * plutôt que de faire échouer la requête de l'utilisateur.
 * @param {Array<Record<string, unknown>>} invoices
 * @param {Date} [now]
 * @returns {number}
 */
function countInvoicesThisMonth(invoices = [], now = new Date()) {
  const key = monthKey(now);
  return invoices.filter(invoice => {
    const created = invoice?.createdAt;
    if (typeof created !== 'string' || !created) return false;
    const date = new Date(created);
    return !Number.isNaN(date.getTime()) && monthKey(date) === key;
  }).length;
}

/**
 * Le quota mensuel est-il déjà atteint ?
 * @param {unknown} plan
 * @param {Array<Record<string, unknown>>} invoices
 * @param {Date} [now]
 * @returns {{ allowed: boolean, used: number, limit: number | null }}
 */
function checkQuota(plan, invoices = [], now = new Date()) {
  const limit = invoiceLimit(plan);
  const used = countInvoicesThisMonth(invoices, now);
  return { allowed: limit === null || used < limit, used, limit };
}

module.exports = {
  DEFAULT_PLAN,
  FREE_INVOICE_QUOTA,
  PLANS,
  PLAN_KEYS,
  PAID_PLANS,
  PAID_FEATURES,
  normalizePlan,
  isPaid,
  allows,
  invoiceLimit,
  monthKey,
  countInvoicesThisMonth,
  checkQuota
};