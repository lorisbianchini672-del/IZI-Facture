// ============================================================
// lib/retry.test.js — Résilience des appels réseau
// ------------------------------------------------------------
// Le contrat testé : ne rejouer QUE les pannes transitoires, avec un
// délai exponentiel borné, et ne jamais masquer une erreur métier.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RetryError,
  isRetryableError,
  isAbortError,
  computeDelay,
  withRetry,
  fetchWithTimeout
} = require('./retry');

const fast = { baseDelayMs: 1, maxDelayMs: 4, jitter: false };

test('isRetryableError classe pannes transitoires et erreurs définitives', () => {
  // Transitoires : réseau, surcharge, indisponibilité.
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { status: 503 })), true);
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { statusCode: 429 })), true);
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { response: { status: 502 } })), true);
  assert.equal(isRetryableError(Object.assign(new Error('slow'), { type: 'StripeConnectionError' })), true);
  assert.equal(isRetryableError(new Error('Connection timeout while talking to Stripe')), true);

  // Définitives : requête invalide, authentification, configuration.
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { status: 400 })), false);
  assert.equal(isRetryableError(Object.assign(new Error('boom'), { status: 401 })), false);
  assert.equal(isRetryableError(Object.assign(new Error('carte refusée'), { type: 'StripeCardError' })), false);
  assert.equal(isRetryableError(new Error('Configuration SMTP absente')), false);
  assert.equal(isRetryableError(null), false);
  assert.equal(isRetryableError(undefined), false);
});

test('une annulation volontaire n’est jamais rejouée', () => {
  const abort = Object.assign(new Error('AbortError'), { name: 'AbortError' });
  assert.equal(isAbortError(abort), true);
  assert.equal(isRetryableError(abort), false);
  assert.equal(isAbortError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isAbortError(new Error('timeout')), false);
});

test('computeDelay est exponentiel, borné et optionnellement gigoté', () => {
  const options = { baseDelayMs: 100, maxDelayMs: 400, jitter: false };
  assert.equal(computeDelay(1, options), 100);
  assert.equal(computeDelay(2, options), 200);
  assert.equal(computeDelay(3, options), 400);
  assert.equal(computeDelay(9, options), 400); // plafonné

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const exponential = Math.min(100 * 2 ** (attempt - 1), 400);
    const delay = computeDelay(attempt, { ...options, jitter: true });
    assert.ok(delay >= Math.round(exponential / 2));
    assert.ok(delay <= exponential);
  }
});

test('withRetry réussit dès la première tentative sans attendre', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return 'ok'; }, fast);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry reprend une panne transitoire puis réussit', async () => {
  let calls = 0;
  const retries = [];
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return `tentative ${calls}`;
  }, { ...fast, onRetry: info => retries.push(info) });

  assert.equal(result, 'tentative 3');
  assert.equal(calls, 3);
  assert.deepEqual(retries.map(info => info.attempt), [1, 2]);
  assert.ok(retries.every(info => info.delayMs >= 0));
});

test('withRetry abandonne immédiatement sur une erreur définitive', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('carte refusée'), { status: 402 });
    }, fast),
    /carte refusée/
  );
  assert.equal(calls, 1, 'une erreur 402 ne doit pas être rejouée');
});

test('withRetry signale l’épuisement des tentatives avec RetryError', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    }, { ...fast, attempts: 3 }),
    error => {
      assert.ok(error instanceof RetryError);
      assert.equal(error.attempts, 3);
      assert.equal(error.code, 'RETRY_EXHAUSTED');
      assert.match(error.message, /Échec après 3 tentatives/);
      assert.equal(error.cause.status, 503);
      return true;
    }
  );
  assert.equal(calls, 3);
});

test('withRetry valide sa configuration et respecte l’annulation', async () => {
  await assert.rejects(withRetry(async () => 'jamais', { attempts: 0 }), /Nombre de tentatives invalide/);
  await assert.rejects(withRetry(async () => 'jamais', { attempts: 1.5 }), /Nombre de tentatives invalide/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withRetry(async () => 'jamais', { ...fast, signal: controller.signal }),
    /annulée/
  );

  // L'annulation pendant l'attente interrompt la reprise.
  const midAbort = new AbortController();
  let calls = 0;
  const promise = withRetry(async () => {
    calls += 1;
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  }, { attempts: 5, baseDelayMs: 50, jitter: false, signal: midAbort.signal });
  setTimeout(() => midAbort.abort(), 10);
  await assert.rejects(promise, /annulée/);
  assert.equal(calls, 1);
});

test('fetchWithTimeout borne l’appel dans le temps', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    await assert.rejects(fetchWithTimeout('https://exemple.tld', { timeoutMs: 20 }), /aborted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});