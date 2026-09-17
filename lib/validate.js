// @ts-check
// ============================================================
// lib/validate.js — Validation et assainissement stricts
// ------------------------------------------------------------
//   • Schémas déclaratifs (aucune dépendance externe) : object,
//     array, string, number, boolean, enum, date, email, money ;
//   • toute clé inconnue est REFUSÉE (pas de donnée non validée
//     qui entre silencieusement en base) ;
//   • protection anti pollution de prototype (__proto__, …) ;
//   • ValidationError expose la liste précise des champs fautifs
//     au client, sans jamais révéler la structure interne.
//
// Convention de typage : aucune valeur `any`, chaque schéma
// documente son type de sortie en JSDoc.
// ============================================================
'use strict';

const { AppError } = require('./errors');
const { parseAmount } = require('./money');

/**
 * @typedef {{ path: string, code: string, message: string }} ValidationIssue
 * @typedef {{ kind: string, optional: boolean, nullable: boolean, hasDefault: boolean,
 *             defaultValue?: unknown, parse: (value: unknown, path: string, issues: ValidationIssue[]) => unknown }} Schema
 */

/** Sentinelle interne : la valeur n'a pas passé le schéma. */
const INVALID = Symbol('invalid');

/** Clés interdites : vecteurs classiques de pollution de prototype. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Erreur de validation : 400 explicite, champ par champ. */
class ValidationError extends AppError {
  /**
   * @param {string} label
   * @param {ValidationIssue[]} issues
   */
  constructor(label, issues) {
    super(`${label} invalide.`, {
      status: 400,
      code: 'VALIDATION_ERROR',
      expose: true,
      details: { issues }
    });
    this.name = 'ValidationError';
    /** @type {ValidationIssue[]} */
    this.issues = issues;
  }
}

/**
 * @param {string} path
 * @param {string} code
 * @param {string} message
 * @returns {ValidationIssue}
 */
function issue(path, code, message) {
  return { path: path || '_', code, message };
}

/**
 * Vrai pour un objet simple (ni tableau, ni Date, ni classe).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Assainit un texte libre : retire les caractères de contrôle, normalise
 * les espaces et borne la longueur. À utiliser pour tout champ destiné à
 * l'affichage, au PDF ou à un email.
 * @param {unknown} value
 * @param {{ maxLength?: number, singleLine?: boolean }} [options]
 * @returns {string}
 */
function sanitizeText(value, options = {}) {
  const { maxLength = 200, singleLine = false } = options;
  const stripped = String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  const normalized = singleLine
    ? stripped.replace(/[\s\u00a0]+/g, ' ')
    : stripped.replace(/\r\n?/g, '\n');
  const trimmed = normalized.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trim() : trimmed;
}

/**
 * Échappe les caractères HTML sensibles (rendu sûr côté serveur).
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character] ?? character);
}

/**
 * Construit un schéma à partir d'un analyseur de type.
 * @param {string} kind
 * @param {(value: unknown, path: string, issues: ValidationIssue[]) => unknown} parse
 * @param {{ optional?: boolean, nullable?: boolean, defaultValue?: unknown, hasDefault?: boolean }} [options]
 * @returns {Schema}
 */
function schema(kind, parse, options = {}) {
  const { optional = false, nullable = false, defaultValue } = options;
  const hasDefault = 'defaultValue' in options && options.defaultValue !== undefined;
  return {
    kind,
    optional,
    nullable,
    hasDefault,
    defaultValue,
    parse(value, path, issues) {
      if (value === undefined) {
        if (hasDefault) return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
        issues.push(issue(path, 'required', 'Champ obligatoire.'));
        return INVALID;
      }
      if (value === null) {
        if (nullable) return null;
        issues.push(issue(path, 'required', 'Champ obligatoire.'));
        return INVALID;
      }
      return parse(value, path, issues);
    }
  };
}
/**
 * Marque un schéma comme facultatif (clé absente acceptée).
 * @param {Schema} definition
 * @returns {Schema}
 */
function optional(definition) {
  return { ...definition, optional: true };
}

/**
 * Ajoute une contrainte inter-champs après validation du schéma de base
 * (ex. la date d'échéance doit suivre la date d'émission).
 * @param {Schema} definition
 * @param {(value: unknown) => boolean} predicate
 * @param {{ code?: string, message?: string, path?: string }} [options]
 * @returns {Schema}
 */
function refine(definition, predicate, options = {}) {
  const { code = 'refine', message = 'Valeur invalide.', path = '' } = options;
  return {
    ...definition,
    parse(value, currentPath, issues) {
      const parsed = definition.parse(value, currentPath, issues);
      if (parsed === INVALID) return INVALID;
      if (!predicate(parsed)) {
        issues.push(issue(path ? `${currentPath}.${path}` : currentPath, code, message));
      }
      return parsed;
    }
  };
}

/**
 * Champ texte avec normalisation et contraintes.
 * @param {{ min?: number, max?: number, singleLine?: boolean, normalizer?: 'lower'|'upper'|'none',
 *           pattern?: RegExp, patternMessage?: string, oneOf?: readonly string[] }} [options]
 * @returns {Schema}
 */
function string(options = {}) {
  const {
    min = 0,
    max = 200,
    singleLine = false,
    normalizer = 'none',
    pattern,
    patternMessage = 'Format invalide.',
    oneOf
  } = options;

  return schema('string', (value, path, issues) => {
    if (typeof value !== 'string') {
      issues.push(issue(path, 'type', 'Texte attendu.'));
      return INVALID;
    }
    let text = sanitizeText(value, { maxLength: max, singleLine });
    if (text.length < min) {
      issues.push(issue(path, 'min_length', `Au moins ${min} caractère(s).`));
      return INVALID;
    }
    if (pattern && !pattern.test(text)) {
      issues.push(issue(path, 'pattern', patternMessage));
      return INVALID;
    }
    if (oneOf && !oneOf.includes(text)) {
      issues.push(issue(path, 'one_of', `Valeur attendue : ${oneOf.join(', ')}.`));
      return INVALID;
    }
    if (normalizer === 'lower') text = text.toLowerCase();
    if (normalizer === 'upper') text = text.toUpperCase();
    return text;
  });
}

/**
 * Adresse email normalisée (minuscules, longueur RFC).
 * @param {{ max?: number }} [options]
 * @returns {Schema}
 */
function email(options = {}) {
  const { max = 254 } = options;
  return string({ min: 6, max, singleLine: true, normalizer: 'lower', pattern: EMAIL_PATTERN, patternMessage: 'Adresse email invalide.' });
}

/**
 * Champ numérique strict (aucune coercition implicite).
 * @param {{ min?: number, max?: number, integer?: boolean, defaultValue?: number }} [options]
 * @returns {Schema}
 */
function number(options = {}) {
  const { min = -Infinity, max = Infinity, integer = false } = options;
  return schema('number', (value, path, issues) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(issue(path, 'type', 'Nombre attendu.'));
      return INVALID;
    }
    if (integer && !Number.isInteger(value)) {
      issues.push(issue(path, 'integer', 'Nombre entier attendu.'));
      return INVALID;
    }
    if (value < min) {
      issues.push(issue(path, 'min', `Valeur minimale : ${min}.`));
      return INVALID;
    }
    if (value > max) {
      issues.push(issue(path, 'max', `Valeur maximale : ${max}.`));
      return INVALID;
    }
    return value;
  }, options);
}

/**
 * Montant monétaire : accepte un nombre ou une chaîne française
 * (« 1 234,56 € ») et renvoie toujours un nombre arrondi au centime.
 * @returns {Schema}
 */
function money() {
  return schema('money', (value, path, issues) => {
    const amount = parseAmount(value);
    if (amount === null) {
      issues.push(issue(path, 'money', 'Montant invalide.'));
      return INVALID;
    }
    return amount;
  });
}

/**
 * Nombre tolérant la saisie texte d'un formulaire (« 12,5 », « 12.5 »).
 * `emptyAs` fixe EXPLICITEMENT la valeur d'un champ vidé : sans lui, un champ
 * vide est refusé plutôt que converti silencieusement en 0 ou NaN.
 * @param {{ min?: number, max?: number, integer?: boolean, emptyAs?: number }} [options]
 * @returns {Schema}
 */
function coerceNumber(options = {}) {
  const { min = -Infinity, max = Infinity, integer = false, emptyAs } = options;
  return schema('coerceNumber', (value, path, issues) => {
    let numeric;

    if (typeof value === 'number') {
      numeric = value;
    } else if (typeof value === 'string') {
      const text = value.replace(/\s/g, '');
      if (text === '') {
        if (emptyAs === undefined) {
          issues.push(issue(path, 'required', 'Nombre attendu.'));
          return INVALID;
        }
        numeric = emptyAs;
      } else {
        const normalized = /,\d{1,2}$/.test(text) ? text.replace(',', '.') : text;
        if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) {
          issues.push(issue(path, 'type', 'Nombre attendu.'));
          return INVALID;
        }
        numeric = Number(normalized);
      }
    } else {
      issues.push(issue(path, 'type', 'Nombre attendu.'));
      return INVALID;
    }

    if (!Number.isFinite(numeric)) {
      issues.push(issue(path, 'type', 'Nombre attendu.'));
      return INVALID;
    }
    if (integer && !Number.isInteger(numeric)) {
      issues.push(issue(path, 'integer', 'Nombre entier attendu.'));
      return INVALID;
    }
    if (numeric < min || numeric > max) {
      issues.push(issue(path, 'bounds', `Valeur attendue entre ${min} et ${max}.`));
      return INVALID;
    }
    return numeric;
  }, options);
}

/**
 * Date civile au format ISO (AAAA-MM-JJ), validée sur le calendrier.
 * @returns {Schema}
 */
function date() {
  return schema('date', (value, path, issues) => {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
      issues.push(issue(path, 'date', 'Date attendue au format AAAA-MM-JJ.'));
      return INVALID;
    }
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const isReal = parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
    if (!isReal) {
      issues.push(issue(path, 'date', 'Date inexistante.'));
      return INVALID;
    }
    return value;
  });
}

/**
 * Valeur parmi une liste fermée.
 * @param {readonly string[]} allowed
 * @returns {Schema}
 */
function enumeration(allowed) {
  return schema('enum', (value, path, issues) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      issues.push(issue(path, 'one_of', `Valeur attendue : ${allowed.join(', ')}.`));
      return INVALID;
    }
    return value;
  });
}

/**
 * Booléen strict.
 * @returns {Schema}
 */
function boolean() {
  return schema('boolean', (value, path, issues) => {
    if (typeof value !== 'boolean') {
      issues.push(issue(path, 'type', 'Booléen attendu.'));
      return INVALID;
    }

/**
 * Liste d'éléments validés un à un.
 * @param {Schema} itemSchema
 * @param {{ minLength?: number, maxLength?: number }} [options]
 * @returns {Schema}
 */
function array(itemSchema, options = {}) {
  const { minLength = 0, maxLength = 100 } = options;
  return schema('array', (value, path, issues) => {
    if (!Array.isArray(value)) {
      issues.push(issue(path, 'type', 'Liste attendue.'));
      return INVALID;
    }
    if (value.length < minLength) {
      issues.push(issue(path, 'min_length', `Au moins ${minLength} élément(s).`));
      return INVALID;
    }
    if (value.length > maxLength) {
      issues.push(issue(path, 'max_length', `Au plus ${maxLength} élément(s).`));
      return INVALID;
    }
    /** @type {unknown[]} */
    const output = [];
    value.forEach((entry, index) => {
      const parsed = itemSchema.parse(entry, `${path}[${index}]`, issues);
      if (parsed !== INVALID) output.push(parsed);
    });
    return output;
  });
}

/**
 * Objet à champs typés. Par défaut, toute clé non déclarée est refusée.
 * @param {Record<string, Schema>} fields
 * @param {{ strict?: boolean }} [options]
 * @returns {Schema}
 */
function object(fields, options = {}) {
  const { strict = true } = options;
  return schema('object', (value, path, issues) => {
    if (!isPlainObject(value)) {
      issues.push(issue(path, 'type', 'Objet attendu.'));
      return INVALID;
    }
    /** @type {Record<string, unknown>} */
    const output = {};
    const source = /** @type {Record<string, unknown>} */ (value);

    for (const [key, field] of Object.entries(fields)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const childPath = path ? `${path}.${key}` : key;
      const raw = source[key];
      if (raw === undefined && field.optional) continue;
      const parsed = field.parse(raw, childPath, issues);
      if (parsed !== INVALID) output[key] = parsed;
    }

    if (strict) {
      for (const key of Object.keys(source)) {
        if (key in fields) continue;
        const childPath = path ? `${path}.${key}` : key;
        issues.push(issue(childPath, UNSAFE_KEYS.has(key) ? 'forbidden_key' : 'unknown_key', 'Champ non autorisé.'));
      }
    }

    return output;
  });
}

/**
 * Valide une valeur et renvoie la version assainie.
 * @template T
 * @param {Schema} definition
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {T}
 * @throws {ValidationError}
 */
function validate(definition, value, options = {}) {
  const { label = 'Requête' } = options;
  /** @type {ValidationIssue[]} */
  const issues = [];
  const parsed = definition.parse(value, '', issues);
  if (issues.length > 0 || parsed === INVALID) throw new ValidationError(label, issues);
  return /** @type {T} */ (parsed);
}

/**
 * Variante sans exception : utile pour les sorties d'API et les scripts.
 * @param {Schema} definition
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown } | { ok: false, issues: ValidationIssue[] }}
 */
function validateSafe(definition, value) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  const parsed = definition.parse(value, '', issues);
  if (issues.length > 0 || parsed === INVALID) return { ok: false, issues };
  return { ok: true, value: parsed };
}

module.exports = {
  ValidationError,
  INVALID,
  UNSAFE_KEYS,
  isPlainObject,
  sanitizeText,
  escapeHtml,
  string,
  email,
  number,
  coerceNumber,
  money,
  date,
  enumeration,
  boolean,
  array,
  object,
  optional,
  refine,
  validate,
  validateSafe
};

    return value;
  });
}

