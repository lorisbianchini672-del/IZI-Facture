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
// Configuration : lib/env.js charge le .env (chemin absolu) et écarte les
// valeurs d'exemple. Ce module ne journalise ni ne renvoie jamais de secret.
const env = require('./lib/env');
const plans = require('./lib/plans');
const { databaseError } = require('./lib/errors');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPABASE_URL = env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY');
// Les deux variables fonctionnent par paire : une valeur d'exemple ne doit
// jamais activer un backend Supabase factice.
const useSupabase = !env.isPlaceholder(SUPABASE_URL) && !env.isPlaceholder(SUPABASE_SERVICE_ROLE_KEY);

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

// Enveloppe une erreur technique : le client ne reçoit qu'un message générique,
// le détail (Supabase, disque) reste dans les journaux du serveur.
function dataError(error, action, file) {
  const detail = error instanceof Error ? error.message : String(error);
  const label = file ? `${action} ${path.basename(file)}` : action;
  return databaseError(new Error(`${label} : ${detail}`));
}

// Contrôle du résultat d'une requête Supabase ({ data, error }).
function check(error, action) {
  if (error) throw dataError(new Error(error.message), action);
}

// Fichier absent = premier démarrage (valeur par défaut). Toute autre erreur
// (JSON corrompu, permissions, disque) est remontée : la confondre avec un jeu
// de données vide conduirait à écraser des données réelles.
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw dataError(error, 'Lecture impossible de', file);
  }
}

// Écriture atomique : le fichier de destination n'est remplacé qu'une fois le
// contenu complet écrit (évite un fichier tronqué en cas d'incident).
async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(value, null, 2));
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw dataError(error, 'Écriture impossible de', file);
  }
}

// Nom du backend actif (affiché par /api/health).
function backend() {
  return useSupabase ? 'supabase' : 'fichiers locaux';
}

// ---------- Utilisateurs ----------
// Le plan est TOUJOURS normalisé à la lecture : une colonne absente (base
// antérieure à l'ajout de `plan`) ou une valeur inconnue donne le plan
// gratuit. Un compte ne peut jamais se retrouver sans offre exploitable.
function withPlan(user) {
  if (!user) return user;
  return { ...user, plan: plans.normalizePlan(user.plan) };
}

// Une base Supabase antérieure à la migration n'a pas encore la colonne
// `plan`. Sans ce repli, l'inscription renverrait une erreur 500 alors que le
// reste du site fonctionne : on insère alors SANS le plan (le plan gratuit est
// appliqué à la lecture par withPlan). Le cas est signalé une seule fois.
const MISSING_PLAN_COLUMN = /column .*plan.* does not exist|'plan' column/i;
let planColumnMissingWarned = false;

/** Ajoute `plan` à une charge d'insertion, uniquement si la colonne existe. */
function withPlanColumn(row, plan) {
  return planColumnMissingWarned ? row : { ...row, plan };
}

/**
 * Signale, une seule fois par processus, qu'une écriture a été faite sans la
 * colonne `plan` (migration SQL non encore appliquée).
 */
function warnMissingPlanColumn(action) {
  if (planColumnMissingWarned) return;
  planColumnMissingWarned = true;
  console.warn(`[izi] Colonne « plan » absente en base (${action}). `
    + 'Le plan gratuit est appliqué par défaut : appliquez la migration de supabase/schema.sql.');
}

async function findUserByEmail(email) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('profiles').select('*').eq('email', email).maybeSingle();
    check(error, 'Recherche utilisateur par email');
    return withPlan(data);
  }
  const users = await readJson(usersFile, []);
  return withPlan(users.find(user => user.email === email));
}

async function findUserById(id) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('profiles').select('*').eq('id', id).maybeSingle();
    check(error, 'Recherche utilisateur par identifiant');
    return withPlan(data);
  }
  const users = await readJson(usersFile, []);
  return withPlan(users.find(user => user.id === id));
}

async function createUser(user) {
  // Toute inscription démarre sur le plan gratuit : l'offre payante ne
  // s'active que par le webhook Stripe (voir updateUserPlan).
  const plan = plans.normalizePlan(user.plan);
  if (useSupabase) {
    const row = {
      id: user.id,
      name: user.name,
      email: user.email,
      password_hash: user.passwordHash,
      created_at: user.createdAt
    };
    let { error } = await supabaseClient.from('profiles').insert(withPlanColumn(row, plan));
    // Base pas encore migrée : on réessaie sans la colonne `plan` plutôt que
    // de refuser l'inscription. withPlan appliquera le plan gratuit.
    if (error && MISSING_PLAN_COLUMN.test(String(error.message || ''))) {
      warnMissingPlanColumn('inscription');
      ({ error } = await supabaseClient.from('profiles').insert(row));
    }
    check(error, 'Création utilisateur');
    return { ...user, plan };
  }
  const users = await readJson(usersFile, []);
  users.push({
    id: user.id,
    name: user.name,
    email: user.email,
    passwordHash: user.passwordHash,
    plan,
    createdAt: user.createdAt
  });
  await writeJson(usersFile, users);
  return { ...user, plan };
}

/**
 * Change l'offre d'un utilisateur (activation après paiement, rétrogradation).
 * Idempotent : rejouer le même webhook réécrit la même valeur sans effet de bord.
 * Renvoie `null` si le compte n'existe pas (webhook sur email inconnu).
 * @param {string} userId
 * @param {unknown} plan
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function updateUserPlan(userId, plan) {
  const normalized = plans.normalizePlan(plan);
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('profiles').update({ plan: normalized }).eq('id', userId).select('*').maybeSingle();
    // Base pas encore migrée : on ne fait pas échouer le webhook Stripe (la
    // commande est déjà encaissée). Le compte reste en plan gratuit et le cas
    // est journalisé pour que la migration soit appliquée.
    if (error && MISSING_PLAN_COLUMN.test(String(error.message || ''))) {
      warnMissingPlanColumn('activation d’offre');
      return withPlan(await findUserById(userId));
    }
    check(error, 'Mise à jour du plan utilisateur');
    return withPlan(data);
  }
  const users = await readJson(usersFile, []);
  const index = users.findIndex(user => user.id === userId);
  if (index < 0) return null;
  users[index] = { ...users[index], plan: normalized, planUpdatedAt: new Date().toISOString() };
  await writeJson(usersFile, users);
  return withPlan(users[index]);
}

// ---------- Sessions ----------
async function createSession({ tokenHash, userId, createdAt, expiresAt }) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('sessions').insert({
      token_hash: tokenHash,
      user_id: userId,
      expires_at: expiresAt
    });
    check(error, 'Création de session');
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
    check(error, 'Lecture de session');
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
    check(error, 'Suppression de session');
    return;
  }
  const sessions = await readJson(sessionsFile, []);
  await writeJson(sessionsFile, sessions.filter(item => item.tokenHash !== tokenHash));
}

// ---------- Factures ----------
/**
 * Normalise une colonne jsonb : selon le driver, elle peut arriver en objet
 * ou en chaîne JSON. Toute valeur inexploitable devient `null` plutôt que de
 * propager une forme inattendue dans l'application.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function listInvoices(userId) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('invoices').select('data').eq('user_id', userId)
      .order('created_at', { ascending: false });
    check(error, 'Liste des factures');
    return (data || []).map(row => asObject(row.data)).filter(Boolean);
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
    check(error, 'Enregistrement de facture');
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
    check(error, 'Lecture de facture');
    if (!data) return null;
    const updated = { ...data.data, status, updatedAt: new Date().toISOString() };
    const { error: updateError } = await supabaseClient
      .from('invoices').update({ data: updated, updated_at: new Date() })
      .eq('id', invoiceId).eq('user_id', userId);
    check(updateError, 'Mise à jour du statut de facture');
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
    check(error, 'Recherche de facture par numéro');
    const row = (data || []).find(item => item.data?.number === number);
    if (row) {
      const updated = { ...row.data, status, updatedAt: new Date().toISOString() };
      const { error: updateError } = await supabaseClient
        .from('invoices').update({ data: updated, updated_at: new Date() }).eq('id', row.id);
      check(updateError, 'Mise à jour du statut par numéro');
      return updated;
    }
    const invoice = { id: crypto.randomUUID(), number, status, type: 'FACTURE', createdAt: new Date().toISOString() };
    const { error: insertError } = await supabaseClient.from('invoices').insert({
      id: invoice.id, user_id: userId, data: invoice, updated_at: new Date()
    });
    check(insertError, 'Création de facture par numéro');
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

// ---------- Lecture unitaire d'une facture ----------
/**
 * Récupère une facture par identifiant interne, isolée par utilisateur.
 * @param {string} id
 * @param {string} userId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function getInvoice(id, userId) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('invoices').select('data').eq('id', id).eq('user_id', userId).maybeSingle();
    check(error, 'Lecture de facture');
    return data ? asObject(data.data) : null;
  }
  const invoices = await readJson(invoicesFile, []);
  const found = invoices.find(item => item.id === id && (item.userId === userId || item.userId == null));
  return found ? asObject(found) : null;
}

// ---------- Lecture multi-utilisateurs (relances automatiques) ----------
/**
 * Renvoie TOUTES les factures, tous utilisateurs confondus. Réservé au
 * moteur de relance automatisé exécuté côté serveur — jamais renvoyé
 * tel quel à un client.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function listAllInvoices() {
  if (useSupabase) {
    const { data, error } = await supabaseClient.from('invoices').select('data');
    check(error, 'Lecture de toutes les factures');
    return (data || []).map(row => asObject(row.data)).filter(Boolean);
  }
  const invoices = await readJson(invoicesFile, []);
  return invoices.map(invoice => asObject(invoice));
}

// ---------- Numérotation séquentielle (section critique) ----------
// File de promesses : les allocations sont sérialisées dans le processus.
// Deux validations simultanées ne peuvent pas obtenir le même ordinal, et
// la numérotation reste continue (aucun trou) — exigence comptable.
let numberAllocationQueue = Promise.resolve();

/**
 * Alloue le prochain numéro définitif d'un utilisateur pour l'année donnée.
 * La séquence est annuelle, continue et sans trou ; le mutex interne garantit
 * l'unicité au sein du processus (déploiement multi-instances : l'unicité
 * doit être garantie par une contrainte d'unicité en base).
 * @param {string} userId
 * @param {Date} [now] date de référence (année de la séquence)
 * @param {string} [prefix] préfixe métier
 * @returns {Promise<{ year: number, ordinal: number, number: string }>}
 */
async function allocateInvoiceNumber(userId, now = new Date(), prefix = 'FAC') {
  const { nextSequentialNumber } = require('./lib/invoice-lifecycle');
  const allocation = numberAllocationQueue.then(async () => {
    if (useSupabase) {
      const { data, error } = await supabaseClient
        .from('invoices').select('data').eq('user_id', userId);
      check(error, 'Allocation de numéro de facture');
      const numbers = (data || []).map(row => asObject(row.data)?.number).filter(Boolean);
      return nextSequentialNumber(/** @type {string[]} */ (numbers), now.getFullYear(), prefix);
    }
    const invoices = await readJson(invoicesFile, []);
    const numbers = invoices
      .filter(invoice => invoice.userId === userId || invoice.userId == null)
      .map(invoice => String(invoice.number || ''));
    return nextSequentialNumber(numbers, now.getFullYear(), prefix);
  });
  // La file continue même en cas d'échec : un incident d'allocation ne doit
  // pas bloquer définitivement les validations suivantes.
  numberAllocationQueue = allocation.then(() => undefined, () => undefined);
  return allocation;
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
    check(error, 'Lecture des paramètres');
    return asObject(data?.data) || {};
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
    check(error, 'Enregistrement des paramètres');
    return settings;
  }
  const stored = await readJson(settingsFile, {});
  const container = normalizeSettingsContainer(stored);
  container.byUser[userId] = settings;
  await writeJson(settingsFile, container);
  return settings;
}

// ---------- Utilisateurs (admin) ----------

async function listUsers() {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('profiles').select('id, name, email, plan, created_at')
      .order('created_at', { ascending: false });
    check(error, 'Liste des utilisateurs');
    return (data || []).map(user => ({
      ...user,
      plan: plans.normalizePlan(user.plan)
    }));
  }
  const users = await readJson(usersFile, []);
  return users.map(user => withPlan(user));
}

// ---------- Commandes (admin / Stripe) ----------
async function listOrders() {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('orders').select('data').order('created_at', { ascending: false });
    check(error, 'Liste des commandes');
    return (data || []).map(row => asObject(row.data)).filter(Boolean);
  }
  return readJson(ordersFile, []);
}

async function saveOrder(order) {
  if (useSupabase) {
    const { error } = await supabaseClient.from('orders').upsert(
      { id: order.id, data: order, created_at: new Date() },
      { onConflict: 'id' }
    );
    check(error, 'Enregistrement de commande');
    return;
  }
  const orders = await readJson(ordersFile, []);
  const index = orders.findIndex(item =>
    item.id === order.id || (order.checkoutSessionId && item.checkoutSessionId === order.checkoutSessionId));
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  else orders.unshift(order);
  await writeJson(ordersFile, orders);
}

/**
 * Met à jour le statut d'une commande identifiée par sa session Stripe.
 * Fonctionne sur les DEUX backends (Supabase comme fichiers locaux) : cette
 * mise à jour était auparavant silencieusement ignorée en mode Supabase.
 * @param {string} checkoutSessionId
 * @param {string} status
 */
async function updateOrderStatusBySessionId(checkoutSessionId, status) {
  if (useSupabase) {
    const { data, error } = await supabaseClient
      .from('orders').select('id, data')
      .eq('data->>checkoutSessionId', checkoutSessionId)
      .maybeSingle();
    check(error, 'Recherche de commande par session');
    const order = data ? asObject(data.data) : null;
    if (!data || !order) return;
    const { error: updateError } = await supabaseClient
      .from('orders')
      .update({ data: { ...order, status }, updated_at: new Date() })
      .eq('id', data.id);
    check(updateError, 'Mise à jour du statut de commande');
    return;
  }

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
  updateUserPlan,
  createSession,
  findSessionByTokenHash,
  deleteSessionByTokenHash,
  listInvoices,
  getInvoice,
  listAllInvoices,
  saveInvoice,
  updateInvoiceStatus,
  updateInvoiceByNumber,
  allocateInvoiceNumber,
  getSettings,
  saveSettings,
  listOrders,
  saveOrder,
  updateOrderStatusBySessionId,
  listUsers
};