// ============================================================
// lib/reminders.test.js — Escalade, déduplication et emails de relance
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LEVELS,
  levelForDaysLate,
  daysLate,
  evaluateReminder,
  buildReminderEmail
} = require('./reminders');

/** Date de référence fixe pour des tests déterministes. */
const NOW = new Date('2026-03-15T10:00:00Z');

test('les trois niveaux escaladent avec les bons seuils', () => {
  assert.equal(levelForDaysLate(0), null, 'pas en retard = aucune relance');
  assert.equal(levelForDaysLate(-3), null, 'avant échéance = aucune relance');
  assert.equal(levelForDaysLate(1).level, 'courtoise');
  assert.equal(levelForDaysLate(6).level, 'courtoise');
  assert.equal(levelForDaysLate(7).level, 'ferme');
  assert.equal(levelForDaysLate(14).level, 'ferme');
  assert.equal(levelForDaysLate(15).level, 'avant-mise-en-demeure');
  assert.equal(levelForDaysLate(60).level, 'avant-mise-en-demeure');
  assert.equal(levelForDaysLate(Number.NaN), null);
  assert.equal(levelForDaysLate(Number.POSITIVE_INFINITY), null);
});

test('daysLate compte les jours calendaires UTC et ignore les heures', () => {
  assert.equal(daysLate('2026-03-14', NOW), 1);
  assert.equal(daysLate('2026-03-08', NOW), 7);
  assert.equal(daysLate('2026-02-28', NOW), 15);
  assert.equal(daysLate('2026-03-15', NOW), 0, 'échéance du jour = pas en retard');
  assert.equal(daysLate('2026-03-20', NOW), -5, 'futur = négatif');
  assert.equal(daysLate('nawak', NOW), 0, 'date invalide = pas de faux retard');
  assert.equal(daysLate('', NOW), 0);
});

test('evaluateReminder filtre les statuts non relançables', () => {
  const overdue = { status: 'ENVOYEE', dueDate: '2026-03-08' };
  assert.equal(evaluateReminder({ status: 'PAYEE', dueDate: '2026-03-01' }, { now: NOW }).reason, 'already_paid');
  assert.equal(evaluateReminder({ status: 'BROUILLON', dueDate: '2026-03-01' }, { now: NOW }).reason, 'draft');
  assert.equal(evaluateReminder({ status: 'ENVOYEE', dueDate: '2026-03-20' }, { now: NOW }).reason, 'not_due_yet');
  assert.equal(evaluateReminder(overdue, { now: NOW }).eligible, true);
});

test('la déduplication empêche un doublon de niveau mais autorise l’escalade', () => {
  const invoice = { status: 'RETARD', dueDate: '2026-02-28' }; // 15 jours de retard
  // 15 jours → niveau « avant-mise-en-demeure » : envoi possible si pas déjà fait.
  assert.equal(evaluateReminder(invoice, { now: NOW }).eligible, true);
  // Les niveaux précédents déjà envoyés ne bloquent pas le suivant.
  assert.equal(evaluateReminder(invoice, { now: NOW, sent: ['courtoise', 'ferme'] }).eligible, true);
  // Le niveau courant déjà envoyé est bloqué (règle anti-spam).
  assert.equal(evaluateReminder(invoice, { now: NOW, sent: ['avant-mise-en-demeure'] }).reason, 'already_sent');
});

test('buildReminderEmail adapte le ton au niveau', () => {
  const invoice = { number: 'FAC-2026-0007', client: 'ACME SARL', dueDate: '2026-03-08', totalTTC: '1 200,00 €' };
  const courtoise = buildReminderEmail(invoice, { level: levelForDaysLate(1), daysLate: 1 });
  assert.match(courtoise.subject, /Rappel/);
  assert.doesNotMatch(courtoise.subject, /pénalités/);

  const ferme = buildReminderEmail(invoice, { level: levelForDaysLate(7), daysLate: 7 });
  assert.match(ferme.subject, /Relance/);
  assert.match(ferme.text, /L441-10/, 'le rappel légal des pénalités figure dans la relance ferme');

  const finale = buildReminderEmail(invoice, { level: levelForDaysLate(15), daysLate: 15 });
  assert.match(finale.subject, /Dernier rappel/);
  assert.match(finale.html, /mise en demeure/i);
});

test('buildReminderEmail échappe toute donnée métier dans le HTML', () => {
  const hostile = {
    number: 'FAC-2026-0007',
    client: '<script>alert(1)</script><img src=x onerror=alert(2)>',
    dueDate: '2026-03-08',
    totalTTC: '1 200,00 €'
  };
  const email = buildReminderEmail(hostile, { level: levelForDaysLate(1), daysLate: 1 });
  assert.doesNotMatch(email.html, /<script>/, 'aucun script brut dans le HTML');
  assert.doesNotMatch(email.html, /<img/, 'aucune balise injectée');
  assert.ok(email.html.includes('&lt;script&gt;'), 'le contenu hostile est échappé');
  // Le texte brut reste lisible pour le client mail en mode texte.
  assert.ok(email.text.includes('<script>alert(1)</script>'));
});

test('buildReminderEmail intègre le lien de paiement quand il existe', () => {
  const invoice = { number: 'FAC-2026-0007', client: 'ACME', dueDate: '2026-03-08', totalTTC: '100,00 €' };
  const evaluation = { level: levelForDaysLate(1), daysLate: 1 };
  const withUrl = buildReminderEmail(invoice, evaluation, { paymentUrl: 'https://checkout.stripe.com/pay/abc' });
  assert.ok(withUrl.html.includes('https://checkout.stripe.com/pay/abc'));
  assert.ok(withUrl.text.includes('Régler en ligne : https://checkout.stripe.com/pay/abc'));

  const withoutUrl = buildReminderEmail(invoice, evaluation);
  assert.doesNotMatch(withoutUrl.html, /href=/, 'aucun lien vide ou cassé');
});

test('buildReminderEmail refuse une facture incomplète', () => {
  assert.throws(
    () => buildReminderEmail({ number: 'FAC-1', client: '', dueDate: '2026-03-08', totalTTC: '10 €' }, { level: levelForDaysLate(1), daysLate: 1 }),
    error => error.code === 'REMINDER_MISSING_DATA'
  );
});

test('les seuils de niveau sont croissants et cohérents', () => {
  for (let i = 1; i < LEVELS.length; i += 1) {
    assert.ok(LEVELS[i].minDaysLate > LEVELS[i - 1].minDaysLate, 'escalade strictement croissante');
  }
});
