// ============================================================
// db.js — Couche d'accès aux données d'IZI
// ------------------------------------------------------------
// Deux modes de fonctionnement :
//   1. Supabase (production) : activé quand SUPABASE_URL et
//      SUPABASE_SERVICE_ROLE_KEY sont définis dans .env.
//      La clé de service ne quitte JAMAIS le serveur : chaque
//      requête est filtrée par user_id côté serveur.
//   2. Fichiers locaux (développement) : repli dans data/*.json
//      avec la même isolation par utilisateur.
// ============================================================
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

let supabaseClient = null;
if (useSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

const dataDirectory = path.join(__dirname, 'data');
const usersFile = path.join(dataDirectory, 'users.json');
const sessionsFile = path.join(dataDirectory, 'sessions.json');
const invoicesFile = path.join(dataDirectory, 'invoices.json');
const settingsFile = path.join(dataDirectory, 'settings.json');
const ordersFile = path.join(dataDirectory, 'orders.json');

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

// Nom du backend actif (affiché par /api/health).
function backend() {
  return useSupabase ? 'supabase' : 'fichiers locaux';
}

// ---------- Utilisateurs ----------
async function findUserByEmail(email) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('profiles').select('*').eq('email', email).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }
  const users = await readJson(usersFile, []);
  return users.find(user => user.email === email);
}

async function findUserById(id) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }
  const users = await readJson(usersFile, []);
  return users.find(user => user.id === id);
}

async function createUser(user) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('profiles').insert({
      id: user.id,
      name: user.name,
      email: user.email,
      password_hash: user.passwordHash,
      created_at: user.createdAt
    });
    if (error) throw new Error(error.message);
    return user;
  }
  const users = await readJson(usersFile, []);
  users.push({
    id: user.id,
    name: user.name,
    email: user.email,
    passwordHash: user.passwordHash,
    createdAt: user.createdAt
  });
  await writeJson(usersFile, users);
  return user;
}

// ---------- Sessions ----------
async function createSession({ tokenHash, userId, createdAt, expiresAt }) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('sessions').insert({
      token_hash: tokenHash,
      user_id: userId,
      expires_at: expiresAt
    });
    if (error) throw new Error(error.message);
    return;
  }
  const sessions = await readJson(sessionsFile, []);
  sessions.push({
    tokenHash,
    userId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  });
  await writeJson(sessionsFile, sessions);
}

async function findSessionByTokenHash(tokenHash) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('sessions').select('*').eq('token_hash', tokenHash).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { userId: data.user_id, expiresAt: new Date(data.expires_at) };
  }
  const sessions = await readJson(sessionsFile, []);
  const session = sessions.find(item => item.tokenHash === tokenHash);
  return session ? { userId: session.userId, expiresAt: new Date(session.expiresAt) } : null;
}

async function deleteSessionByTokenHash(tokenHash) {
  if (useSupabase) {
    const { error } = await supabaseClient
      .from('sessions').delete().eq('token_hash', tokenHash);
    if (error) throw new Error(error.message);
    return;
  }
  const sessions = await readJson(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.tokenHash !== tokenHash));
}

// ---------- Factures ----------
async function listInvoices(userId) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('invoices').select('data').eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(row => row.data);
  }
  const invoices = await readJson(invoicesFile, []);
  return invoices
    .filter(invoice => invoice.userId === userId || invoice.userId == null)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function saveInvoice(invoice, userId) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('invoices').upsert(
      { id: invoice.id, user_id: userId, data: invoice, updated_at: new Date() },
      { onConflict: 'id' }
    );
    if (error) throw new Error(error.message);
    return invoice;
  }
  const invoices = await readJson(invoicesFile, []);
  const index = invoices.findIndex(item => item.id === invoice.id);
  if (index >= 0) {
    invoices[index] = { ...invoice, updatedAt: new Date().toISOString() };
  } else {
    invoices.unshift(invoice);
  }
  await writeJson(invoicesFile, invoices);
  return invoice;
}

async function updateInvoiceStatus(invoiceId, status, userId) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('invoices').select('data').eq('id', invoiceId).eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const updated = { ...data.data, status, updatedAt: new Date().toISOString() };
    const { error: updateError } = await supabaseClient
      .from('invoices').update({ data: updated, updated_at: new Date() })
      .eq('id', invoiceId).eq('user_id', userId);
    if (updateError) throw new Error(updateError.message);
    return updated;
  }
  const invoices = await readJson(invoicesFile, []);
  const index = invoices.findIndex(item =>
    item.id === invoiceId && (item.userId === userId || item.userId == null));
  if (index < 0) return null;
  const updated = { ...invoices[index], status, updatedAt: new Date().toISOString() };
  invoices[index] = updated;
  await writeJson(invoicesFile, invoices);
  return updated;
}

async function updateInvoiceByNumber(number, status, userId) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('invoices').select('*').eq('user_id', userId);
    if (error) throw new Error(error.message);
    const row = (data || []).find(item => item.data?.number === number);
    if (row) {
      const updated = { ...row.data, status, updatedAt: new Date().toISOString() };
      const { error: updateError } = await supabaseClient
        .from('invoices').update({ data: updated, updated_at: new Date() }).eq('id', row.id);
      if (updateError) throw new Error(updateError.message);
      return updated;
    }
    const invoice = { id: crypto.randomUUID(), number, status, type: 'FACTURE', createdAt: new Date().toISOString() };
    const { error: insertError } = await supabaseClient.from('invoices').insert({
      id: invoice.id, user_id: userId, data: invoice, updated_at: new Date()
    });
    if (insertError) throw new Error(insertError.message);
    return invoice;
  }
  const invoices = await readJson(invoicesFile, []);
  const index = invoices.findIndex(item =>
    item.number === number && (item.userId === userId || item.userId == null));
  if (index >= 0) {
    const updated = { ...invoices[index], status, updatedAt: new Date().toISOString() };
    invoices[index] = updated;
    await writeJson(invoicesFile, invoices);
    return updated;
  }
  const invoice = {
    id: crypto.randomUUID(), number, status, type: 'FACTURE',
    createdAt: new Date().toISOString(), userId
  };
  invoices.unshift(invoice);
  await writeJson(invoicesFile, invoices);
  return invoice;
}

// ---------- Paramètres entreprise ----------
function normalizeSettingsContainer(stored) {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)
      && 'legacy' in stored && 'byUser' in stored) {
    return stored;
  }
  return {
    legacy: stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {},
    byUser: {}
  };
}

async function getSettings(userId) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('settings').select('data').eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.data || {};
  }
  const stored = await readJson(settingsFile, null);
  if (!stored) return {};
  const container = normalizeSettingsContainer(stored);
  return { ...(container.legacy || {}), ...(container.byUser[userId] || {}) };
}

async function saveSettings(userId, settings) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('settings').upsert(
      { user_id: userId, data: settings, updated_at: new Date() },
      { onConflict: 'user_id' }
    );
    if (error) throw new Error(error.message);
    return settings;
  }
  const stored = await readJson(settingsFile, {});
  const container = normalizeSettingsContainer(stored);
  container.byUser[userId] = settings;
  await writeJson(settingsFile, container);
  return settings;
}

// ---------- Commandes (admin / Stripe) ----------
async function listOrders() {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('orders').select('data').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(row => row.data);
  }
  return readJson(ordersFile, []);
}

async function saveOrder(order) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('orders').upsert(
      { id: order.id, data: order, created_at: new Date() },
      { onConflict: 'id' }
    );
    if (error) throw new Error(error.message);
    return;
  }
  const orders = await readJson(ordersFile, []);
  const index = orders.findIndex(item =>
    item.id === order.id || (order.checkoutSessionId && item.checkoutSessionId === order.checkoutSessionId));
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  else orders.unshift(order);
  await writeJson(ordersFile, orders);
}

async function updateOrderStatusBySessionId(checkoutSessionId, status) {
  const orders = await readJson(ordersFile, []);
  const order = orders.find(item => item.checkoutSessionId === checkoutSessionId);
  if (order) {
    order.status = status;
    await writeJson(ordersFile, orders);
  }
}

module.exports = {
  backend,
  findUserByEmail,
  findUserById,
  createUser,
  createSession,
  findSessionByTokenHash,
  deleteSessionByTokenHash,
  listInvoices,
  saveInvoice,
  updateInvoiceStatus,
  updateInvoiceByNumber,
  getSettings,
  saveSettings,
  listOrders,
  saveOrder,
  updateOrderStatusBySessionId
};