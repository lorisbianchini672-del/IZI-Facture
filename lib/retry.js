// @ts-check
// ============================================================
// lib/retry.js — Résilience des appels réseau sortants
// ------------------------------------------------------------
//   • withRetry     : backoff exponentiel + gigue (jitter), respect
//     d'un AbortSignal, politique de reprise explicitable ;
//   • isRetryableError : classifie les pannes transitoires
//     (réseau, 429, 5xx, erreurs de connexion Stripe/SMTP) ;
//   • fetchWithTimeout : borne tout appel HTTP sortant.
//
// Règle : on ne rejoue QUE les pannes transitoires. Une erreur de
// configuration ou une réponse 4xx définitive n'est jamais rejouée.
// ============================================================
'use strict';

/** Codes d'erreur Node.js considérés comme transitoires. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE'
]);

/** Statuts HTTP pour lesquels une reprise a du sens. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/** Marqueurs de panne transitoire dans les messages (SMTP, TLS, DNS). */
const TRANSIENT_MESSAGE = /(timeout|timed out|socket hang up|temporar|try again|rate limit|too many requests|econnreset|eai_again|service unavailable)/i;

class RetryError extends Error {
  /**
   * @param {string} message
   * @param {{ attempts: number, cause: unknown, code?: string }} details
   */
  constructor(message, { attempts, cause, code = 'RETRY_EXHAUSTED' }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RetryError';
    this.attempts = attempts;
    this.code = code;
  }
}

/**
 * Vrai si l'erreur provient d'une annulation volontaire.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  const name = /** @type {{ name?: unknown }} */ (error)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Classe une erreur : reprise possible ou définitive.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableError(error) {
  if (!error || isAbortError(error)) return false;

  const candidate = /** @type {{ code?: unknown, status?: unknown, statusCode?: unknown,
   *   response?: { status?: unknown }, type?: unknown, message?: unknown }} */ (error);

  if (candidate.type === 'StripeConnectionError' || candidate.type === 'StripeAPIError') return true;
  if (typeof candidate.code === 'string' && TRANSIENT_CODES.has(candidate.code)) return true;

  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  if (typeof status === 'number') return TRANSIENT_STATUS.has(status);

  return typeof candidate.message === 'string' && TRANSIENT_MESSAGE.test(candidate.message);
}

/**
 * Calcule le délai d'attente d'une tentative : 2^n * base, plafonné,
 * avec gigue pour éviter l'effet de troupeau.
 * @param {number} attempt tentative écoulée (1 = première reprise)
 * @param {{ baseDelayMs: number, maxDelayMs: number, jitter: boolean }} options
 * @returns {number}
 */
function computeDelay(attempt, { baseDelayMs, maxDelayMs, jitter }) {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  if (!jitter) return exponential;
  // Gigue dite « full half » : le délai reste dans [exponential/2, exponential],
  // ce qui désynchronise les clients sans jamais dépasser le plafond.
  return Math.round(exponential / 2) + Math.floor(Math.random() * Math.ceil(exponential / 2));
}

/**
 * Pause interruptible.
 * @param {number} delayMs
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function sleep(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Opération annulée.'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Opération annulée.'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exécute une opération asynchrone avec reprise automatique.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ attempts?: number, baseDelayMs?: number, maxDelayMs?: number, jitter?: boolean,
 *           shouldRetry?: (error: unknown, attempt: number) => boolean,
 *           onRetry?: (info: { attempt: number, delayMs: number, error: unknown }) => void,
 *           signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
async function withRetry(operation, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    jitter = true,
    shouldRetry = isRetryableError,
    onRetry,
    signal
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RetryError('Nombre de tentatives invalide.', {
      attempts: 0,
      cause: null,
      code: 'INVALID_RETRY_OPTIONS'
    });
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) {
      throw Object.assign(new Error('Opération annulée.'), { name: 'AbortError' });
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts;
      const retryable = shouldRetry(error, attempt);
      if (isLast) {
        if (retryable && attempts > 1) {
          const message = String(/** @type {{ message?: unknown }} */ (error)?.message || error);
          throw new RetryError(`Échec après ${attempts} tentatives : ${message}`, { attempts, cause: error });
        }
        throw error;
      }
      if (!retryable) throw error;
      const delayMs = computeDelay(attempt, { baseDelayMs, maxDelayMs, jitter });
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }

  // Inatteignable (la boucle retourne ou lève) : garde-fou de typage.
  throw new RetryError('Échec de l’opération.', { attempts, cause: lastError });
}

/**
 * Appel HTTP sortant borné dans le temps.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 10_000, signal, ...init } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...init, signal: composed });
}

module.exports = {
  RetryError,
  TRANSIENT_CODES,
  TRANSIENT_STATUS,
  isAbortError,
  isRetryableError,
  computeDelay,
  sleep,
  withRetry,
  fetchWithTimeout
};
