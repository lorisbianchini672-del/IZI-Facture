// ============================================================
// lib/validate.test.js — Schémas de validation stricts
// ------------------------------------------------------------
// Le contrat : aucune donnée non déclarée n'entre en base, aucune
// saisie n'est acceptée silencieusement, et le client reçoit une
// liste précise de champs fautifs (jamais la structure interne).
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ValidationError,
  sanitizeText,
  escapeHtml,
  string,
  email,
  number,
  coerceNumber,
  money,
  date,
  enumeration,
  boolean,
  array,
  object,
  optional,
  refine,
  validate,
  validateSafe
} = require('./validate');

/** Exécute un schéma et renvoie soit la valeur, soit les codes d'erreur. */
function run(schema, value) {
  const result = validateSafe(schema, value);
  return result.ok ? result.value : result.issues.map(i => i.code);
}

test('sanitizeText retire les caractères de contrôle et borne la longueur', () => {
  assert.equal(sanitizeText('  Marie\u0000 Dupont\u007F '), 'Marie Dupont');
  assert.equal(sanitizeText('Ligne1\r\nLigne2'), 'Ligne1\nLigne2');
  assert.equal(sanitizeText('  a\tb  ', { singleLine: true }), 'a b');
  assert.equal(sanitizeText('x'.repeat(300), { maxLength: 200 }).length, 200);
  assert.equal(sanitizeText(null), '');
  assert.equal(sanitizeText(undefined), '');
});

test('escapeHtml neutralise tous les vecteurs HTML', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml(`'><img src=x onerror='a`), '&#39;&gt;&lt;img src=x onerror=&#39;a');
  assert.equal(escapeHtml('A & B'), 'A &amp; B');
  assert.equal(escapeHtml(null), '');
});

test('string applique min, max, pattern, oneOf et normalisation', () => {
  const label = string({ min: 2, max: 20, singleLine: true });
  assert.equal(run(label, '  IZI  Facture  '), 'IZI Facture');
  assert.equal(run(label, 'x'.repeat(30)).length, 20, 'tronqué au maximum');
  assert.deepEqual(run(label, 'a'), ['min_length']);
  assert.deepEqual(run(label, 42), ['type']);

  const ref = string({ pattern: /^FAC-\d{4}$/, patternMessage: 'Référence attendue : FAC-0000.' });
  assert.equal(run(ref, 'FAC-2026'), 'FAC-2026');
  assert.deepEqual(run(ref, 'facture 1'), ['pattern']);

  const plan = string({ oneOf: ['gratuit', 'pro'] });
  assert.deepEqual(run(plan, 'entreprise'), ['one_of']);
});

test('email normalise en minuscules, applique la longueur et refuse les invalides', () => {
  const schema = email();
  assert.equal(run(schema, '  MARIE@Exemple.FR '), 'marie@exemple.fr');
  // Une adresse trop courte échoue d'abord sur la longueur (min: 6), pas sur le format.
  assert.deepEqual(run(schema, 'marie'), ['min_length']);
  for (const bad of ['marie@', '@exemple.fr', 'marie@exemple', 'marie exemp.le@fr']) {
    assert.deepEqual(run(schema, bad), ['pattern'], `${bad} doit être refusé`);
  }
});

test('number est strict : aucune coercition implicite', () => {
  const schema = number({ min: 0, max: 100 });
  assert.equal(run(schema, 42), 42);
  assert.deepEqual(run(schema, '42'), ['type'], 'une chaîne doit être refusée');
  assert.deepEqual(run(schema, Number.NaN), ['type']);
  assert.deepEqual(run(schema, Number.POSITIVE_INFINITY), ['type']);
  assert.deepEqual(run(schema, -1), ['min']);
  assert.deepEqual(run(schema, 101), ['max']);

  const qty = number({ integer: true });
  assert.deepEqual(run(qty, 2.5), ['integer']);
  assert.equal(run(qty, 3), 3);
});

test('coerceNumber accepte la saisie formulaire et exige emptyAs pour un champ vidé', () => {
  assert.equal(run(coerceNumber(), '12,5'), 12.5);
  assert.equal(run(coerceNumber(), ' 1 200 '), 1200);
  assert.deepEqual(run(coerceNumber(), ''), ['required']);
  assert.equal(run(coerceNumber({ emptyAs: 0 }), ''), 0);
  assert.deepEqual(run(coerceNumber(), '12px'), ['type']);
  assert.deepEqual(run(coerceNumber({ integer: true }), '2.5'), ['integer']);
});

test('money accepte les montants français et refuse le texte', () => {
  assert.equal(run(money(), '1 234,56 €'), 1234.56);
  assert.equal(run(money(), 99.5), 99.5);
  assert.deepEqual(run(money(), 'gratuit'), ['money']);
  assert.deepEqual(run(money(), '12abc'), ['money']);
});

test('date valide le calendrier réel, pas seulement le format', () => {
  assert.equal(run(date(), '2026-02-28'), '2026-02-28');
  assert.deepEqual(run(date(), '2026-02-30'), ['date'], 'le 30 février n’existe pas');
  assert.deepEqual(run(date(), '2026-13-01'), ['date']);
  assert.deepEqual(run(date(), '15/03/2026'), ['date']);
});

test('enumeration et boolean sont stricts', () => {
  assert.equal(run(enumeration(['devis', 'facture']), 'facture'), 'facture');
  assert.deepEqual(run(enumeration(['devis', 'facture']), 'FACTURE'), ['one_of']);
  assert.equal(run(boolean(), true), true);
  assert.deepEqual(run(boolean(), 'true'), ['type']);
  assert.deepEqual(run(boolean(), 1), ['type']);
});

test('array valide chaque élément et impose ses bornes', () => {
  const schema = array(number({ min: 0 }), { minLength: 1, maxLength: 3 });
  assert.deepEqual(run(schema, [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(run(schema, []), ['min_length']);
  assert.deepEqual(run(schema, [1, 2, 3, 4]), ['max_length']);
  assert.deepEqual(run(schema, '3'), ['type']);
});

test('object refuse toute clé non déclarée (strict par défaut)', () => {
  const schema = object({ name: string() });
  assert.deepEqual(run(schema, { name: 'Marie', role: 'admin' }), ['unknown_key']);
  assert.deepEqual(run(schema, [1, 2]), ['type']);
  // Convention du module : null sans variante nullable = champ obligatoire manquant.
  assert.deepEqual(run(schema, null), ['required']);
});

test('object bloque la pollution de prototype', () => {
  const schema = object({ name: string() });
  // JSON.parse peut produire une propriété propre __proto__ / constructor.
  const evil = JSON.parse('{"name":"x","__proto__":{"admin":true},"constructor":{"isAdmin":true}}');
  const codes = run(schema, evil);
  assert.ok(codes.includes('forbidden_key'), `__proto__/constructor doivent être interdits : ${codes}`);
  const output = validateSafe(schema, evil);
  assert.ok(!output.ok || !('admin' in output.value), 'aucune clé héritée ne doit passer');
});

test('object applique optional et les valeurs par défaut explicites', () => {
  const schema = object({
    note: optional(string()),
    vat: number({ defaultValue: 0.2 }),
    label: string({ min: 1 })
  });
  const parsed = validate(schema, { label: 'Prestation' });
  assert.equal(parsed.note, undefined);
  assert.equal(parsed.vat, 0.2);
  assert.deepEqual(run(schema, { label: '' }), ['min_length']);
  assert.deepEqual(run(schema, { vat: 0.2 }), ['required']);
});

test('refine ajoute une contrainte inter-champs explicite', () => {
  const schema = refine(
    object({ issue: date(), due: date() }),
    value => value.due >= value.issue,
    { code: 'date_order', message: 'L’échéance doit suivre l’émission.', path: 'due' }
  );
  const ok = validate(schema, { issue: '2026-03-01', due: '2026-03-15' });
  assert.equal(ok.due, '2026-03-15');
  const bad = validateSafe(schema, { issue: '2026-03-20', due: '2026-03-01' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.issues.map(i => `${i.path}:${i.code}`), ['due:date_order']);
});

test('ValidationError est une 400 exposée, champ par champ', () => {
  try {
    validate(object({ email: email() }), { email: 'nawak' }, { label: 'Inscription' });
    assert.fail('doit lever');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.expose, true);
    assert.match(error.message, /Inscription invalide\./);
    assert.deepEqual(error.issues.map(i => i.path), ['email']);
  }
});

test('validateSafe ne lève jamais et renvoie un résultat discriminé', () => {
  const ok = validateSafe(email(), 'a@b.fr');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'a@b.fr');
  const ko = validateSafe(email(), 'a@b');
  assert.equal(ko.ok, false);
  assert.equal(ko.issues.length, 1);
  assert.equal(typeof ko.issues[0].message, 'string');
});
