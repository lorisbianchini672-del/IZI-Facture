// ============================================================
// lib/finance.test.js — Agrégats financiers du tableau de bord
// ------------------------------------------------------------
// Invariants : les brouillons n'entrent dans aucun total, les montants
// hérités en texte français sont repris, les impayés sont triés par
// ancienneté avec palier d'alerte critique.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeFinancials, daysLate, paymentClass, LATE_ALERT_THRESHOLD_DAYS } = require('./finance');

test('daysLate calcule un retard calendaire exact', () => {
  assert.equal(daysLate('2026-03-01', '2026-03-01'), 0, 'échéance du jour : pas en retard');
  assert.equal(daysLate('2026-03-10', '2026-03-01'), 0, 'échéance future : pas en retard');
  assert.equal(daysLate('2026-02-25', '2026-03-05'), 8);
  assert.equal(daysLate('', '2026-03-05'), 0, 'échéance absente');
  assert.equal(daysLate('nimporte-quoi', '2026-03-05'), 0, 'échéance illisible');
});

test('paymentClass réduit les statuts à trois classes financières', () => {
  assert.equal(paymentClass('PAYEE'), 'paid');
  assert.equal(paymentClass('BROUILLON'), 'draft');
  // Historique de l'interface : « ATTENTE » est une créance émise non réglée.
  assert.equal(paymentClass('ATTENTE'), 'issued');
  assert.equal(paymentClass('ENVOYEE'), 'issued');
  assert.equal(paymentClass('RETARD'), 'issued');
});

test('computeFinancials agrège CA, encaissé, encours et impayés', () => {
  const invoices = [
    { number: 'FAC-2026-0001', client: 'ACME', status: 'PAYEE', amounts: { ht: 1000, tva: 200, ttc: 1200 }, dueDate: '2026-01-31' },
    { number: 'FAC-2026-0002', client: 'BETA', status: 'ENVOYEE', amounts: { ht: 500, tva: 100, ttc: 600 }, dueDate: '2026-02-20' },
    { number: 'FAC-2026-0003', client: 'GAMMA', status: 'BROUILLON', amounts: { ht: 999, tva: 0, ttc: 999 }, dueDate: '2026-03-10' },
    // Enregistrement hérité : totaux en texte au format français.
    { number: 'FAC-2026-0004', client: 'DELTA', status: 'ATTENTE', totalHT: '750,00', totalTVA: '150,00', totalTTC: '900,00', dueDate: '2025-12-01' },
    { number: 'FAC-2026-0005', client: 'EPSILON', status: 'ENVOYEE', amounts: { ht: 100, tva: 20, ttc: 120 }, dueDate: '2026-03-10' }
  ];
  const snapshot = computeFinancials(invoices, { today: '2026-03-05' });

  // CA facturé : tout sauf le brouillon (1000 + 500 + 750 + 100).
  assert.deepEqual(snapshot.revenue, { ht: 2350, ttc: 2820, count: 4 });
  // Encaissé : la seule facture PAYEE.
  assert.deepEqual(snapshot.collected, { ht: 1000, tva: 200, ttc: 1200, count: 1 });
  // Encours client (BFR) : les créances émises non réglées.
  assert.deepEqual(snapshot.outstanding, { ht: 1350, tva: 270, ttc: 1620, count: 3 });
  // Impayés : DELTA (90 jours, critique) puis BETA (13 jours), tri décroissant.
  // EPSILON échue le 2026-03-10 n'est pas encore en retard au 2026-03-05.
  assert.equal(snapshot.overdue.count, 2);
  assert.equal(snapshot.overdue.totalTtc, 1500);
  assert.equal(snapshot.overdue.criticalCount, 1);
  assert.deepEqual(snapshot.overdue.items.map(item => [item.number, item.daysLate, item.severity]), [
    ['FAC-2026-0004', 94, 'critical'],
    ['FAC-2026-0002', 13, 'late']
  ]);
  assert.equal(snapshot.today, '2026-03-05');
  assert.equal(LATE_ALERT_THRESHOLD_DAYS, 60);
});

test('computeFinancials réagit au palier d’alerte critique', () => {
  const invoices = [
    { number: 'FAC-2026-0001', client: 'ACME', status: 'ENVOYEE', amounts: { ht: 100, tva: 20, ttc: 120 }, dueDate: '2026-01-05' }
  ];
  // 59 jours de retard : sous le seuil de 60.
  const late = computeFinancials(invoices, { today: '2026-03-05' });
  assert.equal(late.overdue.criticalCount, 0);
  assert.equal(late.overdue.items[0].severity, 'late');
  // 60 jours de retard exactement : alerte critique.
  const critical = computeFinancials(invoices, { today: '2026-03-06' });
  assert.equal(critical.overdue.criticalCount, 1);
  assert.equal(critical.overdue.items[0].severity, 'critical');
});

test('computeFinancials tolère les entrées invalides sans jamais lever', () => {
  for (const empty of [null, undefined, 'nawak', [], [null, 'x', 42]]) {
    const snapshot = computeFinancials(empty);
    assert.equal(snapshot.revenue.ht, 0);
    assert.equal(snapshot.revenue.count, 0);
    assert.equal(snapshot.outstanding.ttc, 0);
    assert.equal(snapshot.overdue.count, 0);
    assert.deepEqual(snapshot.overdue.items, []);
  }
  // Montants illisibles ou absents : comptés comme zéro, jamais NaN.
  const broken = computeFinancials([
    { number: 'FAC-2026-0001', status: 'ENVOYEE', amounts: { ht: 'abc', tva: null } }
  ]);
  assert.equal(broken.revenue.ht, 0);
  assert.equal(broken.revenue.ttc, 0);
  assert.equal(Number.isFinite(broken.outstanding.ttc), true);
});
