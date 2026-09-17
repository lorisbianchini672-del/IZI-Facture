// ============================================================
// lib/assets.test.js — Liste blanche des fichiers statiques
// ------------------------------------------------------------
// Le point critique : aucune donnée client (data/*.json), aucun
// module serveur (*.js), aucun fichier de configuration ne doit
// être téléchargeable via le serveur Express.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPublicAsset, normalizePathname, createPublicStaticMiddleware, PUBLIC_EXTENSIONS } = require('./assets');

test('les pages et ressources du site restent accessibles', () => {
  for (const url of [
    '/', '/index.html', '/dashboard.html', '/devis.html', '/auth.html',
    '/page.css', '/logo.svg', '/logo-full.svg', '/favicon.ico',
    '/robots.txt', '/sitemap.xml', '/dashboard.html?invoice=1', '/#tarifs'
  ]) {
    assert.equal(isPublicAsset(url), true, `${url} devrait être public`);
  }
});

test('les données clients et les modules serveur sont refusés', () => {
  for (const url of [
    '/data/users.json',
    '/data/sessions.json',
    '/data/settings.json',
    '/data/prospection/lyon.csv',
    '/server.js',
    '/db.js',
    '/index.js',
    '/supabase-init.js',
    '/package.json',
    '/package-lock.json',
    '/vercel.json',
    '/lib/env.js',
    '/lib/errors.js',
    '/scripts/check-setup.js',
    '/supabase/schema.sql',
    '/backup/ancienne-landing-28488o.html',
    '/.env',
    '/.env.example',
    '/.git/config',
    '/node_modules/express/index.js',
    '/api/invoices',
    '/DATA/users.json'
  ]) {
    assert.equal(isPublicAsset(url), false, `${url} ne doit jamais être servi`);
  }
});

test('les tentatives de traversée de répertoire sont bloquées', () => {
  for (const url of [
    '/../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2fdata/users.json',
    '/data/../server.js',
    '/%2E%2E/server.js',
    '/data\\users.json',
    '/index.html%00.png',
    '/.hidden.html'
  ]) {
    assert.equal(isPublicAsset(url), false, `${url} doit être refusé`);
  }
});

test('normalizePathname rejette les URL non exploitables', () => {
  assert.equal(normalizePathname('/page.css?v=2#top'), '/page.css');
  assert.equal(normalizePathname('http://externe.tld/page.css'), null);
  assert.equal(normalizePathname('page.css'), null);
  assert.equal(normalizePathname('/%E0%A4%A'), null);
  assert.equal(normalizePathname(''), null);
});

test('le middleware statique délègue uniquement les ressources autorisées', () => {
  const middleware = createPublicStaticMiddleware(__dirname);
  assert.equal(typeof middleware, 'function');

  // Chemin privé : next() est appelé immédiatement, sans lecture disque.
  let privateNext = 0;
  middleware({ method: 'GET', url: '/data/users.json' }, {}, () => { privateNext += 1; });
  assert.equal(privateNext, 1);

  // Méthode non GET/HEAD : jamais servie par le middleware statique.
  let postNext = 0;
  middleware({ method: 'POST', url: '/index.html' }, {}, () => { postNext += 1; });
  assert.equal(postNext, 1);

  // Aucune extension interdite n'est déclarée publique.
  for (const extension of ['.js', '.json', '.md', '.sql', '.sh', '.map', '.log', '.env']) {
    assert.equal(PUBLIC_EXTENSIONS.has(extension), false, `${extension} ne doit pas être public`);
  }
});
