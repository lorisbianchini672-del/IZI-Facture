// ============================================================
// lib/finance.js — Indicateurs financiers du tableau de bord
// ------------------------------------------------------------
// Calculs purs (aucune I/O) sur la liste des factures d'un utilisateur :
//   - chiffre d'affaires HT/TTC des factures émises (hors brouillons) ;
//   - encaissé (factures PAYEE) ;
//   - encours client (créances non réglées = besoin en fonds de roulement) ;
//   - échéancier des impayés par ancienneté avec alertes visuelles.
// Les montants d'entrée sont des nombres en euros déjà validés par la
// couche API ; les sorties sont arrondies à 2 décimales (money.round2).
// ============================================================
const money = require('./money');

/** Seuil (en jours de retard) au-delà duquel une alerte critique est levée. */
const LATE_ALERT_THRESHOLD_DAYS = 60;

/**
 * Nombre de jours de retard d'une échéance par rapport à la date de référence.
 * @param {string} dueDate ISO (YYYY-MM-DD)
 * @param {string} todayIso ISO (YYYY-MM-DD)
 * @returns {number} 0 si pas en retard, sinon le nombre de jours écoulés
 */
function daysLate(dueDate, todayIso) {
  if (!dueDate || dueDate >= todayIso) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(today)) return 0;
  return Math.max(0, Math.round((today - due) / 86_400_000));
}

/** Date ISO (YYYY-MM-DD) du jour de référence, en UTC pour la stabilité. */
function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Statut réel d'une facture pour la finance : « ATTENTE » est traité comme
 * une facture émise non réglée (historique de l'interface).
 * @param {string} status
 * @returns {'paid' | 'issued' | 'draft'}
 */
function paymentClass(status) {
  if (status === 'PAYEE') return 'paid';
  if (status === 'BROUILLON') return 'draft';
  return 'issued';
}

// ---------- Agrégation (calculs purs, aucune I/O) ----------

/**
 * Montant d'un champ d'une facture stockée, tolérant aux enregistrements
 * historiques (totaux en texte au format français) et aux valeurs absentes.
 * @param {Record<string, unknown>} invoice
 * @param {'ht'|'tva'|'ttc'} field
 * @returns {number} nombre fini (0 si inconnu ou illisible)
 */
function amountOf(invoice, field) {
  const amounts = /** @type {Record<string, unknown> | undefined} */ (invoice.amounts);
  const legacyKey = field === 'ht' ? 'totalHT' : field === 'tva' ? 'totalTVA' : 'totalTTC';
  const raw = (amounts && typeof amounts === 'object' ? amounts[field] : undefined) ?? invoice[legacyKey];
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' ? money.parseAmount(raw) : null);
  return Number.isFinite(value) ? /** @type {number} */ (value) : 0;
}

/**
 * @typedef {Object} OverdueItem
 * @property {string} number numéro de facture
 * @property {string} client nom du client
 * @property {string} dueDate échéance (ISO)
 * @property {number} daysLate jours de retard
 * @property {number} ttc montant dû
 * @property {'late'|'critical'} severity
 */

/**
 * @typedef {Object} FinancialSnapshot
 * @property {{ ht: number, ttc: number, count: number }} revenue CA facturé (hors brouillons)
 * @property {{ ht: number, tva: number, ttc: number, count: number }} collected encaissé (PAYEE)
 * @property {{ ht: number, tva: number, ttc: number, count: number }} outstanding encours client (BFR)
 * @property {{ count: number, totalTtc: number, criticalCount: number, items: OverdueItem[] }} overdue
 * @property {string} today date de référence (ISO)
 */

/**
 * Calcule l'instantané financier d'un utilisateur à partir de ses factures.
 * Conventions : les brouillons sont exclus de tous les totaux ; « ATTENTE »
 * compte comme une créance émise non réglée (historique de l'interface).
 * Toutes les sommes sont arrondies à 2 décimales (money.round2).
 * @param {unknown} invoices liste des factures de l'utilisateur
 * @param {{ today?: string }} [options]
 * @returns {FinancialSnapshot}
 */
function computeFinancials(invoices, { today = todayIso() } = {}) {
  const revenue = { ht: 0, ttc: 0, count: 0 };
  const collected = { ht: 0, tva: 0, ttc: 0, count: 0 };
  const outstanding = { ht: 0, tva: 0, ttc: 0, count: 0 };
  /** @type {OverdueItem[]} */
  const overdueItems = [];
  let overdueTotal = 0;
  let criticalCount = 0;

  for (const invoice of Array.isArray(invoices) ? invoices : []) {
    if (!invoice || typeof invoice !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (invoice);
    const klass = paymentClass(String(record.status || 'BROUILLON'));
    if (klass === 'draft') continue;

    const ht = amountOf(record, 'ht');
    const tva = amountOf(record, 'tva');
    const ttc = amountOf(record, 'ttc');
    revenue.ht += ht;
    revenue.ttc += ttc;
    revenue.count += 1;

    if (klass === 'paid') {
      collected.ht += ht;
      collected.tva += tva;
      collected.ttc += ttc;
      collected.count += 1;
      continue;
    }

    // Créance non réglée : elle alimente l'encours (besoin en fonds de
    // roulement) et, si l'échéance est dépassée, l'échéancier des impayés.
    outstanding.ht += ht;
    outstanding.tva += tva;
    outstanding.ttc += ttc;
    outstanding.count += 1;

    const late = daysLate(String(record.dueDate || ''), today);
    if (late > 0) {
      const severity = late >= LATE_ALERT_THRESHOLD_DAYS ? 'critical' : 'late';
      if (severity === 'critical') criticalCount += 1;
      overdueTotal += ttc;
      overdueItems.push({
        number: String(record.number || ''),
        client: String(record.client || ''),
        dueDate: String(record.dueDate || ''),
        daysLate: late,
        ttc: money.round2(ttc),
        severity
      });
    }
  }

  overdueItems.sort((a, b) => b.daysLate - a.daysLate);
  return {
    revenue: { ht: money.round2(revenue.ht), ttc: money.round2(revenue.ttc), count: revenue.count },
    collected: {
      ht: money.round2(collected.ht),
      tva: money.round2(collected.tva),
      ttc: money.round2(collected.ttc),
      count: collected.count
    },
    outstanding: {
      ht: money.round2(outstanding.ht),
      tva: money.round2(outstanding.tva),
      ttc: money.round2(outstanding.ttc),
      count: outstanding.count
    },
    overdue: {
      count: overdueItems.length,
      totalTtc: money.round2(overdueTotal),
      criticalCount,
      items: overdueItems
    },
    today
  };
}

module.exports = { LATE_ALERT_THRESHOLD_DAYS, daysLate, todayIso, paymentClass, computeFinancials };
