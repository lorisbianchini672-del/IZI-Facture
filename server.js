require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDirectory = path.join(__dirname, 'data');
const ordersFile = path.join(dataDirectory, 'orders.json');
const invoicesFile = path.join(dataDirectory, 'invoices.json');
const settingsFile = path.join(dataDirectory, 'settings.json');
const app = express();
const port = Number(process.env.PORT || 4242);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
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
  pro: { name: 'Pro Lyon', amount: 990, description: 'Abonnement mensuel Pro Lyon' },
  business: { name: 'Business & Équipe', amount: 2490, description: 'Abonnement mensuel Business & Équipe' }
};

async function readOrders() {
  try {
    return JSON.parse(await fs.readFile(ordersFile, 'utf8'));
  } catch {
    return [];
  }
}

async function writeOrders(orders) {
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(ordersFile, JSON.stringify(orders, null, 2));
}

const defaultSettings = {
  legalName: 'iziFacture SAS',
  registration: '849 203 118 00024',
  ninea: '',
  plater: '',
  billingEmail: '',
  billingAddress: 'Métropole de Lyon',
  phone: ''
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

async function readInvoices() {
  return readJson(invoicesFile, []);
}

async function saveInvoice(invoice) {
  const invoices = await readInvoices();
  const existingIndex = invoices.findIndex(item => item.number === invoice.number);
  if (existingIndex >= 0) {
    invoice = { ...invoices[existingIndex], ...invoice, id: invoices[existingIndex].id, updatedAt: new Date().toISOString() };
    invoices[existingIndex] = invoice;
  } else {
    invoices.unshift(invoice);
  }
  await writeJson(invoicesFile, invoices);
  return invoice;
}

function createInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ margin: 50 });
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    document.fontSize(22).fillColor('#7137d8').text(invoice.company?.legalName || 'iziFacture SAS');
    document.fontSize(9).fillColor('#687386').text([
      invoice.company?.registration && `RC / SIRET : ${invoice.company.registration}`,
      invoice.company?.ninea && `NINEA : ${invoice.company.ninea}`,
      invoice.company?.plater && `PLATO : ${invoice.company.plater}`,
      invoice.company?.billingEmail
    ].filter(Boolean).join(' | '));
    document.moveDown().fontSize(18).fillColor('#172033').text(`FACTURE ${invoice.documentNumber}`);
    document.fontSize(10).fillColor('#687386').text(`Client : ${invoice.client}`);
    document.text(`Émission : ${invoice.issueDate} | Échéance : ${invoice.dueDate}`);
    document.moveDown();
    document.fontSize(11).fillColor('#172033');
    invoice.items.forEach(item => document.text(`${item.description} — ${item.quantity} x ${item.price} € HT — TVA ${item.taxRate}`));
    document.moveDown().text(`Total HT : ${invoice.totalHT}`);
    document.text(`TVA : ${invoice.totalTVA}`);
    document.fontSize(14).text(`Total TTC : ${invoice.totalTTC}`);
    document.end();
  });
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

async function saveOrder(order) {
  const orders = await readOrders();
  const existingIndex = orders.findIndex(item => item.id === order.id || (order.checkoutSessionId && item.checkoutSessionId === order.checkoutSessionId));
  if (existingIndex >= 0) orders[existingIndex] = { ...orders[existingIndex], ...order };
  else orders.unshift(order);
  await writeOrders(orders);
}

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Accès administrateur requis' });
  }
  next();
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
    await saveOrder({
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
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/settings', async (req, res) => {
  res.json({ ...defaultSettings, ...await readJson(settingsFile, {}) });
});

app.put('/api/settings', async (req, res) => {
  const settings = { ...defaultSettings, ...req.body };
  await writeJson(settingsFile, settings);
  res.json(settings);
});

app.get('/api/invoices', async (req, res) => {
  res.json(await readInvoices());
});

app.post('/api/invoices', async (req, res) => {
  const { number, client, issueDate, dueDate, items = [], totalHT, totalTVA, totalTTC, type = 'FACTURE' } = req.body;
  if (!number || !client || !issueDate || !items.length) {
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
    createdAt: new Date().toISOString()
  };
  const savedInvoice = await saveInvoice(invoice);
  res.status(savedInvoice.updatedAt ? 200 : 201).json(savedInvoice);
});

app.patch('/api/invoices/:id/status', async (req, res) => {
  const allowedStatuses = ['BROUILLON', 'ENVOYEE', 'PAYEE', 'RETARD', 'ATTENTE'];
  const { status } = req.body;
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Statut de facture invalide.' });

  const invoices = await readInvoices();
  const index = invoices.findIndex(invoice => invoice.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Facture introuvable.' });
  invoices[index] = { ...invoices[index], status, updatedAt: new Date().toISOString() };
  await writeJson(invoicesFile, invoices);
  res.json(invoices[index]);
});

app.patch('/api/invoices/by-number/:number/status', async (req, res) => {
  const allowedStatuses = ['BROUILLON', 'ENVOYEE', 'PAYEE', 'RETARD', 'ATTENTE'];
  const { status } = req.body;
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Statut de facture invalide.' });

  const invoices = await readInvoices();
  const index = invoices.findIndex(invoice => invoice.number === req.params.number);
  if (index >= 0) {
    invoices[index] = { ...invoices[index], status, updatedAt: new Date().toISOString() };
  } else {
    invoices.push({ id: crypto.randomUUID(), number: req.params.number, status, type: 'FACTURE', createdAt: new Date().toISOString() });
  }
  await writeJson(invoicesFile, invoices);
  res.json(invoices[index >= 0 ? index : invoices.length - 1]);
});

app.post('/api/checkout', async (req, res) => {
  const { plan, email } = req.body;
  const selectedPlan = plans[plan];
  if (!selectedPlan) return res.status(400).json({ error: 'Plan inconnu' });
  if (!stripe) return res.status(503).json({ error: 'Stripe n’est pas encore configuré. Ajoutez STRIPE_SECRET_KEY dans .env.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email || undefined,
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
      success_url: `${publicUrl}/dashboard.html?payment=success`,
      cancel_url: `${publicUrl}/index.html#tarifs`
    });

    await saveOrder({
      id: crypto.randomUUID(),
      checkoutSessionId: session.id,
      plan,
      amount: selectedPlan.amount,
      currency: 'eur',
      status: 'pending',
      createdAt: new Date().toISOString()
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/invoices/email', async (req, res) => {
  const {
    recipient,
    clientEmail,
    documentNumber,
    documentId,
    client,
    subject,
    message,
    issueDate,
    dueDate,
    totalHT,
    totalTVA,
    totalTTC,
    items = []
  } = req.body;
  const emailRecipient = clientEmail || recipient;
  const invoiceNumber = documentId || documentNumber;
  if (!mailer) return res.status(503).json({ error: 'Envoi email non configuré. Ajoutez les paramètres SMTP dans .env.' });
  if (!emailRecipient || !invoiceNumber || !client) return res.status(400).json({ error: 'Destinataire et informations de facture obligatoires.' });

  try {
    const company = { ...defaultSettings, ...await readJson(settingsFile, {}) };
    const pdf = await createInvoicePdf({ documentNumber: invoiceNumber, client, issueDate, dueDate, totalHT, totalTVA, totalTTC, items, company });
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: emailRecipient,
      subject: subject || `Votre facture ${invoiceNumber} — iziFacture`,
      text: message || `Bonjour ${client},\n\nVoici votre facture ${invoiceNumber}.\nDate d'émission : ${issueDate}\nDate d'échéance : ${dueDate}\nTotal HT : ${totalHT}\nTVA : ${totalTVA}\nTotal TTC : ${totalTTC}\n\nCordialement,\niziFacture SAS`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#172033"><h2 style="color:#7137d8">iziFacture</h2><p>${escapeHtml(message || `Votre facture ${invoiceNumber} est jointe à cet email.`).replaceAll('\n', '<br>')}</p><p>Cordialement,<br>iziFacture SAS</p></div>`,
      attachments: [{ filename: `${invoiceNumber}.pdf`, content: pdf }]
    });
    res.json({ sent: true });
  } catch (error) {
    res.status(500).json({ error: `Impossible d'envoyer l'email : ${error.message}` });
  }
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  res.json(await readOrders());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, stripeConfigured: Boolean(stripe) });
});

if (process.env.VERCEL !== '1') {
  app.listen(port, () => {
    console.log(`iziFacture disponible sur ${publicUrl}`);
    console.log(`Stripe ${stripe ? 'configuré' : 'en attente de configuration'}`);
  });
}

module.exports = app;
