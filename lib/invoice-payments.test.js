// ============================================================
// lib/invoice-payments.test.js — Paiement Stripe d'une facture
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  toCents,
  assertPayable,
  buildCheckoutParams,
  applyPaidPayment,
  applyFailedPayment
} = require('./invoice-payments');

const FACTURE = {
  id: 'inv-1',
  number: 'FAC-2026-0007',
  client: 'ACME SARL',
  type: 'FACTURE',
  status: 'ENVOYEE',
  userId: 'user-1',
  amounts: { ht: 1000, tva: 200, ttc: 1200 },
  totalTTC: '1 200,00'
};

test('toCents arrondit au centime sans erreur flottante', () => {
  assert.equal(toCents(1200), 120000);
  assert.equal(toCents(99.1), 9910);
  assert.equal(toCents(0.1 + 0.2), 30, '0.30000000000000004 → 30 centimes');
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(79.95), 7995);
});

test('assertPayable refuse brouillon, déjà payée, devis et montant invalide', () => {
  assert.equal(assertPayable(FACTURE), 1200);
  assert.throws(() => assertPayable({ ...FACTURE, status: 'BROUILLON' }), e => e.code === 'INVOICE_NOT_ISSUED');
  assert.throws(() => assertPayable({ ...FACTURE, status: 'PAYEE' }), e => e.code === 'INVOICE_ALREADY_PAID');
  assert.throws(() => assertPayable({ ...FACTURE, type: 'DEVIS' }), e => e.code === 'NOT_AN_INVOICE');
  assert.throws(() => assertPayable({ ...FACTURE, amounts: { ttc: 0 } }), e => e.code === 'INVALID_PAYMENT_AMOUNT');
  assert.throws(() => assertPayable({ ...FACTURE, amounts: {}, totalTTC: 'nawak' }), e => e.code === 'INVALID_PAYMENT_AMOUNT');
  // totalTTC est une chaîne d'affichage : sans amounts.numérique, on refuse
  // (amounts est la source de vérité, jamais le rendu texte).
  assert.throws(() => assertPayable({ ...FACTURE, amounts: undefined }), e => e.code === 'INVALID_PAYMENT_AMOUNT');
});

test('buildCheckoutParams produit une session payment au TTC exact', () => {
  const params = buildCheckoutParams(FACTURE, { successUrl: 'https://ok', cancelUrl: 'https://ko' });
  assert.equal(params.mode, 'payment');
  assert.equal(params.line_items[0].price_data.unit_amount, 120000);
  assert.equal(params.line_items[0].price_data.currency, 'eur');
  assert.equal(params.client_reference_id, 'FAC-2026-0007');
  assert.equal(params.metadata.kind, 'invoice');
  assert.equal(params.metadata.invoiceId, 'inv-1');
  assert.equal(params.metadata.userId, 'user-1');
  assert.match(params.line_items[0].price_data.product_data.name, /FAC-2026-0007 — ACME SARL/);
  // Le TTC déclaré par le client n'est pas utilisé : amounts fait foi.
  const spoofed = buildCheckoutParams({ ...FACTURE, totalTTC: '0,01' }, { successUrl: 'a', cancelUrl: 'b' });
  assert.equal(spoofed.line_items[0].price_data.unit_amount, 120000);
});

test('applyPaidPayment passe la facture à PAYEE, idempotent', () => {
  const session = { id: 'cs_123' };
  const updated = applyPaidPayment(FACTURE, session);
  assert.equal(updated.status, 'PAYEE');
  assert.equal(updated.paymentStatus, 'PAID');
  assert.equal(updated.paymentSessionId, 'cs_123');
  assert.equal(typeof updated.paymentPaidAt, 'string');
  // Rejeu du webhook : aucun changement.
  assert.equal(applyPaidPayment(updated, session), null);
  // Une autre session ne réouvre pas la facture : idempotence stricte.
  assert.equal(applyPaidPayment(updated, { id: 'cs_456' }), null);
  // Fonctionne depuis RETARD et ATTENTE (encaissement réel).
  assert.equal(applyPaidPayment({ ...FACTURE, status: 'RETARD' }, session).status, 'PAYEE');
});

test('applyFailedPayment trace l échec sans toucher au statut commercial', () => {
  const session = { id: 'cs_789' };
  const failed = applyFailedPayment(FACTURE, session, 'FAILED');
  assert.equal(failed.status, 'ENVOYEE', 'le statut commercial est intact');
  assert.equal(failed.paymentStatus, 'FAILED');
  assert.equal(applyFailedPayment(failed, session, 'FAILED'), null, 'rejeu idempotent');
  assert.equal(applyFailedPayment(FACTURE, session, 'EXPIRED').paymentStatus, 'EXPIRED');
});
