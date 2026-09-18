// ============================================================
// lib/invoice-lifecycle.js — Cycle de vie et immuabilité des factures
// ------------------------------------------------------------
// Conformité comptable française (art. 289 CGI, art. L123-22 code de
// commerce) : une facture émise est un document permanent. Ce module
// centralise :
//   - la machine à états des statuts (transitions explicites) ;
//   - l'immuabilité du CONTENU dès la sortie du brouillon (seul le
//     statut peut encore évoluer) ;
//   - la numérotation séquentielle annuelle, continue, sans trou.
// ============================================================
const { conflict } = require('./errors');

/**
 * Statuts manipulés par l'application. « ATTENTE » est un statut historique
 * de l'interface (facture en attente de paiement) : il reste accepté en
 * entrée pour ne pas casser les données existantes.
 * @type {readonly string[]}
 */
const STATUSES = /** @type {const} */ (['BROUILLON', 'ATTENTE', 'ENVOYEE', 'PAYEE', 'RETARD']);

/**
 * Transitions autorisées. Une facture PAYEE est un point final : aucun
 * retour arrière n'est possible (une écriture comptable ne se défait pas,
 * elle s'annule par un avoir — hors périmètre ici).
 */
const TRANSITIONS = /** @type {const} */ ({
  BROUILLON: ['ATTENTE', 'ENVOYEE'],
  ATTENTE: ['ENVOYEE', 'PAYEE', 'RETARD'],
  ENVOYEE: ['PAYEE', 'RETARD'],
  RETARD: ['ENVOYEE', 'PAYEE'],
  PAYEE: /** @type {readonly []} */ ([])
});

/**
 * Indique si une transition de statut est autorisée.
 * @param {string} from statut courant
 * @param {string} to statut cible
 * @returns {boolean}
 */
function canTransition(from, to) {
  const allowed = /** @type {readonly string[] | undefined} */ (TRANSITIONS[/** @type {keyof typeof TRANSITIONS} */ (from)]);
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Vérifie la transition et lève une 409 typée si elle est interdite.
 * @param {string} from statut courant
 * @param {string} to statut cible
 * @throws {import('./errors').AppError} 409 INVALID_STATUS_TRANSITION ou 409 INVOICE_FINALIZED
 */
function assertTransition(from, to) {
  if (from === to) return;
  if (from === 'PAYEE') {
    throw conflict('Une facture payée est definitive : son statut ne peut plus changer.', 'INVOICE_FINALIZED');
  }
  if (!canTransition(from, to)) {
    throw conflict(`Transition de statut interdite : ${from} → ${to}.`, 'INVALID_STATUS_TRANSITION');
  }
}

/**
 * Une facture est « émise » dès qu'elle quitte le brouillon : son contenu
 * devient immuable et son numéro définitif a été alloué.
 * @param {string} status
 * @returns {boolean}
 */
function isIssued(status) {
  return status !== 'BROUILLON';
}

/**
 * Le contenu (client, lignes, montants, dates) n'est éditable qu'en brouillon.
 * @param {string} status
 * @returns {boolean}
 */
function isContentEditable(status) {
  return status === 'BROUILLON';
}

// ---------- Numérotation séquentielle ----------

/**
 * Extrait l'ordinal d'un numéro métier au format `PREFIX-YYYY-NNNN`.
 * Renvoie null pour tout autre format (numéros libres historiques).
 * @param {string} number
 * @returns {{ prefix: string, year: number, ordinal: number } | null}
 */
function parseSequentialNumber(number) {
  const match = /^([A-Za-z]{2,8})-(\d{4})-(\d+)$/.exec(String(number || ''));
  if (!match) return null;
  const prefix = match[1].toUpperCase();
  const year = Number(match[2]);
  const ordinal = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(ordinal) || ordinal < 1) return null;
  return { prefix, year, ordinal };
}

/**
 * Calcule le prochain ordinal de l'année à partir des numéros existants.
 * La séquence est CONTINUE et propre à chaque type de document : les devis
 * (DEV) et les factures (FAC) suivent chacun leur suite — un devis ne crée
 * jamais de trou dans la numérotation des factures. On repart du plus grand
 * ordinal connu de l'année pour ce préfixe ; un « trou » ne peut naître que
 * de la suppression d'un brouillon, jamais d'une facture émise (celle-ci
 * est immuable, voir assertContentEditable).
 * @param {readonly string[]} existingNumbers tous les numéros de l'utilisateur
 * @param {number} year année de la séquence
 * @param {string} prefix préfixe métier (ex. « FAC »)
 * @returns {{ year: number, ordinal: number, number: string }}
 */
function nextSequentialNumber(existingNumbers, year, prefix = 'FAC') {
  const targetPrefix = prefix.toUpperCase();
  let maxOrdinal = 0;
  for (const candidate of existingNumbers) {
    const parsed = parseSequentialNumber(candidate);
    if (parsed && parsed.prefix === targetPrefix && parsed.year === year && parsed.ordinal > maxOrdinal) {
      maxOrdinal = parsed.ordinal;
    }
  }
  const ordinal = maxOrdinal + 1;
  return { year, ordinal, number: `${targetPrefix}-${year}-${String(ordinal).padStart(4, '0')}` };
}

/**
 * Garde-fou d'immuabilité : interdit toute réécriture de contenu d'une
 * facture émise, quel que soit le canal (API, import, webhook).
 * @param {{ status?: unknown, number?: unknown }} existing facture stockée
 * @throws {import('./errors').AppError} 409 INVOICE_IMMUTABLE
 */
function assertContentEditable(existing) {
  const status = String(existing?.status || 'BROUILLON');
  if (isContentEditable(status)) return;
  throw conflict(
    `Facture ${existing?.number || ''} déjà émise (statut ${status}) : son contenu est immuable.`
      .replace('  ', ' '),
    'INVOICE_IMMUTABLE'
  );
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  canTransition,
  assertTransition,
  isIssued,
  isContentEditable,
  parseSequentialNumber,
  nextSequentialNumber,
  assertContentEditable
};
