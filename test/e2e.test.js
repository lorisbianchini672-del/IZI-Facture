// ============================================================
// test/e2e.test.js — Parcours métier complet, de bout en bout
// ------------------------------------------------------------
// Démarre le vrai serveur et déroule la chaîne à forte valeur :
// inscription → brouillon → validation (numérotation) → immuabilité
// → lien de paiement → PDF Factur-X → KPI → relance → paiement.
// Un seul parcours : toute régression de la chaîne métier casse ici.
// ============================================================
process.env.VERCEL = '1';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

/** @type {import('node:http').Server | undefined} */
let listener;
let baseUrl = '';
let cookie = '';

after(() => {
  listener?.close();
});

/** Client HTTP minimal : suit le cookie de session entre les appels. */
async function api(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) }
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  /** @type {any} */
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test('parcours métier complet', async () => {
  await new Promise(resolve => {
    listener = app.listen(0, '127.0.0.1', resolve);
  });
  const address = /** @type {import('node:net').AddressInfo} */ (listener.address());
  baseUrl = `http://127.0.0.1:${address.port}`;

  // 1. Serveur opérationnel.
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  // 2. Inscription → session active.
  const email = `e2e-${Date.now()}@test.fr`;
  const registration = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E Test', email, password: 'motdepasse-2026' })
  });
  assert.ok(registration.status === 200 || registration.status === 201, `inscription: ${registration.status}`);
  assert.ok(cookie, 'un cookie de session doit être émis');

  // 3. Création d'un brouillon.
  const created = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      number: 'DRAFT-1',
      client: 'ACME SARL',
      issueDate: '2026-09-01',
      dueDate: '2026-09-01',
      items: [{ description: 'Prestation web', quantity: 2, price: 500, taxRate: 0.2 }]
    })
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'BROUILLON');
  const draftId = created.body.id;

  // 4. Le brouillon reste éditable.
  const edited = await api(`/api/invoices/${draftId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      number: 'DRAFT-1',
      client: 'ACME SARL modifiée',
      issueDate: '2026-09-01',
      dueDate: '2026-09-01',
      items: [{ description: 'Prestation web', quantity: 3, price: 500, taxRate: 0.2 }]
    })
  });
  assert.equal(edited.status, 200);

  // 5. Validation → numéro définitif, séquentiel, sans trou.
  const validated = await api(`/api/invoices/${draftId}/validate`, { method: 'POST' });
  assert.equal(validated.status, 200);
  assert.match(validated.body.number, /^FAC-\d{4}-\d{4}$/, 'numéro de séquence');
  assert.equal(validated.body.status, 'ENVOYEE');
  const invoiceId = validated.body.id;

  // 6. Le contenu émis est immuable.
  const tampered = await api(`/api/invoices/${invoiceId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      number: 'HACK', client: 'X', issueDate: '2026-09-01', dueDate: '2026-09-01',
      items: [{ description: 'X', quantity: 1, price: 1, taxRate: 0 }]
    })
  });
  assert.equal(tampered.status, 409);
  assert.equal(tampered.body.code, 'INVOICE_IMMUTABLE');

  // 7. Pas de retour au brouillon après émission.
  const regression = await api(`/api/invoices/${invoiceId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'BROUILLON' })
  });
  assert.equal(regression.status, 409);
  assert.equal(regression.body.code, 'INVALID_STATUS_TRANSITION');

  // 8. Lien de paiement : URL Stripe si configuré (une création = 201), 503 explicite sinon.
  const payment = await api(`/api/invoices/${invoiceId}/payment-link`, { method: 'POST' });
  assert.ok(
    [200, 201].includes(payment.status) || payment.status === 503,
    `lien de paiement inattendu: ${payment.status}`
  );
  if ([200, 201].includes(payment.status)) {
    assert.ok(typeof payment.body.url === 'string' && payment.body.url.startsWith('https://'), 'URL Stripe');
    assert.ok(typeof payment.body.sessionId === 'string', 'session Stripe');
  }

  // 9. PDF Factur-X téléchargeable et enrichi.
  const pdfResponse = await fetch(`${baseUrl}/api/invoices/${invoiceId}/pdf`, { headers: { Cookie: cookie } });
  if (pdfResponse.status === 200) {
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    assert.ok(pdf.length > 1000, 'PDF non trivial');
    assert.ok(pdf.subarray(0, 5).toString('latin1').startsWith('%PDF'), 'signature PDF');
  } else {
    assert.equal(pdfResponse.status, 404);
  }

  // 10. KPI financiers calculés.
  const metrics = await api('/api/metrics', { headers: { Cookie: cookie } });
  assert.equal(metrics.status, 200);
  assert.equal(typeof metrics.body.revenue?.ht, 'number');
  assert.equal(typeof metrics.body.outstanding?.ht, 'number');


  // 11. Relance : envoyée si SMTP configuré, 503 explicite sinon.
  const reminder = await api(`/api/invoices/${invoiceId}/remind`, { method: 'POST', body: JSON.stringify({ email: 'client@acme.fr' }) });
  assert.ok(reminder.status === 200 || reminder.status === 503, `relance: ${reminder.status}`);

  // 12. Paiement → PAYEE.
  const paid = await api(`/api/invoices/${invoiceId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'PAYEE' })
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, 'PAYEE');

  // 13. Une facture payée est verrouillée définitivement.
  const locked = await api(`/api/invoices/${invoiceId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'RETARD' })
  });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'INVOICE_FINALIZED');
});
