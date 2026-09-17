// ============================================================
// lib/env.js — Chargement et validation de l'environnement
// ------------------------------------------------------------
// Seul point d'entrée pour dotenv : le fichier .env est résolu en
// chemin ABSOLU (le résultat ne dépend donc pas du répertoire
// courant) et les secrets sont audités avant tout démarrage.
// Aucun secret n'est jamais écrit dans les journaux : voir
// maskSecret().
// ============================================================
const fs = require('node:fs');
const path = require('node:path');

const envFilePath = path.join(__dirname, '..', '.env');

// Les tests peuvent neutraliser le chargement du .env réel.
if (process.env.IZI_SKIP_DOTENV !== '1') {
  require('dotenv').config({ path: envFilePath, quiet: true });
}

// Valeurs d'exemple livrées dans .env.example : jamais des secrets valides.
const PLACEHOLDER_VALUES = new Set([
  'change-this-token',
  'replace_me',
  'sk_test_replace_me',
  'whsec_replace_me',
  'notifications@example.com',
  'smtp.example.com',
  'https://xxxx.supabase.co'
]);

const PLACEHOLDER_PATTERN = /(replace[-_ ]?me|change[-_ ]?this|xxxx|votre-|a-remplacer|à-remplacer|example\.(com|org|net)|^<.+>$)/i;

// Retourne la valeur nettoyée d'une variable (chaîne vide si absente).
function get(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

// Vrai si la valeur est absente ou n'est qu'un exemple du .env.example.
function isPlaceholder(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return true;
  if (PLACEHOLDER_VALUES.has(normalized.toLowerCase())) return true;
  return PLACEHOLDER_PATTERN.test(normalized);
}

function isProduction() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
}

// Drapeau booléen tolérant (1/true/yes/oui).
function isEnabled(name) {
  const value = get(name).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'oui';
}

// Représentation sûre d'un secret pour les journaux : préfixe + longueur,
// jamais la valeur complète.
function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '(absent)';
  return `${text.slice(0, 3)}***(${text.length} car.)`;
}

// Vérifie que le fichier de secrets n'est lisible que par son propriétaire.
function checkEnvFilePermissions(filePath = envFilePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      path: filePath,
      mode: (stats.mode & 0o777).toString(8).padStart(3, '0'),
      tooOpen: (stats.mode & 0o077) !== 0
    };
  } catch {
    return { exists: false, path: filePath, mode: null, tooOpen: false };
  }
}

// Secrets audités au démarrage : 'critical' empêche le démarrage en production.
const AUDITED_SECRETS = [
  { name: 'ADMIN_TOKEN', critical: true, label: 'jeton d’administration' },
  { name: 'STRIPE_SECRET_KEY', critical: false, label: 'paiements Stripe' },
  { name: 'STRIPE_WEBHOOK_SECRET', critical: false, label: 'webhook Stripe' },
  { name: 'SMTP_HOST', critical: false, label: 'envoi d’emails (hôte SMTP)' },
  { name: 'SMTP_USER', critical: false, label: 'envoi d’emails (utilisateur SMTP)' },
  { name: 'SMTP_PASSWORD', critical: false, label: 'envoi d’emails (mot de passe SMTP)' }
];

// Contrôle des secrets : 'problems' bloque le démarrage en production stricte,
// 'warnings' signale une fonctionnalité simplement indisponible.
function auditEnvironment() {
  const problems = [];
  const warnings = [];

  for (const secret of AUDITED_SECRETS) {
    const value = get(secret.name);
    if (!isPlaceholder(value)) continue;
    const reason = value ? 'contient une valeur d’exemple' : 'est absent';
    const message = `${secret.name} (${secret.label}) ${reason}`;
    if (secret.critical) problems.push(message);
    else warnings.push(message);
  }

  // Supabase : les deux variables fonctionnent par paire.
  const supabaseConfigured = !isPlaceholder(get('SUPABASE_URL'));
  const supabaseKeyConfigured = !isPlaceholder(get('SUPABASE_SERVICE_ROLE_KEY'));
  if (supabaseConfigured !== supabaseKeyConfigured) {
    warnings.push('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY ne sont pas définis ensemble : repli sur les fichiers locaux');
  }

  return { problems, warnings };
}

// Valide l'environnement et journalise un état clair.
// En production, un problème critique interrompt le démarrage, sauf
// dérogation explicite (IZI_ALLOW_INSECURE_ENV=1).
function validateEnvironment({ logger = console, enforce } = {}) {
  const mustEnforce = typeof enforce === 'boolean' ? enforce : isProduction();
  const { problems, warnings } = auditEnvironment();

  for (const warning of warnings) {
    logger.warn(`[env] ${warning} — fonctionnalité associée indisponible.`);
  }

  const permissions = checkEnvFilePermissions();
  if (permissions.tooOpen) {
    logger.warn(`[env] ${envFilePath} est lisible par d’autres utilisateurs (${permissions.mode}) : exécutez « chmod 600 .env ».`);
  }

  if (problems.length > 0) {
    const summary = `Configuration incomplète : ${problems.join(' ; ')}.`;
    if (mustEnforce && !isEnabled('IZI_ALLOW_INSECURE_ENV')) {
      throw new Error(`${summary} Corrigez .env ou définissez IZI_ALLOW_INSECURE_ENV=1 pour démarrer malgré tout.`);
    }
    logger.warn(`[env] ${summary}`);
  }

  return { ok: problems.length === 0, problems, warnings, permissions };
}

module.exports = {
  envFilePath,
  get,
  isEnabled,
  isPlaceholder,
  isProduction,
  maskSecret,
  auditEnvironment,
  validateEnvironment,
  checkEnvFilePermissions,
  PLACEHOLDER_VALUES
};
