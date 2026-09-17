// @ts-check
// ============================================================
// lib/money.js — Montants monétaires : analyse, calcul, formatage
// ------------------------------------------------------------
// Les montants circulent côté client sous forme lisible
// (« 1 234,56 € ») ET numérique. Ce module est la seule autorité
// de conversion : il refuse ce qui n'est pas un montant plausible
// et arrondit au centime à chaque ligne pour éviter la dérive des
// flottants dans les totaux de facture.
// ============================================================
'use strict';

/** Plafond de sécurité : aucun montant de facture légitime ne le dépasse. */
const MAX_AMOUNT = 1_000_000_000;

const FR_FORMAT = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/**
 * Arrondit au centime (evite 0.30000000000000004).
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Convertit une saisie hétérogène en montant numérique, ou `null`.
 * Accepte : 1234.5 | « 1 234,56 € » | « 1.234,56 » | « 1,234.56 » | « 1234 ».
 * @param {unknown} value
 * @returns {number | null}
 */
function parseAmount(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) return null;
    return round2(value);
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;
  // Une saisie contenant des lettres (hors symbole monétaire) est du texte,
  // pas un montant : on refuse plutôt que d'en extraire silencieusement des chiffres.
  if (/[a-z]/i.test(raw)) return null;

  // On retire symbole monétaire, espaces (dont insécables/fines) et autres signes.
  const cleaned = raw.replace(/[^\d.,+-]/g, '');
  if (!/[0-9]/.test(cleaned)) return null;

  // Normalisation des séparateurs (locale française) :
  //   • les deux présents  → le dernier rencontré est le séparateur décimal,
  //     l'autre séparateur de milliers (« 1.234,56 » comme « 1,234.56 ») ;
  //   • virgule seule      → toujours décimale en français (« 0,005 ») ;
  //     plusieurs virgules sans point → écriture ambiguë, refusée ;
  //   • point seul         → séparateur décimal (« 1234.56 »).
  const hasDot = cleaned.includes('.');
  const commaCount = (cleaned.match(/,/g) || []).length;
  /** @type {string} */
  let normalized;
  if (hasDot && commaCount > 0) {
    normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '');
  } else if (commaCount === 1) {
    normalized = cleaned.replace(',', '.');
  } else if (commaCount > 1) {
    return null;
  } else {
    normalized = cleaned;
  }

  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT) return null;
  return round2(amount);
}

/**
 * Formate un montant pour l'affichage français (« 1 234,56 € »).
 * @param {number} amount
 * @returns {string}
 */
function formatAmount(amount) {
  return `${FR_FORMAT.format(round2(amount))} €`;
}

/**
 * Calcule les totaux d'une facture à partir de ses lignes.
 * @param {Array<{ quantity: number, price: number, taxRate: number }>} items
 * @returns {{ ht: number, tva: number, ttc: number, byRate: Array<{ rate: number, base: number, amount: number }> }}
 */
function computeTotals(items) {
  const byRate = new Map();
  let ht = 0;
  let tva = 0;

  for (const item of items) {
    const quantity = item.quantity;
    const price = item.price;
    const rate = item.taxRate;

    // Une ligne incomplète ou infinie est ignorée : elle ne doit produire
    // ni montant, ni bucket de TVA partiel qui fausserait la répartition.
    if (!Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(rate)) continue;

    const lineHT = round2(quantity * price);
    const lineTVA = round2(lineHT * rate);
    ht = round2(ht + lineHT);
    tva = round2(tva + lineTVA);

    const bucket = byRate.get(rate) || { rate, base: 0, amount: 0 };
    bucket.base = round2(bucket.base + lineHT);
    bucket.amount = round2(bucket.amount + lineTVA);
    byRate.set(rate, bucket);
  }

  return {
    ht,
    tva,
    ttc: round2(ht + tva),
    byRate: [...byRate.values()].sort((a, b) => a.rate - b.rate)
  };
}

module.exports = {
  MAX_AMOUNT,
  round2,
  parseAmount,
  formatAmount,
  computeTotals
};
