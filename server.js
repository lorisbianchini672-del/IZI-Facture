// ============================================================
// IZI — Serveur Express
// Sécurité : scrypt + sel, sessions HttpOnly (token haché),
// rate limiting, isolation par utilisateur, jeton admin
// comparé en temps constant.
// ============================================================
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('node:crypto');
// lib/env.js est le SEUL point d'entrée de la configuration : il charge le .env
// (chemin absolu) et audit les secrets. Aucun autre module n'appelle dotenv.
const env = require('./lib/env');
const { createDefaultLogger } = require('./lib/logger');
const {
  unauthorized,
  badRequest,
  notFound,
  conflict,
  tooManyRequests,
  serviceUnavailable,
  databaseError,
  requestContext,
  asyncRoute,
  notFoundHandler,
  createErrorHandler
} = require('./lib/errors');
const { createPublicStaticMiddleware } = require('./lib/assets');
const v = require('./lib/validate');
const money = require('./lib/money');
const { withRetry, isRetryableError } = require('./lib/retry');
const lifecycle = require('./lib/invoice-lifecycle');
const facturx = require('./lib/facturx');
const payments = require('./lib/invoice-payments');
const db = require('./db');

const app = express();
const port = Number(env.get('PORT') || 4242);
const publicUrl = env.get('PUBLIC_URL') || `http://localhost:${port}`;
const isProduction = env.isProduction();

// Journalisation structurée : niveaux, contexte, rédaction des secrets.
// LOG_LEVEL / LOG_FORMAT pilotent la verbosité et le format (JSON en production).
const logger = createDefaultLogger();

// Audit de la configuration. Par défaut le serveur démarre malgré une variable
// manquante (le .env reste la source unique) : les routes dépendantes répondent
// alors 503 et /api/health signale l'état. IZI_ENFORCE_ENV=1 rend le contrôle
// bloquant pour un déploiement strict.
const envReport = env.validateEnvironment({
  logger,
  enforce: env.isProduction() && env.isEnabled('IZI_ENFORCE_ENV')
});
if (!envReport.ok) {
  logger.error('Configuration incomplète', { problems: envReport.problems });
}

// Un secret absent ou laissé en valeur d'exemple ne doit jamais activer un service.
const stripeKey = env.get('STRIPE_SECRET_KEY');
const stripe = stripeKey.startsWith('sk_') && !env.isPlaceholder(stripeKey)
  ? new Stripe(stripeKey)
  : null;

const smtpPort = Number(env.get('SMTP_PORT') || 587);
const smtpConfigured = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']
  .every(name => !env.isPlaceholder(env.get(name)));
const mailer = smtpConfigured
  ? nodemailer.createTransport({
      host: env.get('SMTP_HOST'),
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: env.get('SMTP_USER'), pass: env.get('SMTP_PASSWORD') }
    })
  : null;

const plans = {
  pro: { name: 'Pro', amount: 990, description: 'Abonnement mensuel Pro' },
  business: { name: 'Business & Équipe', amount: 2490, description: 'Abonnement mensuel Business & Équipe' }
};

// ---------- Hash des mots de passe ----------
const hashPassword = password => new Promise((resolve, reject) => {
  const salt = crypto.randomBytes(16).toString('hex');
  crypto.scrypt(password, salt, 64, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(`${salt}:${derivedKey.toString('hex')}`);
  });
});

const verifyPassword = (password, storedHash) => new Promise((resolve, reject) => {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return resolve(false);
  }
  const [salt, key] = storedHash.split(':');
  crypto.scrypt(password, salt, 64, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey));
  });
});

// ---------- Sessions ----------
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `izi_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${isProduction ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'izi_session=; Path=/; HttpOnly; Max-Age=0');
}

function getSessionToken(req) {
  const cookies = req.get('cookie') || '';
  return cookies.split(';').map(cookie => cookie.trim().split('=')).find(([name]) => name === 'izi_session')?.[1];
}

async function createSessionForUser(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession({
    tokenHash: hashToken(token),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS)
  });
  setSessionCookie(res, token);
}

// ---------- Paramètres par défaut ----------
const defaultSettings = {
  legalName: 'IZI SAS',
  registration: '849 203 118 00024',
  ninea: '',
  plater: '',
  billingEmail: '',
  billingAddress: 'France',
  phone: ''
};

// ---------- Utilitaires ----------
function normalizeInvoiceForClient(invoice) {
  const { userId, ...rest } = invoice;
  return rest;
}

/**
 * Envoi SMTP isolé. Une panne transitoire est signalée au client par un 503
 * explicite, le détail technique restant dans les journaux.
 * Volontairement SANS reprise automatique : un message accepté puis perdu
 * provoquerait un doublon de facture chez le client. On borne l'attente.
 * @param {object} payload
 * @param {{ requestId?: string, context?: string }} [options]
 */
async function sendMail(payload, { requestId = '-', context = 'email' } = {}) {
  try {
    return await mailer.sendMail(payload);
  } catch (error) {
    logger.error('Envoi SMTP impossible', {
      requestId,
      context,
      retryable: isRetryableError(error),
      cause: error
    });
    throw serviceUnavailable('Envoi d’email momentanément indisponible.', 'EMAIL_DELIVERY_FAILED');
  }
}

/**
 * Enveloppe un appel Stripe avec reprise sur panne transitoire.
 * Les lectures et créations utilisent une clé d'idempotence : rejouer
 * l'appel ne peut pas facturer ni créer deux fois la même session.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ requestId?: string, action: string }} options
 * @returns {Promise<T>}
 */
async function stripeCall(operation, { requestId = '-', action }) {
  try {
    return await withRetry(operation, {
      attempts: 3,
      baseDelayMs: 250,
      onRetry: ({ attempt, delayMs, error }) => logger.warn('Reprise d’appel Stripe', {
        requestId,
        action,
        attempt,
        delayMs,
        cause: error
      })
    });
  } catch (error) {
    logger.error('Appel Stripe en échec', { requestId, action, cause: error });
    throw serviceUnavailable('Paiement temporairement indisponible.', 'STRIPE_UNAVAILABLE');
  }
}

// ---------- Schémas d'entrée API (validation stricte) ----------
const INVOICE_STATUSES = ['BROUILLON', 'ENVOYEE', 'PAYEE', 'RETARD', 'ATTENTE'];
const DOCUMENT_TYPES = ['FACTURE', 'DEVIS', 'RECURRENTE'];
const EMPTY_OR_EMAIL = /^$|^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const invoiceItemSchema = v.object({
  description: v.string({ min: 1, max: 200, singleLine: true }),
  quantity: v.number({ min: 0, max: 100000 }),
  price: v.number({ min: -1000000, max: 1000000 }),
  taxRate: v.number({ min: 0, max: 1 })
});

// Lignes issues de l'éditeur de devis : les champs numériques y sont encore
// saisis en texte. `emptyAs` documente la valeur retenue pour un champ vidé
// (jamais un NaN silencieux).
const emailItemSchema = v.object({
  description: v.string({ max: 200, singleLine: true }),
  quantity: v.coerceNumber({ min: 0, max: 100000, emptyAs: 1 }),
  price: v.coerceNumber({ min: -1000000, max: 1000000, emptyAs: 0 }),
  taxRate: v.coerceNumber({ min: 0, max: 1, emptyAs: 0 })
});

const invoiceSchema = v.refine(
  v.object({
    number: v.string({ min: 1, max: 60, singleLine: true }),
    client: v.string({ min: 1, max: 160, singleLine: true }),
    issueDate: v.date(),
    dueDate: v.date(),
    items: v.array(invoiceItemSchema, { minLength: 1, maxLength: 200 }),
    type: v.optional(v.enumeration(DOCUMENT_TYPES)),
    totalHT: v.optional(v.money()),
    totalTVA: v.optional(v.money()),
    totalTTC: v.optional(v.money())
  }),
  body => {
    const { issueDate, dueDate } = /** @type {{ issueDate: string, dueDate: string }} */ (body);
    return dueDate >= issueDate;
  },
  { code: 'date_order', message: 'La date d’échéance doit être postérieure ou égale à la date d’émission.', path: 'dueDate' }
);

const schemas = {
  register: v.object({
    name: v.string({ min: 2, max: 80, singleLine: true }),
    email: v.email(),
    password: v.string({ min: 8, max: 128 })
  }),
  login: v.object({
    email: v.email(),
    password: v.string({ min: 1, max: 128 })
  }),
  settings: v.object({
    legalName: v.optional(v.string({ min: 1, max: 120, singleLine: true })),
    registration: v.optional(v.string({ max: 60, singleLine: true })),
    ninea: v.optional(v.string({ max: 60, singleLine: true })),
    plater: v.optional(v.string({ max: 60, singleLine: true })),
    billingEmail: v.optional(v.string({ max: 254, singleLine: true, normalizer: 'lower', pattern: EMPTY_OR_EMAIL, patternMessage: 'Adresse email invalide.' })),
    billingAddress: v.optional(v.string({ max: 200, singleLine: true })),
    phone: v.optional(v.string({ max: 30, singleLine: true }))
  }),
  invoice: invoiceSchema,
  invoiceStatus: v.object({ status: v.enumeration(INVOICE_STATUSES) }),
  checkout: v.object({
    plan: v.enumeration(Object.keys(plans)),
    email: v.optional(v.email())
  }),
  invoiceEmail: v.object({
    recipient: v.optional(v.email()),
    clientEmail: v.optional(v.email()),
    documentNumber: v.string({ min: 1, max: 60, singleLine: true }),
    documentId: v.optional(v.string({ max: 60, singleLine: true })),
    client: v.string({ min: 1, max: 160, singleLine: true }),
    subject: v.optional(v.string({ max: 150, singleLine: true })),
    message: v.optional(v.string({ max: 2000 })),
    issueDate: v.optional(v.string({ max: 40, singleLine: true })),
    dueDate: v.optional(v.string({ max: 40, singleLine: true })),
    totalHT: v.optional(v.money()),
    totalTVA: v.optional(v.money()),
    totalTTC: v.optional(v.money()),
    items: v.optional(v.array(emailItemSchema, { maxLength: 200 }))
  })
};

/**
 * Valide une entrée d'API et renvoie la version assainie.
 * @template T
 * @param {keyof typeof schemas} name
 * @param {unknown} value
 * @param {string} label
 * @returns {T}
 */
function parseInput(name, value, label) {
  return v.validate(schemas[name], value, { label });
}

// L'échappement HTML provient d'une source unique (lib/validate.js) : utilisé
// par les emails transactionnels ci-dessous.
const escapeHtml = v.escapeHtml;

// ---------- Sécurité ----------
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}

const loginAttempts = new Map();
function authRateLimit(req, res, next) {
  const ip = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip || 'unknown';
  const now = Date.now();
  const key = `${ip}:${req.path}`;
  if (loginAttempts.size > 10_000) loginAttempts.clear();
  const bucket = loginAttempts.get(key);
  const current = bucket && now - bucket.first < 15 * 60 * 1000 ? bucket : { count: 0, first: now };
  current.count += 1;
  loginAttempts.set(key, current);
  if (current.count > 10) {
    return next(tooManyRequests('Trop de tentatives. Réessayez dans 15 minutes.', 'AUTH_RATE_LIMITED'));
  }
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Le jeton admin vient de .env uniquement ; une valeur absente ou d'exemple
// ferme l'accès (401) au lieu de laisser passer.
function requireAdmin(req, res, next) {
  const expected = env.get('ADMIN_TOKEN');
  const provided = req.get('x-admin-token');
  // Borne de longueur : évite de comparer des chaînes arbitrairement longues.
  if (env.isPlaceholder(expected) || typeof provided !== 'string' || provided.length > 256
      || !safeEqual(provided, expected)) {
    return next(unauthorized('Accès administrateur requis.', 'ADMIN_REQUIRED'));
  }
  next();
}

async function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  if (!token) return next(unauthorized('Connexion requise.', 'AUTH_REQUIRED'));
  try {
    const session = await db.findSessionByTokenHash(hashToken(token));
    if (!session || session.expiresAt < new Date()) {
      clearSessionCookie(res);
      return next(unauthorized('Session expirée. Reconnectez-vous.', 'SESSION_EXPIRED'));
    }
    const user = await db.findUserById(session.userId);
    if (!user) return next(unauthorized('Utilisateur introuvable.', 'USER_NOT_FOUND'));
    req.userId = user.id;
    req.user = { id: user.id, name: user.name, email: user.email };
    next();
  } catch (error) {
    // Le détail (Supabase, disque) reste dans les journaux serveur.
    next(databaseError(error));
  }
}

// Journal d'accès : une ligne structurée par requête, corrélable par requestId.
// Le niveau suit le statut HTTP pour que le monitoring puisse alerter seul.
function accessLog(req, res, next) {
  req.log = logger.child({ requestId: req.id });
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'debug');
    req.log[level]('Requête HTTP', {
      method: req.method,
      path: String(req.originalUrl || '').split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs)
    });
  });
  next();
}

app.disable('x-powered-by');
app.use(requestContext);
app.use(accessLog);
app.use(securityHeaders);
// La signature du webhook Stripe porte sur les octets BRUTS du corps : son
// parseur doit être monté avant express.json(), qui consommerait le flux.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
// Liste blanche stricte : seules les ressources publiques du site sont servies.
// data/*.json, db.js, lib/, scripts/ et les fichiers de configuration ne
// peuvent plus être téléchargés.
app.use(createPublicStaticMiddleware(__dirname));

// ---------- Génération PDF ----------
function createInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ margin: 50 });
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    // Bandeau logo (dégradé de marque IZI)
    const gradient = document.linearGradient(50, 50, 545, 50);
    gradient.stop(0, '#4c1d95');
    gradient.stop(1, '#9333ea');
    document.rect(50, 50, 495, 52).fill(gradient);
    document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(21).text('IZI', 70, 64, { lineBreak: false });
    document.font('Helvetica').fontSize(7.5).fillColor('#ddd6fe').text('FACTURATION PROFESSIONNELLE', 70, 86);
    document.fontSize(13).fillColor('#ffffff').text(`FACTURE ${invoice.documentNumber}`, 295, 70, { width: 230, align: 'right' });

    document.y = 122;
    document.font('Helvetica-Bold').fontSize(13).fillColor('#172033').text(invoice.company?.legalName || 'IZI SAS');
    document.font('Helvetica').fontSize(9).fillColor('#687386').text([
      invoice.company?.registration && `RC / SIRET : ${invoice.company.registration}`,
      invoice.company?.ninea && `NINEA : ${invoice.company.ninea}`,
      invoice.company?.plater && `PLATO : ${invoice.company.plater}`,
      invoice.company?.billingEmail
    ].filter(Boolean).join(' | '));
    document.moveDown().fontSize(10).fillColor('#172033').text(`Client : ${invoice.client}`);
    document.fontSize(9).fillColor('#687386').text(`Émission : ${invoice.issueDate} | Échéance : ${invoice.dueDate}`);
    document.moveDown();
    document.fontSize(11).fillColor('#172033');
    invoice.items.forEach(item => document.text(`${item.description} — ${item.quantity} x ${item.price} € HT — TVA ${item.taxRate}`));
    document.moveDown().text(`Total HT : ${invoice.totalHT}`);
    document.text(`TVA : ${invoice.totalTVA}`);
    document.font('Helvetica-Bold').fontSize(14).text(`Total TTC : ${invoice.totalTTC}`);
    document.font('Helvetica').fontSize(8).fillColor('#687386').text('Document généré électroniquement par IZI SAS — izifacture@gmail.com', 50, 750);
    document.end();
  });
}

// ---------- Paiement Stripe d'une facture ----------
// Génère un lien Checkout dynamique au TTC de la facture. La session est
// créée avec une clé d'idempotence : rejouer la requête ne crée pas deux
// sessions. Le statut « PAYEE » est posé UNIQUEMENT par le webhook.
app.post('/api/invoices/:id/payment-link', requireAuth, asyncRoute(async (req, res) => {
  const invoiceId = v.validate(invoiceIdSchema, req.params.id, { label: 'Identifiant de facture' });
  if (!stripe) throw serviceUnavailable('Paiement non configuré.', 'STRIPE_NOT_CONFIGURED');

  const invoice = await db.getInvoice(invoiceId, req.userId);
  if (!invoice) throw notFound('Facture introuvable.');
  payments.assertPayable(invoice);

  const params = payments.buildCheckoutParams(invoice, {
    successUrl: `${publicUrl}/dashboard.html?paiement=succes&facture=${encodeURIComponent(String(invoice.number))}`,
    cancelUrl: `${publicUrl}/dashboard.html?paiement=annule`
  });
  const session = await stripeCall(
    () => stripe.checkout.sessions.create(params, {
      idempotencyKey: `invpay-${invoiceId}-${Math.round(Number(invoice.amounts?.ttc) * 100)}`
    }),
    { requestId: req.id, action: 'création du lien de paiement de facture' }
  );

  // Métadonnées de paiement : autorisées même sur facture émise (elles ne
  // touchent pas au contenu comptable : client, lignes, montants, dates).
  await db.saveInvoice({
    ...invoice,
    paymentStatus: 'PENDING',
    paymentSessionId: session.id,
    paymentUrl: session.url
  }, req.userId);

  req.log.info('Lien de paiement créé', { invoiceId, number: invoice.number, sessionId: session.id });
  res.status(201).json({ url: session.url, sessionId: session.id });
}));

// ---------- Webhook Stripe ----------
app.post('/api/stripe/webhook', asyncRoute(async (req, res) => {
  const webhookSecret = env.get('STRIPE_WEBHOOK_SECRET');
  if (!stripe || env.isPlaceholder(webhookSecret)) {
    throw serviceUnavailable('Paiement non configuré.', 'STRIPE_NOT_CONFIGURED');
  }
  if (typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) {
    throw badRequest('Corps de webhook illisible.', 'INVALID_WEBHOOK_BODY');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret);
  } catch (error) {
    logger.warn('Signature de webhook refusée', { requestId: req.id, cause: error });
    throw badRequest('Signature de webhook invalide.', 'INVALID_WEBHOOK_SIGNATURE');
  }

  // ----- Paiement de facture (metadata.kind === 'invoice') -----
  const sessionMetadata = event.data?.object?.metadata || {};
  if (sessionMetadata.kind === 'invoice') {
    await handleInvoicePaymentEvent(event, logger);
    return res.json({ received: true });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      await db.saveOrder({
        id: session.id,
        customerEmail: session.customer_details?.email || null,
        plan: session.metadata?.plan || 'unknown',
        amount: session.amount_total || 0,
        currency: session.currency || 'eur',
        status: 'paid',
        paidAt: new Date().toISOString()
      });
    } catch (orderError) {
      // On accuse réception pour éviter les retries infinis de Stripe,
      // mais l'incident est tracé côté serveur.
      logger.error('Commande payée non enregistrée', { requestId: req.id, cause: orderError });
    }
  }

  res.json({ received: true });
}));

/**
 * Traite les événements Stripe rattachés à une facture : encaissement,
 * échec de paiement asynchrone, expiration de la session. Toujours
 * idempotent (un webhook re-joué ne modifie rien) et toujours 200 : un
 * incident de persistance est journalisé mais n'alimente pas les retries
 * infinis de Stripe.
 * @param {{ type: string, data: { object: Record<string, any> } }} event
 * @param {import('./lib/logger')} log logger (requestId corrélé)
 */
async function handleInvoicePaymentEvent(event, log) {
  const session = event.data.object;
  const { invoiceId, userId } = session.metadata || {};
  if (!invoiceId || !userId) {
    log.error('Webhook facture sans identifiants de rattachement', { eventId: event.id });
    return;
  }
  const invoice = await db.getInvoice(invoiceId, userId);
  if (!invoice) {
    log.error('Facture introuvable pour le webhook de paiement', { invoiceId, eventId: event.id });
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const updated = payments.applyPaidPayment(invoice, session);
      if (!updated) {
        log.info('Paiement de facture déjà enregistré (idempotent)', { invoiceId });
        return;
      }
      await db.saveInvoice(updated, userId);
      log.info('Facture payée via Stripe', {
        invoiceId,
        number: updated.number,
        amountCents: session.amount_total,
        paidAt: updated.paymentPaidAt
      });
      return;
    }
    if (event.type === 'checkout.session.async_payment_failed'
        || event.type === 'checkout.session.expired') {
      const outcome = event.type === 'checkout.session.expired' ? 'EXPIRED' : 'FAILED';
      const updated = payments.applyFailedPayment(invoice, session, outcome);
      if (!updated) return;
      await db.saveInvoice(updated, userId);
      log.warn('Paiement de facture non abouti', { invoiceId, outcome, number: updated.number });
      return;
    }
    log.debug('Événement Stripe de facture ignoré', { type: event.type, invoiceId });
  } catch (error) {
    // Journalisé, pas de rejet : Stripe n'obtient pas de 5xx infini.
    log.error('Webhook de paiement de facture non persisté', { invoiceId, eventId: event.id, cause: error });
  }
}

// ---------- Authentification ----------
app.post('/api/auth/register', authRateLimit, asyncRoute(async (req, res) => {
  const { name: displayName, email: normalizedEmail, password: passwordValue } =
    parseInput('register', req.body, 'Inscription');

  if (await db.findUserByEmail(normalizedEmail)) {
    throw conflict('Un compte existe déjà avec cet email.', 'EMAIL_ALREADY_USED');
  }

  const user = {
    id: crypto.randomUUID(),
    name: displayName,
    email: normalizedEmail,
    passwordHash: await hashPassword(passwordValue),
    createdAt: new Date().toISOString()
  };
  await db.createUser(user);
  await createSessionForUser(res, user.id);

  // ---- Email de confirmation d'inscription (au nom d'IZI) ----
  if (mailer) {
    const from = env.get('MAIL_FROM') || env.get('SMTP_USER');
    const loginUrl = `${publicUrl}/auth.html`;
    const dashboardUrl = `${publicUrl}/dashboard.html`;
    const cardCss = 'box-sizing:border-box;max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#ffffff00;color:#172033;border:1px solid #e9d5ff;border-radius:16px;overflow:hidden';
    try {
      await mailer.sendMail({
        from: `"IZI" <${from}>`,
        to: user.email,
        subject: 'Votre compte IZI est activé',
        text: [
          `Madame, Monsieur ${user.name},`,
          '',
          'Votre compte IZI a été créé avec succès.',
          `Adresse associée : ${user.email}`,
          '',
          'Votre solution comprend :',
          '- Établissement de devis et de factures professionnels',
          '- Conformité Factur-X 2026 intégrée',
          '- Calcul automatique de la TVA (20 %, 10 %, 5,5 %, 0 %)',
          '- Export FEC destiné à votre expert-comptable',
          '',
          `Accéder à votre espace : ${dashboardUrl}`,
          `Connexion ultérieure : ${loginUrl}`,
          '',
          'Pour toute question, notre service client se tient à votre disposition : izifacture@gmail.com',
          '',
          'Cordialement,',
          "L'équipe IZI"
        ].join('\n'),
        html: `<div style="${cardCss}">
          <div style="background:linear-gradient(135deg,#4c1d95,#7c3aed 65%,#9333ea);padding:26px 24px;text-align:center">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
              <td style="background:#ffffff;border-radius:12px;width:52px;height:52px;text-align:center;vertical-align:middle"><span style="color:#4c1d95;font-size:19px;font-weight:800;letter-spacing:1px">IZI</span></td>
            </tr></table>
            <div style="color:#ede9fe;font-size:12px;margin-top:10px;letter-spacing:2px">FACTURATION PROFESSIONNELLE</div>
          </div>
          <div style="background:#ffffff00;padding:28px">
            <h1 style="font-size:20px;color:#172033;margin:0 0 12px">Madame, Monsieur ${escapeHtml(user.name)},</h1>
            <p style="font-size:15px;color:#374151;line-height:1.6">Votre compte IZI a été créé avec succès pour l'adresse <strong style="color:#7c3aed">${escapeHtml(user.email)}</strong>. Vous pouvez dès à présent établir vos devis et vos factures.</p>
            <div style="background:#f3f0ff;border-radius:12px;padding:16px;margin:16px 0">
              <div style="font-size:14px;color:#172033;font-weight:700">Votre solution comprend :</div>
              <div style="font-size:14px;color:#374151;margin-top:8px;line-height:1.7">&mdash; Devis et factures professionnels en quelques clics<br>&mdash; Conformité Factur-X 2026 intégrée<br>&mdash; Calcul automatique de la TVA (20 %, 10 %, 5,5 %)<br>&mdash; Export FEC destiné à votre expert-comptable</div>
            </div>
            <a href="${dashboardUrl}" style="display:inline-block;background:#5b21b6;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;padding:13px 26px;font-size:15px">Accéder à mon espace</a>
            <p style="font-size:13px;color:#6b7280;margin-top:12px">Connexion ultérieure : <a href="${loginUrl}" style="color:#7c3aed">${loginUrl}</a></p>
          </div>
          <div style="background:#172033;color:#cbd5e1;text-align:center;padding:14px;font-size:12px">© 2026 IZI SAS — izifacture@gmail.com — Mentions légales disponibles sur notre site</div>
        </div>`
      });
      req.log.info('Email de confirmation d’inscription envoyé');
    } catch (error) {
      req.log.error('Échec du mail de confirmation', { accountId: user.id, cause: error });
    }

    // Notification d'équipe (le compte "pro" IZI est prévenu de chaque inscription)
    if (from && from.toLowerCase() !== user.email.toLowerCase()) {
      try {
        await mailer.sendMail({
          from: `"IZI" <${from}>`,
          to: from,
          subject: `[IZI] Nouvelle inscription : ${user.name}`,
          text: `Une nouvelle personne vient de s'inscrire sur IZI.\n\nNom : ${user.name}\nEmail : ${user.email}\nDate : ${new Date().toISOString()}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#172033;border-radius:14px;padding:22px;color:#e2e8f0">
            <div style="color:#fff;font-size:20px;font-weight:800">IZI — Notification d'inscription</div>
            <p style="margin-top:14px">Une nouvelle personne vient de s'inscrire :</p>
            <p style="line-height:1.7"><strong>Nom :</strong> ${escapeHtml(user.name)}<br><strong>Email :</strong> ${escapeHtml(user.email)}<br><strong>Date :</strong> ${new Date().toISOString()}</p>
          </div>`
        });
        req.log.info('Notification d’inscription équipe envoyée');
      } catch (error) {
        req.log.error('Échec de la notification équipe', { cause: error });
      }
    }
  } else {
    req.log.warn('SMTP non configuré : aucun email de confirmation envoyé');
  }

  res.status(201).json({ user: { id: user.id, name: user.name, email: user.email } });
}));

app.post('/api/auth/login', authRateLimit, asyncRoute(async (req, res) => {
  const { email: normalizedEmail, password: passwordValue } =
    parseInput('login', req.body, 'Connexion');
  const user = await db.findUserByEmail(normalizedEmail);
  if (!user || !(await verifyPassword(passwordValue, user.passwordHash))) {
    // Message identique quel que soit le cas : pas d'énumération de comptes.
    req.log.warn('Échec de connexion', { email: normalizedEmail });
    throw unauthorized('Email ou mot de passe incorrect.', 'INVALID_CREDENTIALS');
  }
  await createSessionForUser(res, user.id);
  req.log.info('Connexion réussie', { accountId: user.id });
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
}));

app.get('/api/auth/me', asyncRoute(async (req, res) => {
  const token = getSessionToken(req);
  if (!token) return res.json({ authenticated: false });
  const session = await db.findSessionByTokenHash(hashToken(token));
  if (!session || session.expiresAt < new Date()) return res.json({ authenticated: false });
  const user = await db.findUserById(session.userId);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email } });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = getSessionToken(req);
  if (token) await db.deleteSessionByTokenHash(hashToken(token));
  clearSessionCookie(res);
  res.json({ loggedOut: true });
}));

// ---------- Paramètres entreprise (réservés à l'utilisateur connecté) ----------
app.get('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const settings = await db.getSettings(req.userId) || {};
  res.json({ ...defaultSettings, ...settings });
}));

app.put('/api/settings', requireAuth, asyncRoute(async (req, res) => {
  const clean = parseInput('settings', req.body, 'Paramètres');
  const settings = { ...defaultSettings, ...clean };
  await db.saveSettings(req.userId, settings);
  req.log.info('Paramètres entreprise enregistrés');
  res.json(settings);
}));

// ---------- Factures (réservées à l'utilisateur connecté) ----------
app.get('/api/invoices', requireAuth, asyncRoute(async (req, res) => {
  const invoices = await db.listInvoices(req.userId);
  res.json(invoices.map(normalizeInvoiceForClient));
}));

app.post('/api/invoices', requireAuth, asyncRoute(async (req, res) => {
  const payload = parseInput('invoice', req.body, 'Facture');

  // Les totaux sont RECALCULÉS côté serveur : le client ne fait pas foi en
  // matière comptable. Un écart est journalisé, jamais rejeté en bloc.
  const totals = money.computeTotals(payload.items);
  const declared = { ht: payload.totalHT, tva: payload.totalTVA, ttc: payload.totalTTC };
  const mismatch = /** @type {('ht'|'tva'|'ttc')[]} */ (['ht', 'tva', 'ttc']).some(key =>
    declared[key] !== undefined && Math.abs(/** @type {number} */ (declared[key]) - totals[key]) > 0.01);
  if (mismatch) {
    req.log.warn('Totaux déclarés incohérents, recalcul serveur appliqué', {
      declared,
      computed: { ht: totals.ht, tva: totals.tva, ttc: totals.ttc }
    });
  }

  const invoice = {
    id: crypto.randomUUID(),
    number: payload.number,
    client: payload.client,
    issueDate: payload.issueDate,
    dueDate: payload.dueDate,
    items: payload.items,
    // Chaînes prêtes à l'affichage (contrat de l'interface existante)…
    totalHT: money.formatAmount(totals.ht),
    totalTVA: money.formatAmount(totals.tva),
    totalTTC: money.formatAmount(totals.ttc),
    // …et montants numériques normalisés pour l'export comptable.
    amounts: { ht: totals.ht, tva: totals.tva, ttc: totals.ttc, byRate: totals.byRate },
    currency: 'EUR',
    type: payload.type || 'FACTURE',
    status: 'BROUILLON',
    createdAt: new Date().toISOString(),
    userId: req.userId
  };
  const savedInvoice = await db.saveInvoice(invoice, req.userId);
  req.log.info('Facture enregistrée', { invoiceId: invoice.id, amountTTC: totals.ttc });
  res.status(201).json(normalizeInvoiceForClient(savedInvoice));
}));

// Identifiant de facture : UUID interne ou numéro métier (clé d'idempotence).
const invoiceIdSchema = v.string({ min: 1, max: 60, singleLine: true });

app.patch('/api/invoices/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const invoiceId = v.validate(invoiceIdSchema, req.params.id, { label: 'Identifiant de facture' });
  const { status } = parseInput('invoiceStatus', req.body, 'Statut de facture');

  // Machine à états : la transition est validée contre le statut réel et
  // courant de la facture (pas contre une copie du client).
  const existing = await db.getInvoice(invoiceId, req.userId);
  if (!existing) throw notFound('Facture introuvable.');
  lifecycle.assertTransition(String(existing.status || 'BROUILLON'), status);

  const updated = await db.updateInvoiceStatus(invoiceId, status, req.userId);
  if (!updated) throw notFound('Facture introuvable.');
  req.log.info('Statut de facture modifié', { invoiceId, status });
  res.json(normalizeInvoiceForClient(updated));
}));

app.patch('/api/invoices/by-number/:number/status', requireAuth, asyncRoute(async (req, res) => {
  const invoiceNumber = v.validate(invoiceIdSchema, req.params.number, { label: 'Numéro de facture' });
  const { status } = parseInput('invoiceStatus', req.body, 'Statut de facture');

  // La transition est contrôlée sur la facture réellement trouvée.
  const invoices = await db.listInvoices(req.userId);
  const existing = invoices.find(invoice => invoice.number === invoiceNumber);
  if (!existing) throw notFound('Facture introuvable.');
  lifecycle.assertTransition(String(existing.status || 'BROUILLON'), status);

  const updated = await db.updateInvoiceByNumber(invoiceNumber, status, req.userId);
  if (!updated) throw notFound('Facture introuvable.');
  req.log.info('Statut de facture modifié', { invoiceNumber, status });
  res.json(normalizeInvoiceForClient(updated));
}));

// ---------- Validation d'une facture (émission comptable) ----------
// Passe un brouillon au statut ENVOYEE et lui alloue son numéro définitif,
// séquentiel et sans trou. Après validation, le contenu est immuable.
app.post('/api/invoices/:id/validate', requireAuth, asyncRoute(async (req, res) => {
  const invoiceId = v.validate(invoiceIdSchema, req.params.id, { label: 'Identifiant de facture' });

  const existing = await db.getInvoice(invoiceId, req.userId);
  if (!existing) throw notFound('Facture introuvable.');
  const currentStatus = String(existing.status || 'BROUILLON');
  lifecycle.assertTransition(currentStatus, 'ENVOYEE');

  // Numéro définitif : alloué dans la section critique de la couche données.
  // Un brouillon créait un numéro libre (éditable) ; la facture émise, elle,
  // porte un numéro de séquence irrévocable.
  const allocation = await db.allocateInvoiceNumber(req.userId);
  const issued = {
    ...existing,
    /** Numéro précédent (brouillon), conservé pour la traçabilité. */
    draftNumber: existing.number !== allocation.number ? existing.number : undefined,
    number: allocation.number,
    status: 'ENVOYEE',
    validatedAt: new Date().toISOString()
  };
  const saved = await db.saveInvoice(issued, req.userId);
  req.log.info('Facture validée et émise', {
    invoiceId,
    number: issued.number,
    draftNumber: issued.draftNumber,
    totalTTC: issued.amounts?.ttc
  });
  res.json(normalizeInvoiceForClient(saved));
}));

// ---------- Édition de contenu (brouillon uniquement) ----------
app.patch('/api/invoices/:id', requireAuth, asyncRoute(async (req, res) => {
  const invoiceId = v.validate(invoiceIdSchema, req.params.id, { label: 'Identifiant de facture' });
  const payload = parseInput('invoice', req.body, 'Facture');

  const existing = await db.getInvoice(invoiceId, req.userId);
  if (!existing) throw notFound('Facture introuvable.');
  // Garde d'immuabilité : une facture émise ne se modifie pas, jamais.
  lifecycle.assertContentEditable(existing);

  const totals = money.computeTotals(payload.items);
  const updated = {
    ...existing,
    number: payload.number,
    client: payload.client,
    issueDate: payload.issueDate,
    dueDate: payload.dueDate,
    items: payload.items,
    totalHT: money.formatAmount(totals.ht),
    totalTVA: money.formatAmount(totals.tva),
    totalTTC: money.formatAmount(totals.ttc),
    amounts: { ht: totals.ht, tva: totals.tva, ttc: totals.ttc, byRate: totals.byRate },
    type: payload.type || existing.type || 'FACTURE'
  };
  const saved = await db.saveInvoice(updated, req.userId);
  req.log.info('Brouillon de facture modifié', { invoiceId });
  res.json(normalizeInvoiceForClient(saved));
}));

// ---------- Téléchargement PDF (+ Factur-X pour les factures émises) ----------
app.get('/api/invoices/:id/pdf', requireAuth, asyncRoute(async (req, res) => {
  const invoiceId = v.validate(invoiceIdSchema, req.params.id, { label: 'Identifiant de facture' });
  const invoice = await db.getInvoice(invoiceId, req.userId);
  if (!invoice) throw notFound('Facture introuvable.');

  const userSettings = await db.getSettings(req.userId) || {};
  const company = { ...defaultSettings, ...userSettings };
  const pdfBuffer = await createInvoicePdf({ ...invoice, company });

  // Une facture ÉMISE embarque son XML CII EN 16931 (Factur-X PDF/A-3) :
  // c'est le format exigé par la réforme de la facturation électronique.
  // Les brouillons et les devis restent des PDF simples.
  const status = String(invoice.status || 'BROUILLON');
  const isFacturx = lifecycle.isIssued(status)
    && (invoice.type || 'FACTURE') === 'FACTURE'
    && Array.isArray(invoice.items) && invoice.items.length > 0;

  let finalPdf = pdfBuffer;
  if (isFacturx) {
    const xml = facturx.buildFacturxXml({
      number: String(invoice.number),
      client: String(invoice.client),
      issueDate: String(invoice.issueDate),
      dueDate: invoice.dueDate ? String(invoice.dueDate) : '',
      items: /** @type {Array<{ description?: string, quantity?: number, price?: number, taxRate?: number }>} */ (invoice.items),
      company
    });
    finalPdf = facturx.appendFacturxToPdf(pdfBuffer, xml);
    req.log.info('PDF Factur-X généré', { invoiceId, number: invoice.number });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${String(invoice.number).replace(/[^\w.-]/g, '_')}.pdf"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(finalPdf);
}));

// ---------- Paiement Stripe (public) ----------
app.post('/api/checkout', asyncRoute(async (req, res) => {
  const { plan, email: customerEmail } = parseInput('checkout', req.body, 'Paiement');
  if (!stripe) throw serviceUnavailable('Paiement temporairement indisponible.', 'STRIPE_NOT_CONFIGURED');
  const selectedPlan = plans[plan];

  // Clé d'idempotence stable sur toutes les tentatives de cette requête :
  // un rejeu réseau ne peut pas créer deux sessions de paiement.
  const idempotencyKey = `checkout-${req.id}-${crypto.randomUUID()}`;

  // Appel réseau externe résilient : reprise + erreur 503 explicite.
  const session = await stripeCall(
    () => stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: customerEmail || undefined,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: selectedPlan.name, description: selectedPlan.description },
          unit_amount: selectedPlan.amount,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      metadata: { plan },
      success_url: `${publicUrl}/dashboard.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl}/index.html#tarifs`
    }, { idempotencyKey }),
    { requestId: req.id, action: 'création de session' }
  );

  // L'enregistrement ne doit jamais faire échouer une session de paiement déjà créée.
  try {
    await db.saveOrder({
      id: crypto.randomUUID(),
      checkoutSessionId: session.id,
      plan,
      amount: selectedPlan.amount,
      currency: 'eur',
      status: 'pending',
      createdAt: new Date().toISOString()
    });
  } catch (orderError) {
    logger.error('Commande non enregistrée', { requestId: req.id, cause: orderError });
  }

  res.json({ url: session.url });
}));

// ---------- Vérification du paiement au retour (fallback sans webhook) ----------
const stripeSessionIdSchema = v.string({
  min: 4,
  max: 200,
  singleLine: true,
  pattern: /^cs_[A-Za-z0-9_]+$/,
  patternMessage: 'Identifiant de session invalide.'
});

app.get('/api/checkout/verify', asyncRoute(async (req, res) => {
  const sessionId = v.validate(stripeSessionIdSchema, req.query.session_id, { label: 'Session de paiement' });
  if (!stripe) throw serviceUnavailable('Paiement temporairement indisponible.', 'STRIPE_NOT_CONFIGURED');

  const session = await stripeCall(
    () => stripe.checkout.sessions.retrieve(sessionId),
    { requestId: req.id, action: 'lecture de session' }
  );

  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return res.json({ status: 'pending' });
  }

  // Le client a payé : on renvoie toujours le statut payé même si
  // l'enregistrement local échoue (journalisé pour retraitement manuel).
  try {
    await db.saveOrder({
      id: session.id,
      customerEmail: session.customer_details?.email || null,
      plan: session.metadata?.plan || 'unknown',
      amount: session.amount_total || 0,
      currency: session.currency || 'eur',
      status: 'paid',
      paidAt: new Date().toISOString()
    });
  } catch (orderError) {
    req.log.error('Commande payée non enregistrée lors de la vérification', { cause: orderError });
  }

  res.json({ status: 'paid', plan: session.metadata?.plan || 'unknown' });
}));

// ---------- Envoi email (réservé à l'utilisateur connecté) ----------
app.post('/api/invoices/email', requireAuth, asyncRoute(async (req, res) => {
  const payload = parseInput('invoiceEmail', req.body, 'Envoi de facture');
  const emailRecipient = payload.clientEmail || payload.recipient;
  const invoiceNumber = payload.documentId || payload.documentNumber;
  if (!mailer) throw serviceUnavailable('Envoi d’email non configuré.', 'SMTP_NOT_CONFIGURED');
  if (!emailRecipient) throw badRequest('Adresse du destinataire obligatoire.', 'INVALID_RECIPIENT');

  // Les montants affichés sont TOUJOURS remis en forme par le serveur :
  // aucune chaîne brute du client n'atteint le PDF ou l'email.
  const computed = money.computeTotals(payload.items || []);
  const totals = {
    ht: money.formatAmount(payload.totalHT ?? computed.ht),
    tva: money.formatAmount(payload.totalTVA ?? computed.tva),
    ttc: money.formatAmount(payload.totalTTC ?? computed.ttc)
  };
  // Les lignes vides de l'éditeur (aucune description, aucun prix) sont écartées.
  const items = (payload.items || []).filter(item => item.description || item.price !== 0);

  const userSettings = await db.getSettings(req.userId) || {};
  const company = { ...defaultSettings, ...userSettings };
  const pdf = await createInvoicePdf({
    documentNumber: invoiceNumber,
    client: payload.client,
    issueDate: payload.issueDate,
    dueDate: payload.dueDate,
    totalHT: totals.ht,
    totalTVA: totals.tva,
    totalTTC: totals.ttc,
    items,
    company
  });

  const safeMessage = payload.message || `Veuillez trouver ci-joint votre facture ${invoiceNumber}.`;
  await sendMail({
    from: `"IZI" <${env.get('MAIL_FROM') || env.get('SMTP_USER')}>`,
    to: emailRecipient,
    subject: payload.subject || `Votre facture ${invoiceNumber} — IZI SAS`,
    text: payload.message || `Madame, Monsieur ${payload.client},\n\nVeuillez trouver ci-joint votre facture ${invoiceNumber}.\nDate d'émission : ${payload.issueDate}\nDate d'échéance : ${payload.dueDate}\nTotal HT : ${totals.ht}\nTVA : ${totals.tva}\nTotal TTC : ${totals.ttc}\n\nNous restons à votre disposition pour toute information complémentaire.\n\nCordialement,\nIZI SAS`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;border:1px solid #e2e6ef;border-radius:14px;overflow:hidden"><div style="background:linear-gradient(135deg,#4c1d95,#7c3aed 65%,#9333ea);padding:22px;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:#ffffff;border-radius:10px;width:46px;height:46px;text-align:center;vertical-align:middle"><span style="color:#4c1d95;font-size:17px;font-weight:800;letter-spacing:1px">IZI</span></td></tr></table></div><div style="padding:26px"><p style="font-size:15px;line-height:1.6">${escapeHtml(safeMessage).replaceAll('\n', '<br>')}</p><p style="font-size:15px;line-height:1.6">Nous restons à votre disposition pour toute information complémentaire.</p><p style="font-size:15px">Cordialement,<br><strong>IZI SAS</strong></p><p style="font-size:11px;color:#6b7280;border-top:1px solid #e2e6ef;padding-top:12px;margin-top:18px">Cet email et sa pièce jointe sont destinés exclusivement à leur destinataire. © 2026 IZI SAS — izifacture@gmail.com</p></div></div>`,
    attachments: [{ filename: `${invoiceNumber}.pdf`, content: pdf }]
  }, { requestId: req.id, context: `facture ${invoiceNumber}` });
  req.log.info('Facture envoyée par email', { invoiceNumber, totalTTC: totals.ttc });
  res.json({ sent: true });
}));

// ---------- Administration ----------
app.get('/api/orders', requireAdmin, asyncRoute(async (req, res) => {
  res.json(await db.listOrders());
}));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    database: db.backend(),
    envOk: envReport.ok,
    stripeConfigured: Boolean(stripe),
    smtpConfigured: Boolean(mailer)
  });
});

// Derniers maillons de la chaîne Express : route inconnue, puis gestion
// centralisée des erreurs (aucune fuite technique vers le client).
app.use(notFoundHandler);
app.use(createErrorHandler({ logger }));

if (env.get('VERCEL') !== '1') {
  app.listen(port, () => {
    logger.info('Serveur IZI démarré', {
      url: publicUrl,
      database: db.backend(),
      stripe: Boolean(stripe),
      smtp: Boolean(mailer),
      envOk: envReport.ok,
      mode: isProduction ? 'production' : 'développement'
    });
  });
}

module.exports = app;