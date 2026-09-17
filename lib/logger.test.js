// ============================================================
// lib/logger.test.js — Journalisation structurée
// ------------------------------------------------------------
// Deux exigences : la sortie doit être exploitable par un service de
// monitoring (niveau, contexte, une ligne par événement) et JAMAIS
// contenir un secret ou une donnée personnelle en clair.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, createDefaultLogger, maskEmail, redact, normalizeLevel, REDACTED } = require('./logger');

const FIXED_DATE = new Date('2026-09-17T10:00:00.000Z');

function capture(options = {}) {
  const lines = [];
  const sink = {
    debug: (...args) => lines.push(['debug', ...args]),
    info: (...args) => lines.push(['info', ...args]),
    warn: (...args) => lines.push(['warn', ...args]),
    error: (...args) => lines.push(['error', ...args])
  };
  const logger = createLogger({ level: 'debug', format: 'json', sink, now: () => FIXED_DATE, ...options });
  return { logger, lines };
}

function parsed(lines, index = 0) {
  return JSON.parse(String(lines[index][1]));
}

test('le format JSON produit une ligne complète et exploitable', () => {
  const { logger, lines } = capture();
  logger.info('Facture enregistrée', { invoiceId: 'inv_1', amountTTC: 1200 });

  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'info');
  const entry = parsed(lines);
  assert.equal(entry.at, FIXED_DATE.toISOString());
  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'Facture enregistrée');
  assert.equal(entry.invoiceId, 'inv_1');
  assert.equal(entry.amountTTC, 1200);
});

test('le niveau filtre les événements trop verbeux', () => {
  const { logger, lines } = capture({ level: 'warn' });
  logger.debug('détail technique');
  logger.info('information');
  logger.warn('attention');
  logger.error('incident');

  assert.deepEqual(lines.map(line => line[0]), ['warn', 'error']);
  assert.equal(logger.level, 'warn');
});

test('les secrets ne sont jamais écrits en clair', () => {
  const { logger, lines } = capture();
  logger.info('Appel sortant', {
    strategy: 'sb_secret_value_1234',
    STRIPE_SECRET_KEY: 'sk_live_51AbcDef',
    authorization: 'Bearer sk_live_51AbcDef',
    webhookSecret: 'whsec_9f2b7c',
    passwordHash: 'salt:deadbeef',
    nested: { cookie: 'izi_session=abc', apiKey: 'key-123' }
  });

  const raw = String(lines[0][1]);
  for (const secret of ['sk_live_51AbcDef', 'whsec_9f2b7c', 'salt:deadbeef', 'izi_session=abc', 'key-123']) {
    assert.ok(!raw.includes(secret), `${secret} ne doit pas apparaître`);
  }
  const entry = parsed(lines);
  assert.equal(entry.STRIPE_SECRET_KEY, REDACTED);
  assert.equal(entry.authorization, REDACTED);
  assert.equal(entry.nested.cookie, REDACTED);
  // Une clé anodine reste lisible : le journal doit rester utile.
  assert.equal(entry.strategy, 'sb_secret_value_1234');
});

test('les emails sont masqués mais restent diagnosticables', () => {
  const { logger, lines } = capture();
  logger.info('Connexion', { email: 'marie.dupont@exemple.fr', customerEmail: 'jean@exemple.fr' });

  const entry = parsed(lines);
  assert.equal(entry.email, 'm***@exemple.fr');
  assert.equal(entry.customerEmail, 'j***@exemple.fr');
  assert.ok(!String(lines[0][1]).includes('marie.dupont'));
  assert.match(String(lines[0][1]), /exemple\.fr/);
});

test('maskEmail gère les adresses invalides', () => {
  assert.equal(maskEmail('contact@boutique.fr'), 'c***@boutique.fr');
  assert.equal(maskEmail('@exemple.fr'), REDACTED);
  assert.equal(maskEmail('texte'), REDACTED);
  assert.equal(maskEmail(''), REDACTED);
});

test('redact neutralise les structures profondes et circulaires', () => {
  const circular = { name: 'racine' };
  circular.self = circular;
  const context = redact(circular);
  assert.equal(context.name, 'racine');
  assert.equal(context.self, '[circulaire]');

  const deep = { a: { b: { c: { d: { e: 'trop profond' } } } } };
  assert.equal(redact(deep).a.b.c.d, '[profondeur max]');

  assert.ok(String(redact({ message: 'x'.repeat(500) }).message).endsWith('…'));
  assert.deepEqual(redact({ items: [1, 2, 3] }).items, [1, 2, 3]);
  assert.equal(String(redact({ items: Array.from({ length: 25 }, (_, i) => i) }).items.at(-1)), '… 5 élément(s) supplémentaire(s)');
  assert.equal(redact({ execute: () => {} }).execute, '[fonction]');
});

test('une erreur est sérialisée avec sa stack au niveau error uniquement', () => {
  const { logger, lines } = capture();
  logger.error('Incident', { cause: new Error('échec SMTP') });
  const failure = parsed(lines);
  assert.equal(failure.cause.name, 'Error');
  assert.equal(failure.cause.message, 'échec SMTP');
  assert.ok(typeof failure.cause.stack === 'string' && failure.cause.stack.length > 0);

  const second = capture();
  second.logger.warn('Avertissement', { cause: new Error('détail') });
  assert.equal(parsed(second.lines).cause.stack, undefined);
});

test('le contexte enfant enrichit chaque ligne sans écraser la racine', () => {
  const { logger, lines } = capture({ context: { service: 'izi', requestId: 'req-1' } });
  const child = logger.child({ userId: 'user-9' });
  child.info('Action', { requestId: 'req-2' });

  const entry = parsed(lines);
  assert.equal(entry.service, 'izi');
  assert.equal(entry.userId, 'user-9');
  assert.equal(entry.requestId, 'req-2');
});

test('le chronomètre mesure une durée sans dépendre de l’horloge réelle', () => {
  const { logger, lines } = capture();
  const timer = logger.timer('Requête HTTP');
  const durationMs = timer.end({ status: 200 });

  assert.equal(typeof durationMs, 'number');
  assert.ok(durationMs >= 0);
  assert.equal(parsed(lines).message, 'Requête HTTP');
  assert.equal(parsed(lines).status, 200);
});

test('normalizeLevel retombe sur info pour une valeur inconnue', () => {
  assert.equal(normalizeLevel('DEBUG'), 'debug');
  assert.equal(normalizeLevel(' warn '), 'warn');
  assert.equal(normalizeLevel('trace'), 'info');
  assert.equal(normalizeLevel(undefined), 'info');
  assert.equal(normalizeLevel({}), 'info');
});

test('createDefaultLogger adapte niveau et format à l’environnement', () => {
  const production = createDefaultLogger({ NODE_ENV: 'production' });
  assert.equal(production.level, 'info');

  const development = createDefaultLogger({});
  assert.equal(development.level, 'debug');

  const forced = createDefaultLogger({ LOG_LEVEL: 'error', LOG_FORMAT: 'json' });
  assert.equal(forced.level, 'error');

  // La sortie lisible reste utilisable telle quelle (console locale).
  const lines = [];
  const pretty = createLogger({ format: 'pretty', sink: { info: (...args) => lines.push(args) } });
  pretty.info('Bonjour', { a: 1 });
  assert.match(String(lines[0][0]), /\[info\] Bonjour/);
  assert.deepEqual(lines[0][1], { a: 1 });
});