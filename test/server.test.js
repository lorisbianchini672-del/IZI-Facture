// ============================================================
// test/server.test.js — Smoke-test d'intégration du serveur
// ------------------------------------------------------------
// Objectif : détecter tout module corrompu ou mal exporté dès
// `npm test` (un require qui échoue ou un export manquant faisait
// planter le serveur sans qu'aucun test ne le voie).
// Le serveur n'écoute que si VERCEL !== '1' : on force VERCEL=1
// puis on démarre Express nous-mêmes sur un port éphémère.
// ============================================================
process.env.VERCEL = '1';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

/** @type {import('express').Express} */
const app = require('../server');

/** @type {import('node:http').Server | undefined} */
let listener;
let baseUrl = '';

after(() => {
  listener?.close();
});

test('le serveur démarre et répond sur un port éphémère', async () => {
  await new Promise(resolve => {
    listener = app.listen(0, '127.0.0.1', resolve);
  });
  const address = /** @type {import('node:net').AddressInfo} */ (listener.address());
  baseUrl = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  const body = /** @type {Record<string, unknown>} */ (await response.json());
  assert.equal(body.ok, true);
  assert.equal(typeof body.database, 'string');
  assert.equal(typeof body.stripeConfigured, 'boolean');
});

test('une route inconnue renvoie un 404 JSON structuré, jamais un stack', async () => {
  const response = await fetch(`${baseUrl}/api/route-inexistante`);
  assert.equal(response.status, 404);
  const body = /** @type {{ error?: string, code?: string, requestId?: string }} */ (await response.json());
  assert.equal(body.code, 'NOT_FOUND');
  assert.equal(body.error, 'Ressource introuvable.');
  assert.equal(typeof body.requestId, 'string');
  assert.ok(!JSON.stringify(body).includes('node_modules'), 'aucun détail technique ne doit filtrer');
});

test('un corps JSON invalide renvoie une 400 explicite', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ « pas du JSON »'
  });
  assert.equal(response.status, 400);
  const body = /** @type {{ error?: string, code?: string }} */ (await response.json());
  assert.equal(body.code, 'INVALID_JSON');
  assert.equal(body.error, 'Corps de requête JSON invalide.');
});

test('un payload de validation incomplet renvoie une 400 avec les champs fautifs', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nawak' })
  });
  assert.equal(response.status, 400);
  const body = /** @type {{ error?: string, code?: string,
    details?: { issues?: Array<{ path?: string, code?: string, message?: string }> } }} */ (await response.json());
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(typeof body.error, 'string');
  const issues = body.details?.issues ?? [];
  const paths = issues.map(issue => issue.path);
  assert.ok(paths.includes('name'), `le champ manquant doit être signalé : ${paths}`);
  assert.ok(paths.includes('email'), `le champ invalide doit être signalé : ${paths}`);
  assert.ok(issues.every(issue => typeof issue.message === 'string'));
});
