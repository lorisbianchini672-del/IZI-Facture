// ============================================================
// lib/plans.test.js — Offres, quotas et déduction du plan
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');

const plans = require('./plans');

test('catalogue : prix en centimes et plans payants identifiés', () => {
  assert.equal(plans.PLANS.pro.amount, 990);
  assert.equal(plans.PLANS.business.amount, 2490);
  assert.equal(plans.PLANS.gratuit.amount, 0);
  assert.deepEqual(plans.PAID_PLANS, ['pro', 'business']);
  assert.equal(plans.PLANS.gratuit.free, true);
  assert.equal(plans.PLANS.pro.free, false);
});

test('normalizePlan : valeur inconnue → plan gratuit (jamais de compte sans plan)', () => {
  assert.equal(plans.normalizePlan('pro'), 'pro');
  assert.equal(plans.normalizePlan('BUSINESS'), 'business');
  assert.equal(plans.normalizePlan('  Pro  '), 'pro');
  for (const value of [undefined, null, '', 'entreprise', 42, {}, []]) {
    assert.equal(plans.normalizePlan(value), 'gratuit', `entrée ${JSON.stringify(value)}`);
  }
});

test('isPaid : seul le plan gratuit est non payant', () => {
  assert.equal(plans.isPaid('gratuit'), false);
  assert.equal(plans.isPaid(undefined), false);
  assert.equal(plans.isPaid('pro'), true);
  assert.equal(plans.isPaid('business'), true);
});

test('allows : relances, Factur-X et FEC réservés aux plans payants', () => {
  for (const feature of ['reminders', 'facturx', 'fec']) {
    assert.equal(plans.allows('gratuit', feature), false, `${feature} ne doit pas être gratuit`);
    assert.equal(plans.allows('pro', feature), true, `${feature} doit être inclus en Pro`);
    assert.equal(plans.allows('business', feature), true, `${feature} doit être inclus en Business`);
  }
  assert.throws(() => plans.allows('pro', 'inconnue'), /Fonction inconnue/);
});

test('invoiceLimit : plafond du gratuit, illimité en payant', () => {
  assert.equal(plans.invoiceLimit('gratuit'), plans.FREE_INVOICE_QUOTA);
  assert.equal(plans.invoiceLimit('pro'), null);
  assert.equal(plans.invoiceLimit('business'), null);
});

test('monthKey : clé mois civil sur deux chiffres', () => {
  assert.equal(plans.monthKey(new Date(2026, 0, 15)), '2026-01');
  assert.equal(plans.monthKey(new Date(2026, 11, 31)), '2026-12');
});

test('countInvoicesThisMonth : ignore les autres mois et les dates illisibles', () => {
  const now = new Date(2026, 8, 19); // septembre 2026
  const invoices = [
    { createdAt: new Date(2026, 8, 1).toISOString() },
    { createdAt: new Date(2026, 8, 30).toISOString() },
    { createdAt: new Date(2026, 7, 31).toISOString() }, // août : hors mois
    { createdAt: 'pas-une-date' },
    { createdAt: '' },
    {},
    null
  ];
  assert.equal(plans.countInvoicesThisMonth(invoices, now), 2);
});

test('countInvoicesThisMonth : liste absente = aucun décompte', () => {
  assert.equal(plans.countInvoicesThisMonth(), 0);
  assert.equal(plans.countInvoicesThisMonth([], new Date()), 0);
});

test('checkQuota : le gratuit est bloqué au plafond, le payant jamais', () => {
  const now = new Date(2026, 8, 19);
  const fill = count => Array.from({ length: count }, () => ({ createdAt: now.toISOString() }));

  const under = plans.checkQuota('gratuit', fill(plans.FREE_INVOICE_QUOTA - 1), now);
  assert.deepEqual(under, { allowed: true, used: plans.FREE_INVOICE_QUOTA - 1, limit: plans.FREE_INVOICE_QUOTA });

  const atLimit = plans.checkQuota('gratuit', fill(plans.FREE_INVOICE_QUOTA), now);
  assert.equal(atLimit.allowed, false);
  assert.equal(atLimit.used, plans.FREE_INVOICE_QUOTA);

  const paid = plans.checkQuota('pro', fill(500), now);
  assert.deepEqual(paid, { allowed: true, used: 500, limit: null });
});