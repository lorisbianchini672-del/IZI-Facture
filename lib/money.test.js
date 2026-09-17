// ============================================================
// lib/money.test.js — Montants monétaires
// ------------------------------------------------------------
// L'enjeu : aucune dérive de flottant dans un total de facture et
// aucune saisie ambiguë acceptée silencieusement.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, formatAmount, computeTotals, round2, MAX_AMOUNT } = require('./money');

// L'espace insécable fine utilisé par Intl dépend de la version d'ICU.
const normalize = value => String(value).replace(/[\u202f\u00a0]/g, ' ');

test('parseAmount accepte les écritures françaises et numériques', () => {
  assert.equal(parseAmount(1234.5), 1234.5);
  assert.equal(parseAmount(0), 0);
  assert.equal(parseAmount('1234.56'), 1234.56);
  assert.equal(parseAmount('1 234,56 €'), 1234.56);
  assert.equal(parseAmount('1\u202f234,56'), 1234.56);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('  42  '), 42);
  assert.equal(parseAmount('0,005'), 0.01);
  assert.equal(parseAmount('-15,50'), -15.5);
});

test('parseAmount refuse tout ce qui n’est pas un montant plausible', () => {
  for (const value of [undefined, null, '', '   ', 'abc', '12abc', '1,2,3', {}, [], true, NaN, Infinity, -Infinity]) {
    assert.equal(parseAmount(value), null, `${String(value)} doit être refusé`);
  }
  assert.equal(parseAmount(MAX_AMOUNT + 1), null);
  assert.equal(parseAmount('99999999999'), null);
});

test('round2 évite les dérives de flottants', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
});

test('formatAmount produit un affichage français à deux décimales', () => {
  assert.equal(normalize(formatAmount(1234.5)), '1 234,50 €');
  assert.equal(normalize(formatAmount(0)), '0,00 €');
  assert.equal(normalize(formatAmount(1234567.891)), '1 234 567,89 €');
});

test('computeTotals arrondit à la ligne puis totalise', () => {
  const totals = computeTotals([
    { quantity: 3, price: 10.333, taxRate: 0.2 },
    { quantity: 1, price: 100, taxRate: 0.1 },
    { quantity: 2, price: 0, taxRate: 0.2 }
  ]);

  // 3 × 10,333 = 30,999 → 31,00 ; 1 × 100 = 100,00 ; ligne nulle = 0,00
  assert.equal(totals.ht, 131);
  // TVA : 31 × 20 % = 6,20 ; 100 × 10 % = 10,00
  assert.equal(totals.tva, 16.2);
  assert.equal(totals.ttc, 147.2);
  assert.deepEqual(totals.byRate, [
    { rate: 0.1, base: 100, amount: 10 },
    { rate: 0.2, base: 31, amount: 6.2 }
  ]);
});

test('computeTotals est robuste aux lignes incomplètes', () => {
  const totals = computeTotals([
    { quantity: Number.NaN, price: 100, taxRate: 0.2 },
    { quantity: 2, price: Number.POSITIVE_INFINITY, taxRate: 0.2 }
  ]);
  assert.deepEqual(totals, { ht: 0, tva: 0, ttc: 0, byRate: [] });
  assert.deepEqual(computeTotals([]), { ht: 0, tva: 0, ttc: 0, byRate: [] });
});
