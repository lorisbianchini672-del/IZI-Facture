// ============================================================
// lib/errors.test.js — Tests de la gestion centralisée des erreurs
// ------------------------------------------------------------
// Vérifie qu'aucun détail technique (SQL, Stripe, SMTP, stack) ne
// peut atteindre le client et que les rejets async sont bien
// transmis à la chaîne de gestion d'erreurs Express.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AppError,
  badRequest,
  unauthorized,
  notFound,
  conflict,
  tooManyRequests,
  serviceUnavailable,
  databaseError,
  normalizeError,
  publicMessage,
  statusOf,
  isApiRequest,
  logError,
  requestContext,
  asyncRoute,
  notFoundHandler,
  createErrorHandler
} = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const silentLogger = { error: () => {}, warn: () => {}, info: () => {} };

function fakeRequest({ url = '/api/test', method = 'GET', headers = {} } = {}) {
  return {
    url,
    originalUrl: url,
    method,
    id: 'req-test',
    get: name => headers[String(name).toLowerCase()]
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    type(value) { this.contentType = value; return this; },
    send(payload) { this.body = payload; this.headersSent = true; return this; }
  };
}

test('AppError : un 4xx est destiné au client, un 5xx reste générique', () => {
  const client = badRequest('Champ obligatoire manquant.');
  assert.equal(client.status, 400);
  assert.equal(client.code, 'BAD_REQUEST');
  assert.equal(client.expose, true);

  const internal = databaseError(new Error('relation "profiles" does not exist'));
  assert.equal(internal.status, 500);
  assert.equal(internal.code, 'DATABASE_ERROR');
  assert.equal(internal.expose, false);
  assert.equal(internal.message, 'Erreur serveur lors de l’accès aux données.');

  assert.equal(unauthorized().status, 401);
test('normalizeError traduit les erreurs techniques de la pile Express', () => {
  const invalidJson = normalizeError(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed' }));
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.code, 'INVALID_JSON');

  const tooLarge = normalizeError(Object.assign(new Error('too big'), { type: 'entity.too.large' }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.code, 'PAYLOAD_TOO_LARGE');

  const unknown = normalizeError(new Error('boom'));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.code, 'INTERNAL_ERROR');
  assert.equal(unknown.message, 'Erreur serveur inattendue.');

  const clientStatus = normalizeError(Object.assign(new Error('Stripe: No such session'), { status: 404 }));
  assert.equal(clientStatus.status, 404);
  assert.equal(clientStatus.expose, false);

  assert.equal(statusOf({ status: 999 }), 500);
  assert.equal(statusOf(undefined), 500);
  assert.equal(statusOf({ status: 429 }), 429);
});

test('isApiRequest distingue l’API des pages du site', () => {
  assert.equal(isApiRequest({ originalUrl: '/api/invoices?limit=5' }), true);
  assert.equal(isApiRequest({ url: '/api' }), true);
  assert.equal(isApiRequest({ url: '/dashboard.html' }), false);
  assert.equal(isApiRequest({ url: '/apix' }), false);
  assert.equal(isApiRequest({}), false);
});

test('requestContext : identifiant sain repris, identifiant douteux remplacé', () => {
  const kept = fakeRequest({ headers: { 'x-request-id': 'abc-123_ok' } });
  const keptRes = fakeResponse();
  let nextCalled = 0;
  requestContext(kept, keptRes, () => { nextCalled += 1; });
  assert.equal(kept.id, 'abc-123_ok');
  assert.equal(keptRes.headers['X-Request-Id'], 'abc-123_ok');
  assert.equal(nextCalled, 1);

  const replaced = fakeRequest({ headers: { 'x-request-id': '"><script>alert(1)</script>' } });
  const replacedRes = fakeResponse();
  requestContext(replaced, replacedRes, () => {});
  assert.notEqual(replaced.id, '"><script>alert(1)</script>');
  assert.match(replaced.id, UUID_RE);
});

test('asyncRoute transmet le rejet au middleware d’erreurs', async () => {
  const handler = asyncRoute(async () => { throw new Error('échec interne'); });
  await new Promise(resolve => {
    handler(fakeRequest(), fakeResponse(), error => {
      assert.equal(error.message, 'échec interne');
      resolve();
    });
  });
});

test('errorHandler : réponse JSON sans détail pour une erreur interne', () => {
  const handler = createErrorHandler({ logger: silentLogger });
  const res = fakeResponse();
  handler(new Error('secret interne : mot de passe SMTP invalide'), fakeRequest(), res, () => {});

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Erreur serveur inattendue.', code: 'INTERNAL_ERROR', requestId: 'req-test' });
  assert.ok(!JSON.stringify(res.body).includes('mot de passe'));
});

test('errorHandler : message explicite pour une erreur applicative 4xx', () => {
  const handler = createErrorHandler({ logger: silentLogger });
  const res = fakeResponse();
  handler(badRequest('Statut de facture invalide.', 'INVALID_STATUS'), fakeRequest(), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'Statut de facture invalide.', code: 'INVALID_STATUS', requestId: 'req-test' });
});

test('errorHandler : texte brut pour une page du site et pas de double réponse', () => {
  const handler = createErrorHandler({ logger: silentLogger });
  const page = fakeResponse();
  handler(notFound(), fakeRequest({ url: '/inconnue.html' }), page, () => {});
  assert.equal(page.statusCode, 404);
  assert.equal(page.body, 'Ressource introuvable.');
  assert.equal(page.contentType, 'text/plain; charset=utf-8');

  const alreadySent = fakeResponse();
  alreadySent.headersSent = true;
  let forwarded = null;
  handler(new Error('tardive'), fakeRequest(), alreadySent, error => { forwarded = error; });
  assert.equal(forwarded?.message, 'tardive');
  assert.equal(alreadySent.statusCode, null);
});

test('notFoundHandler : JSON pour l’API, texte pour le site', () => {
  const api = fakeResponse();
  notFoundHandler(fakeRequest({ url: '/api/inexistant' }), api);
  assert.equal(api.statusCode, 404);
  assert.equal(api.body.code, 'NOT_FOUND');

  const site = fakeResponse();
  notFoundHandler(fakeRequest({ url: '/inexistant.html' }), site);
  assert.equal(site.statusCode, 404);
  assert.match(site.body, /Page introuvable/);
});

test('errorHandler : le détail de validation est transmis au client', () => {
  const handler = createErrorHandler({ logger: silentLogger });
  const res = fakeResponse();
  const error = badRequest('Requête invalide.', 'VALIDATION_ERROR');
  error.details = { issues: [{ path: 'email', code: 'pattern', message: 'Adresse email invalide.' }] };
  handler(error, fakeRequest(), res, () => {});
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    error: 'Requête invalide.',
    code: 'VALIDATION_ERROR',
    requestId: 'req-test',
    details: { issues: [{ path: 'email', code: 'pattern', message: 'Adresse email invalide.' }] }
  });
});

test('errorHandler : aucun détail n’est exposé sur une erreur 5xx', () => {
  const handler = createErrorHandler({ logger: silentLogger });
  const res = fakeResponse();
  const error = databaseError(new Error('SQLSTATE 42P01'));
  error.details = { issues: [{ path: 'secret', code: 'x', message: 'table profiles' }] };
  handler(error, fakeRequest(), res, () => {});
  assert.equal(res.body.details, undefined);
  assert.ok(!JSON.stringify(res.body).includes('profiles'));
});

test('logError : stack réservée aux incidents serveur', () => {
  const calls = [];
  const logger = {
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args])
  };

  logError(badRequest('Champ manquant.'), { method: 'POST', path: '/api/invoices', requestId: 'r1' }, logger);
  logError(databaseError(new Error('SQLSTATE 42P01')), { method: 'GET', path: '/api/invoices', requestId: 'r2' }, logger);

  assert.equal(calls[0][0], 'warn');
  assert.equal(calls[1][0], 'error');
  assert.equal(calls[0][1], 'Requête refusée');
  assert.equal(calls[1][1], 'Requête en échec');
  assert.equal(calls[0][2].requestId, 'r1');
  assert.equal(calls[1][2].requestId, 'r2');
  // Le 4xx n'embarque aucune cause technique ; le 5xx conserve la cause pour le diagnostic.
  assert.equal(calls[0][2].cause, undefined);
  assert.equal(calls[1][2].cause.message, 'SQLSTATE 42P01');
  assert.ok(!JSON.stringify(calls[0][2]).includes('SQLSTATE'));
});

  assert.equal(notFound().status, 404);
  assert.equal(conflict('Doublon.').status, 409);
  assert.equal(tooManyRequests().status, 429);
  assert.equal(serviceUnavailable('Indisponible.').status, 503);
  assert.equal(new AppError('Statut incohérent.', { status: 999 }).status, 500);
});

test('publicMessage ne laisse jamais filtrer un détail technique', () => {
  const leak = 'relation "profiles" does not exist (SQLSTATE 42P01)';
  assert.equal(publicMessage(databaseError(new Error(leak))), 'Erreur serveur inattendue.');
  assert.ok(!publicMessage(databaseError(new Error(leak))).includes('SQLSTATE'));

  // Un 4xx applicatif conserve son message : il est écrit pour l'utilisateur.
  assert.equal(publicMessage(badRequest('Adresse email invalide.')), 'Adresse email invalide.');
  // Un 4xx technique non exposable est remplacé par un message neutre.
  assert.equal(publicMessage(new AppError('stack interne', { status: 400, expose: false })), 'Requête invalide.');
  assert.equal(publicMessage(notFound()), 'Ressource introuvable.');
});
