// ============================================================
// IZI — Serveur Express
// Sécurité : scrypt + sel, sessions HttpOnly (token haché),
// rate limiting, isolation par utilisateur, jeton admin
// comparé en temps constant.
// ============================================================
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('node:crypto');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT || 4242);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

const stripe = process.env.STRIPE_SECRET_KEY?.startsWith('sk_')
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = value => String(value || '').trim().toLowerCase();

function normalizeInvoiceForClient(invoice) {
  const { userId, ...rest } = invoice;
  return rest;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[character]));
}

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
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  }
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected === 'change-this-token' || !safeEqual(req.get('x-admin-token'), expected)) {
    return res.status(401).json({ error: 'Accès administrateur requis.' });
  }
  next();
}

async function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ authenticated: false, error: 'Connexion requise.' });
  try {
    const session = await db.findSessionByTokenHash(hashToken(token));
    if (!session || session.expiresAt < new Date()) {
      clearSessionCookie(res);
      return res.status(401).json({ authenticated: false, error: 'Session expirée. Reconnectez-vous.' });
    }
    const user = await db.findUserById(session.userId);
    if (!user) return res.status(401).json({ authenticated: false, error: 'Utilisateur introuvable.' });
    req.userId = user.id;
    req.user = { id: user.id, name: user.name, email: user.email };
    next();
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur lors de l’authentification.' });
  }
}

// Capture les erreurs des handlers async (Express 4 ne le fait pas).
const asyncRoute = handler => (req, res) => {
  Promise.resolve(handler(req, res)).catch(error => {
    console.error('API error:', error.message);
    res.status(500).json({ error: 'Erreur serveur inattendue.' });
  });
};

app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json());
app.use(express.static(__dirname));

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
    document.font('Helvetica').fontSize(8).fillColor('#687386').text('Document généré électroniquement par IZI SAS — contact@izifacture.fr', 50, 750);
    document.end();
  });
}

// ---------- Webhook Stripe ----------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook non configuré');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook invalide : ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await db.saveOrder({
      id: session.id,
      customerEmail: session.customer_details?.email || null,
      plan: session.metadata?.plan || 'unknown',
      amount: session.amount_total || 0,
      currency: session.currency || 'eur',
      status: 'paid',
      paidAt: new Date().toISOString()
    });
  }

  res.json({ received: true });
}));

// ---------- Authentification ----------
app.post('/api/auth/register', authRateLimit, asyncRoute(async (req, res) => {
  const { name, email, password } = req.body || {};
  const displayName = String(name || '').trim();
  const normalizedEmail = normalizeEmail(email);
  const passwordValue = String(password || '');

  if (displayName.length < 2 || displayName.length > 80) {
    return res.status(400).json({ error: 'Le nom doit contenir entre 2 et 80 caractères.' });
  }
  if (!EMAIL_RE.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (passwordValue.length < 8 || passwordValue.length > 128) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 128 caractères.' });
  }
  if (await db.findUserByEmail(normalizedEmail)) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
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
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
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
          'Pour toute question, notre service client se tient à votre disposition : contact@izifacture.fr',
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
          <div style="background:#172033;color:#cbd5e1;text-align:center;padding:14px;font-size:12px">© 2026 IZI SAS — contact@izifacture.fr — Mentions légales disponibles sur notre site</div>
        </div>`
      });
      console.log(`Email de confirmation d'inscription envoyé à ${user.email}`);
    } catch (error) {
      console.error(`Échec de l'envoi du mail de confirmation à ${user.email} : ${error.message}`);
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
        console.log(`Notification d'inscription envoyée à l'équipe`);
      } catch (error) {
        console.error(`Échec de la notification équipe : ${error.message}`);
      }
    }
  } else {
    console.log('SMTP non configuré : pas d\'email de confirmation envoyé');
  }

  res.status(201).json({ user: { id: user.id, name: user.name, email: user.email } });
}));

app.post('/api/auth/login', authRateLimit, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const user = await db.findUserByEmail(normalizedEmail);
  const passwordValue = String(password || '');
  if (!user || !(await verifyPassword(passwordValue, user.passwordHash))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }
  await createSessionForUser(res, user.id);
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
  const allowedKeys = ['legalName', 'registration', 'ninea', 'plater', 'billingEmail', 'billingAddress', 'phone'];
  const clean = {};
  for (const key of allowedKeys) {
    if (typeof req.body?.[key] === 'string') clean[key] = req.body[key].slice(0, 200).trim();
  }
  const settings = { ...defaultSettings, ...clean };
  await db.saveSettings(req.userId, settings);
  res.json(settings);
}));

// ---------- Factures (réservées à l'utilisateur connecté) ----------
app.get('/api/invoices', requireAuth, asyncRoute(async (req, res) => {
  const invoices = await db.listInvoices(req.userId);
  res.json(invoices.map(normalizeInvoiceForClient));
}));

app.post('/api/invoices', requireAuth, asyncRoute(async (req, res) => {
  const { number, client, issueDate, dueDate, items = [], totalHT, totalTVA, totalTTC, type = 'FACTURE' } = req.body || {};
  if (!number || !client || !issueDate || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Numéro, client, date et au moins une prestation sont obligatoires.' });
  }
  const invoice = {
    id: crypto.randomUUID(),
    number,
    client,
    issueDate,
    dueDate,
    items,
    totalHT,
    totalTVA,
    totalTTC,
    type,
    status: 'BROUILLON',
    createdAt: new Date().toISOString(),
    userId: req.userId
  };
  const savedInvoice = await db.saveInvoice(invoice, req.userId);
  res.status(201).json(normalizeInvoiceForClient(savedInvoice));
}));

app.patch('/api/invoices/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const allowedStatuses = ['BROUILLON', 'ENVOYEE', 'PAYEE', 'RETARD', 'ATTENTE'];
  const { status } = req.body || {};
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Statut de facture invalide.' });

  const updated = await db.updateInvoiceStatus(req.params.id, status, req.userId);
  if (!updated) return res.status(404).json({ error: 'Facture introuvable.' });
  res.json(normalizeInvoiceForClient(updated));
}));

app.patch('/api/invoices/by-number/:number/status', requireAuth, asyncRoute(async (req, res) => {
  const allowedStatuses = ['BROUILLON', 'ENVOYEE', 'PAYEE', 'RETARD', 'ATTENTE'];
  const { status } = req.body || {};
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Statut de facture invalide.' });

  const updated = await db.updateInvoiceByNumber(req.params.number, status, req.userId);
  res.json(normalizeInvoiceForClient(updated));
}));

// ---------- Paiement Stripe (public) ----------
app.post('/api/checkout', asyncRoute(async (req, res) => {
  const { plan, email } = req.body || {};
  const selectedPlan = plans[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Plan inconnu' });
  if (!stripe) return res.status(503).json({ error: 'Stripe n’est pas encore configuré. Ajoutez STRIPE_SECRET_KEY dans .env.' });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: typeof email === 'string' && email ? email : undefined,
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
  });

  await db.saveOrder({
    id: crypto.randomUUID(),
    checkoutSessionId: session.id,
    plan,
    amount: selectedPlan.amount,
    currency: 'eur',
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  res.json({ url: session.url });
}));

// ---------- Vérification du paiement au retour (fallback sans webhook) ----------
app.get('/api/checkout/verify', asyncRoute(async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!stripe) return res.status(503).json({ error: 'Stripe non configuré.' });
  if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Identifiant de session invalide.' });

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    return res.status(400).json({ error: 'Session de paiement introuvable.' });
  }

  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return res.json({ status: 'pending' });
  }

  await db.saveOrder({
    id: session.id,
    customerEmail: session.customer_details?.email || null,
    plan: session.metadata?.plan || 'unknown',
    amount: session.amount_total || 0,
    currency: session.currency || 'eur',
    status: 'paid',
    paidAt: new Date().toISOString()
  });

  res.json({ status: 'paid', plan: session.metadata?.plan || 'unknown' });
}));

// ---------- Envoi email (réservé à l'utilisateur connecté) ----------
app.post('/api/invoices/email', requireAuth, asyncRoute(async (req, res) => {
  const {
    recipient, clientEmail, documentNumber, documentId, client, subject, message,
    issueDate, dueDate, totalHT, totalTVA, totalTTC, items = []
  } = req.body || {};
  const emailRecipient = clientEmail || recipient;
  const invoiceNumber = documentId || documentNumber;
  if (!mailer) return res.status(503).json({ error: 'Envoi email non configuré. Ajoutez les paramètres SMTP dans .env.' });
  if (!emailRecipient || !invoiceNumber || !client) return res.status(400).json({ error: 'Destinataire et informations de facture obligatoires.' });

  const userSettings = await db.getSettings(req.userId) || {};
  const company = { ...defaultSettings, ...userSettings };
  const pdf = await createInvoicePdf({ documentNumber: invoiceNumber, client, issueDate, dueDate, totalHT, totalTVA, totalTTC, items, company });
  await mailer.sendMail({
    from: `"IZI" <${process.env.MAIL_FROM || process.env.SMTP_USER}>`,
    to: emailRecipient,
    subject: subject || `Votre facture ${invoiceNumber} — IZI SAS`,
    text: message || `Madame, Monsieur ${client},\n\nVeuillez trouver ci-joint votre facture ${invoiceNumber}.\nDate d'émission : ${issueDate}\nDate d'échéance : ${dueDate}\nTotal HT : ${totalHT}\nTVA : ${totalTVA}\nTotal TTC : ${totalTTC}\n\nNous restons à votre disposition pour toute information complémentaire.\n\nCordialement,\nIZI SAS`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033;border:1px solid #e2e6ef;border-radius:14px;overflow:hidden"><div style="background:linear-gradient(135deg,#4c1d95,#7c3aed 65%,#9333ea);padding:22px;text-align:center"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="background:#ffffff;border-radius:10px;width:46px;height:46px;text-align:center;vertical-align:middle"><span style="color:#4c1d95;font-size:17px;font-weight:800;letter-spacing:1px">IZI</span></td></tr></table></div><div style="padding:26px"><p style="font-size:15px;line-height:1.6">${escapeHtml(message || `Veuillez trouver ci-joint votre facture ${invoiceNumber}.`).replaceAll('\n', '<br>')}</p><p style="font-size:15px;line-height:1.6">Nous restons à votre disposition pour toute information complémentaire.</p><p style="font-size:15px">Cordialement,<br><strong>IZI SAS</strong></p><p style="font-size:11px;color:#6b7280;border-top:1px solid #e2e6ef;padding-top:12px;margin-top:18px">Cet email et sa pièce jointe sont destinés exclusivement à leur destinataire. © 2026 IZI SAS — contact@izifacture.fr</p></div></div>`,
    attachments: [{ filename: `${invoiceNumber}.pdf`, content: pdf }]
  });
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
    stripeConfigured: Boolean(stripe),
    smtpConfigured: Boolean(mailer)
  });
});

if (process.env.VERCEL !== '1') {
  app.listen(port, () => {
    console.log(`IZI disponible sur ${publicUrl}`);
    console.log(`Base de données : ${db.backend()}`);
    console.log(`Stripe ${stripe ? 'configuré' : 'en attente de configuration'}`);
  });
}

module.exports = app;