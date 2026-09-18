// ============================================================
// lib/invoice-lifecycle.test.js — Machine à états et numérotation
// ------------------------------------------------------------
// Invariants comptables testés : une facture payée est définitive,
// une facture émise est immuable, la numérotation est continue.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  canTransition,
  assertTransition,
  isIssued,
  isContentEditable,
  parseSequentialNumber,
  nextSequentialNumber,
  assertContentEditable
} = require('./invoice-lifecycle');

test('les transitions légales du cycle de vie sont autorisées', () => {
  assert.equal(canTransition('BROUILLON', 'ENVOYEE'), true);
  assert.equal(canTransition('BROUILLON', 'ATTENTE'), true);
  assert.equal(canTransition('ATTENTE', 'ENVOYEE'), true);
  assert.equal(canTransition('ENVOYEE', 'PAYEE'), true);
  assert.equal(canTransition('ENVOYEE', 'RETARD'), true);
  assert.equal(canTransition('RETARD', 'PAYEE'), true);
  assert.equal(canTransition('RETARD', 'ENVOYEE'), true);
});

test('les transitions illégales sont refusées', () => {
  assert.equal(canTransition('BROUILLON', 'PAYEE'), false, 'un brouillon ne peut pas être payé directement');
  assert.equal(canTransition('PAYEE', 'ENVOYEE'), false, 'une facture payée est un point final');
  assert.equal(canTransition('PAYEE', 'BROUILLON'), false);
  assert.equal(canTransition('ENVOYEE', 'BROUILLON'), false, 'pas de retour au brouillon après émission');
  assert.equal(canTransition('STATUT_INCONNU', 'PAYEE'), false);
});

test('assertTransition lève des 409 typées et explicites', () => {
  assert.throws(() => assertTransition('PAYEE', 'ENVOYEE'), error => {
    assert.equal(error.code, 'INVOICE_FINALIZED');
    assert.equal(error.status, 409);
    return true;
  });
  assert.throws(() => assertTransition('BROUILLON', 'PAYEE'), error => {
    assert.equal(error.code, 'INVALID_STATUS_TRANSITION');
    return true;
  });
  assert.doesNotThrow(() => assertTransition('BROUILLON', 'ENVOYEE'));
  // Identique à identique : no-op autorisé (idempotence).
  assert.doesNotThrow(() => assertTransition('ENVOYEE', 'ENVOYEE'));
});

test('l’immuabilité du contenu suit le statut', () => {
  assert.equal(isIssued('BROUILLON'), false);
  assert.equal(isIssued('ENVOYEE'), true);
  assert.equal(isIssued('PAYEE'), true);
  assert.equal(isContentEditable('BROUILLON'), true);
  assert.equal(isContentEditable('ENVOYEE'), false);
});

test('assertContentEditable bloque toute écriture sur une facture émise', () => {
  assert.doesNotThrow(() => assertContentEditable({ status: 'BROUILLON', number: 'FAC-2026-0001' }));
  assert.doesNotThrow(() => assertContentEditable({}, 'statut absent = brouillon'));
  assert.throws(() => assertContentEditable({ status: 'ENVOYEE', number: 'FAC-2026-0002' }), error => {
    assert.equal(error.code, 'INVOICE_IMMUTABLE');
    assert.equal(error.status, 409);
    assert.match(error.message, /immuable/);
    return true;
  });
});

test('parseSequentialNumber ne reconnaît que le format PREFIX-AAAA-N', () => {
  assert.deepEqual(parseSequentialNumber('FAC-2026-0042'), { prefix: 'FAC', year: 2026, ordinal: 42 });
  assert.deepEqual(parseSequentialNumber('DEV-2025-7'), { prefix: 'DEV', year: 2025, ordinal: 7 });
  assert.equal(parseSequentialNumber('FAC-001'), null, 'numéro libre historique');
  assert.equal(parseSequentialNumber('FAC-26-0001'), null, 'année à deux chiffres refusée');
  assert.equal(parseSequentialNumber('FAC-2026-0000'), null, 'ordinal zéro invalide');
  assert.equal(parseSequentialNumber(''), null);
  assert.equal(parseSequentialNumber(undefined), null);
});

test('nextSequentialNumber poursuit la séquence de l’année, sans trou', () => {
  const existing = ['FAC-2026-0001', 'FAC-2026-0003', 'FAC-2025-0009', 'FAC-001', 'DEV-2026-0004'];
  assert.deepEqual(nextSequentialNumber(existing, 2026), { year: 2026, ordinal: 4, number: 'FAC-2026-0004' });
  assert.deepEqual(nextSequentialNumber([], 2026), { year: 2026, ordinal: 1, number: 'FAC-2026-0001' });
  // Les numéros libres historiques n'influencent pas la séquence annuelle.
  assert.deepEqual(nextSequentialNumber(['FAC-0001', 'FAC-0002'], 2026).ordinal, 1);
  // Le préfixe est paramétrable (devis, avoirs).
  assert.equal(nextSequentialNumber(['DEV-2026-0002'], 2026, 'DEV').number, 'DEV-2026-0003');
  // Un ordinal non séquentiel élevé reste le maximum retenu.
  assert.equal(nextSequentialNumber(['FAC-2026-9999'], 2026).ordinal, 10000);
});
