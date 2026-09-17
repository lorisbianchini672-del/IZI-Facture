// ============================================================
// lib/assets.js — Fichiers statiques : liste blanche stricte
// ------------------------------------------------------------
// Le serveur n'expose QUE les ressources publiques du site
// (pages, styles, images, polices). Données clients (data/*.json),
// scripts serveur (server.js, db.js), fichiers de configuration et
// secrets ne sont JAMAIS servis.
// Ajouter une ressource publique = ajouter son extension ici.
// ============================================================
const path = require('node:path');
const express = require('express');

// Extensions servies publiquement. Volontairement absentes :
// .js (index.js, server.js, db.js), .json (package.json, data/*.json),
// .md, .sql, .sh, .map, .log, .env.
const PUBLIC_EXTENSIONS = new Set([
  '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.txt', '.xml', '.webmanifest'
]);

// Chemins exacts autorisés sans extension.
const PUBLIC_FILES = new Set(['/', '/robots.txt', '/sitemap.xml', '/favicon.ico']);

// Préfixes toujours refusés, même si l'extension est autorisée.
const PRIVATE_PREFIXES = [
  '/data', '/scripts', '/lib', '/supabase', '/backup', '/api',
  '/node_modules', '/.git', '/.vercel', '/.xgrok', '/.github'
];

// Décode l'URL et rejette ce qui ne peut pas être un chemin de fichier sain
// (URL absolue, caractères de contrôle, encodage invalide).
function normalizePathname(url) {
  const raw = String(url || '');
  const withoutQuery = raw.split('?')[0].split('#')[0];
  if (!withoutQuery.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  return decoded;
}

// Vrai si l'URL correspond à une ressource publique du site.
function isPublicAsset(url) {
  const pathname = normalizePathname(url);
  if (!pathname) return false;

  const lower = pathname.toLowerCase().replace(/\\/g, '/');
  if (lower.includes('..')) return false;      // traversée de répertoire
  if (lower.includes('/.')) return false;      // fichiers cachés et segments .*
  if (lower.endsWith('/.')) return false;

  for (const prefix of PRIVATE_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) return false;
  }

  if (PUBLIC_FILES.has(lower)) return true;
  return PUBLIC_EXTENSIONS.has(path.extname(lower));
}

// Middleware : délègue à express.static uniquement pour la liste blanche.
function createPublicStaticMiddleware(rootDirectory, options = {}) {
  const serveStatic = express.static(rootDirectory, {
    dotfiles: 'deny',
    index: 'index.html',
    redirect: false,
    fallthrough: true,
    ...options
  });

  return function publicStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!isPublicAsset(req.url)) return next();
    serveStatic(req, res, next);
  };
}

module.exports = {
  PUBLIC_EXTENSIONS,
  PUBLIC_FILES,
  PRIVATE_PREFIXES,
  normalizePathname,
  isPublicAsset,
  createPublicStaticMiddleware
};
