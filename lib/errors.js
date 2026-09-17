// ============================================================
// lib/errors.js — Gestion centralisée des erreurs HTTP
// ------------------------------------------------------------
//   AppError       : erreur applicative typée (statut + code)
//   asyncRoute     : transmet les rejets des handlers async à Express
//   requestContext : identifiant de requête pour tracer les incidents
//   notFoundHandler / createErrorHandler : derniers maillons Express
//
// Règle : le client ne reçoit QUE le message public de l'erreur.
// Les détails techniques (SQL, Stripe, SMTP, stack) restent dans
// les journaux du serveur.
// ============================================================
const { randomUUID } = require('node:crypto');

class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, expose?: boolean, cause?: unknown,
   *           details?: Record<string, unknown> }} [options]
   */
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', expose, cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    const normalizedStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    this.status = normalizedStatus;
    this.code = code;
    // Un 4xx est destiné au client ; un 5xx reste générique.
    this.expose = typeof expose === 'boolean' ? expose : normalizedStatus < 500;
    // Complément d'information exposable (ex. liste des champs invalides).
    this.details = details;
  }
}

// ---------- Fabriques d'erreurs ----------
const badRequest = (message, code = 'BAD_REQUEST') => new AppError(message, { status: 400, code });
const unauthorized = (message = 'Connexion requise.', code = 'UNAUTHORIZED') => new AppError(message, { status: 401, code });
const forbidden = (message = 'Accès refusé.', code = 'FORBIDDEN') => new AppError(message, { status: 403, code });
const notFound = (message = 'Ressource introuvable.', code = 'NOT_FOUND') => new AppError(message, { status: 404, code });
const conflict = (message, code = 'CONFLICT') => new AppError(message, { status: 409, code });
const tooManyRequests = (message = 'Trop de requêtes. Réessayez plus tard.', code = 'RATE_LIMITED') => new AppError(message, { status: 429, code });
const serviceUnavailable = (message, code = 'SERVICE_UNAVAILABLE') => new AppError(message, { status: 503, code });
// Erreur de la couche données : le détail (Supabase, disque) reste interne.
const databaseError = cause => new AppError('Erreur serveur lors de l’accès aux données.', { status: 500, code: 'DATABASE_ERROR', cause });

// ---------- Utilitaires ----------
function statusOf(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
}

// Convertit n'importe quelle erreur en AppError exploitable : les erreurs
// techniques d'Express/body-parser sont traduites en 4xx explicites.
function normalizeError(error) {
  if (error instanceof AppError) return error;

  if (error?.type === 'entity.parse.failed') {
    return new AppError('Corps de requête JSON invalide.', { status: 400, code: 'INVALID_JSON', cause: error });
  }
  if (error?.type === 'entity.too.large' || statusOf(error) === 413) {
    return new AppError('Corps de requête trop volumineux.', { status: 413, code: 'PAYLOAD_TOO_LARGE', cause: error });
  }
  if (error?.type) {
    return new AppError('Requête invalide.', { status: 400, code: 'BAD_REQUEST', cause: error });
  }

  const status = statusOf(error);
  if (status < 500) {
    return new AppError(String(error?.message || 'Requête refusée.').slice(0, 200), { status, code: error?.code || 'BAD_REQUEST', expose: false, cause: error });
  }
  return new AppError('Erreur serveur inattendue.', { status: 500, code: 'INTERNAL_ERROR', cause: error });
}

// Message réellement renvoyé au client (jamais de fuite d'information).
function publicMessage(error) {
  const status = statusOf(error);
  if (error?.expose) return error.message;
  if (status === 404) return 'Ressource introuvable.';
  if (status === 413) return 'Corps de requête trop volumineux.';
  if (status === 429) return 'Trop de requêtes. Réessayez plus tard.';
  if (status === 503) return 'Service temporairement indisponible.';
  if (status < 500) return 'Requête invalide.';
  return 'Erreur serveur inattendue.';
}

function isApiRequest(req) {
  const pathname = String(req?.originalUrl || req?.url || '').split('?')[0];
  return pathname === '/api' || pathname.startsWith('/api/');
}

// Journalisation structurée d'un incident HTTP : le niveau reflète la
// gravité (5xx = error, 4xx = warn) et la stack n'est capturée que pour un
// incident serveur. Le journaliseur appelant choisit le format de sortie.
function logError(error, context = {}, logger = console) {
  const status = statusOf(error);
  const details = {
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    status,
    code: error?.code || 'INTERNAL_ERROR',
    message: String(error?.message || '').slice(0, 300)
  };
  if (status >= 500) {
    logger.error('Requête en échec', { ...details, cause: error?.cause || error });
    return;
  }
  logger.warn('Requête refusée', details);
}

// ---------- Middlewares ----------
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Attribue un identifiant de requête (repris de X-Request-Id s'il est sain)
// et le renvoie au client pour recouper un incident avec les journaux.
function requestContext(req, res, next) {
  const provided = req.get?.('x-request-id');
  req.id = REQUEST_ID_RE.test(provided || '') ? provided : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Express 4 n'attrape pas les rejets des handlers async : on les transmet
// explicitement à la chaîne de gestion d'erreurs.
function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

// Dernier maillon « route inconnue » : JSON pour l'API, texte pour le site.
function notFoundHandler(req, res) {
  const error = notFound();
  if (isApiRequest(req)) {
    return res.status(404).json({ error: error.message, code: error.code, requestId: req.id });
  }
  res.status(404).type('text/plain; charset=utf-8').send('404 — Page introuvable.');
}

// Gestionnaire d'erreurs centralisé (doit rester le DERNIER middleware).
function createErrorHandler({ logger = console } = {}) {
  return function errorHandler(error, req, res, next) {
    // Une réponse est déjà partie : on laisse Express fermer la connexion.
    if (res.headersSent) return next(error);

    const normalized = normalizeError(error);
    const status = statusOf(normalized);
    logError(normalized, { method: req.method, path: req.originalUrl, requestId: req.id }, logger);

    const payload = { error: publicMessage(normalized), code: normalized.code, requestId: req.id };
    // Les erreurs de validation exposent le détail des champs fautifs :
    // l'utilisateur sait exactement quoi corriger.
    if (normalized.expose && normalized.details) payload.details = normalized.details;
    if (isApiRequest(req)) return res.status(status).json(payload);
    res.status(status).type('text/plain; charset=utf-8').send(payload.error);
  };
}

const errorHandler = createErrorHandler();

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
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
  errorHandler,
  createErrorHandler
};
