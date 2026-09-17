// @ts-check
// ============================================================
// lib/logger.js — Journalisation structurée
// ------------------------------------------------------------
//   • niveaux debug < info < warn < error, filtrés par LOG_LEVEL ;
//   • sortie JSON d'une ligne (LOG_FORMAT=json) ou lisible (pretty) ;
//   • contexte enfant (requestId, userId…) et chronomètre ;
//   • rédaction automatique des secrets, jetons et emails : un
//     journal ne doit JAMAIS devenir une fuite de données.
//
// Aucune dépendance externe : utilisable par le serveur, la couche
// données et les scripts.
// ============================================================
'use strict';

/**
 * @typedef {'debug'|'info'|'warn'|'error'} LogLevel
 * @typedef {Record<string, unknown>} LogContext
 * @typedef {{ debug: (message: string, context?: LogContext) => void,
 *             info: (message: string, context?: LogContext) => void,
 *             warn: (message: string, context?: LogContext) => void,
 *             error: (message: string, context?: LogContext) => void,
 *             child: (context: LogContext) => Logger,
 *             timer: (label: string) => { end: (context?: LogContext) => number },
 *             level: LogLevel }} Logger
 */

const LEVELS = /** @type {Record<LogLevel, number>} */ ({ debug: 10, info: 20, warn: 30, error: 40 });
const LEVEL_NAMES = /** @type {LogLevel[]} */ (['debug', 'info', 'warn', 'error']);

const REDACTED = '[masqué]';
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 300;

// Clés dont la valeur ne doit jamais apparaître en clair dans un journal.
const SENSITIVE_KEY = /(pass|secret|token|authorization|cookie|api[-_]?key|signature|iban|rib|hash)/i;
// Données personnelles : on conserve le domaine, jamais l'adresse complète.
const EMAIL_KEY = /email|mail/i;
const EMAIL_VALUE = /^[^\s@]+@([^\s@]+)$/;

/**
 * Masque une adresse email en conservant le domaine (utile au diagnostic).
 * @param {string} value
 * @returns {string}
 */
function maskEmail(value) {
  const trimmed = String(value).trim();
  const at = trimmed.indexOf('@');
  if (at < 1) return REDACTED;
  return `${trimmed.slice(0, 1)}***@${trimmed.slice(at + 1)}`;
}

/**
 * Convertit une erreur en objet journalisable (stack réservé aux incidents).
 * @param {unknown} error
 * @param {boolean} withStack
 * @returns {LogContext}
 */
function serializeError(error, withStack) {
  if (!(error instanceof Error)) return { value: String(error) };
  /** @type {LogContext} */
  const serialized = { name: error.name, message: error.message };
  const { code, status } = /** @type {{ code?: unknown, status?: unknown }} */ (error);
  if (typeof code === 'string') serialized.code = code;
  if (typeof status === 'number') serialized.status = status;
  if (withStack && error.stack) serialized.stack = error.stack;
  return serialized;
}

/**
 * Neutralise les valeurs sensibles d'une structure quelconque.
 * @param {unknown} value
 * @param {{ depth?: number, key?: string, withStack?: boolean, seen?: WeakSet<object> }} [options]
 * @returns {unknown}
 */
function redact(value, options = {}) {
  const { depth = 0, key = '', withStack = false, seen = new WeakSet() } = options;

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key)) return REDACTED;
    if (EMAIL_KEY.test(key) && EMAIL_VALUE.test(value)) return maskEmail(value);
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function') return '[fonction]';
  if (value instanceof Error) return serializeError(value, withStack);
  if (depth >= MAX_DEPTH) return '[profondeur max]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS)
      .map(item => redact(item, { depth: depth + 1, withStack, seen }));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`… ${value.length - MAX_ARRAY_ITEMS} élément(s) supplémentaire(s)`);
    }
    return items;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circulaire]';
    seen.add(value);
    /** @type {LogContext} */
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(/** @type {LogContext} */ (value))) {
      output[entryKey] = SENSITIVE_KEY.test(entryKey)
        ? REDACTED
        : redact(entryValue, { depth: depth + 1, key: entryKey, withStack, seen });
    }
    return output;
  }

  return String(value);
}

/**
 * Normalise le niveau demandé (variable d'environnement incluse).
 * @param {unknown} value
 * @returns {LogLevel}
 */
function normalizeLevel(value) {
  const candidate = String(value ?? '').trim().toLowerCase();
  return /** @type {LogLevel} */ (
    LEVEL_NAMES.includes(/** @type {LogLevel} */ (candidate)) ? candidate : 'info'
  );
}

/**
 * Crée un journaliseur structuré.
 * @param {{ level?: LogLevel|string, format?: 'json'|'pretty', context?: LogContext,
 *           sink?: Partial<Record<LogLevel, (...args: unknown[]) => void>>, now?: () => Date }} [options]
 * @returns {Logger}
 */
function createLogger(options = {}) {
  const { format = 'pretty', context = {}, sink = {}, now = () => new Date() } = options;
  const level = normalizeLevel(options.level);
  const threshold = LEVELS[level];

  /** @param {LogLevel} entryLevel @param {string} message @param {LogContext} entryContext */
  function write(entryLevel, message, entryContext) {
    if (LEVELS[entryLevel] < threshold) return;
    const merged = { ...context, ...entryContext };
    const redacted = /** @type {LogContext} */ (redact(merged, { withStack: entryLevel === 'error' }));
    const timestamp = now().toISOString();

    if (format === 'json') {
      const line = JSON.stringify({ at: timestamp, level: entryLevel, message, ...redacted });
      (sink[entryLevel] || console[entryLevel] || console.log)(line);
      return;
    }
    const hasContext = Object.keys(redacted).length > 0;
    (sink[entryLevel] || console[entryLevel] || console.log)(
      `[${timestamp}] [${entryLevel}] ${message}`,
      hasContext ? redacted : ''
    );
  }

  /** @type {Logger} */
  const logger = {
    level,
    debug: (message, entryContext = {}) => write('debug', message, entryContext),
    info: (message, entryContext = {}) => write('info', message, entryContext),
    warn: (message, entryContext = {}) => write('warn', message, entryContext),
    error: (message, entryContext = {}) => write('error', message, entryContext),
    child: extraContext => createLogger({ ...options, level, format, context: { ...context, ...extraContext } }),
    timer: label => {
      const startedAt = Date.now();
      return {
        end: entryContext => {
          const durationMs = Date.now() - startedAt;
          write('debug', label, { ...entryContext, durationMs });
          return durationMs;
        }
      };
    }
  };

  return logger;
}

/**
 * Journaliseur par défaut déduit de l'environnement.
 * LOG_LEVEL = debug|info|warn|error ; LOG_FORMAT = json|pretty.
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {Logger}
 */
function createDefaultLogger(environment = process.env) {
  const isProduction = environment.NODE_ENV === 'production' || environment.VERCEL === '1';
  return createLogger({
    level: environment.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    format: environment.LOG_FORMAT || (isProduction ? 'json' : 'pretty')
  });
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  REDACTED,
  maskEmail,
  redact,
  serializeError,
  normalizeLevel,
  createLogger,
  createDefaultLogger
};
