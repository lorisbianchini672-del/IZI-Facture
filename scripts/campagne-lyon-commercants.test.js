const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, parseCsvLine, isEmail, buildHtml, buildText } = require('./campagne-lyon-commercants');

test('aperçu par défaut et envoi borné explicite', () => {
  assert.deepEqual(parseArgs([]), { mode: '--dry-run', limit: null });
  assert.deepEqual(parseArgs(['--send', '--limit', '10']), { mode: '--send', limit: 10 });
  for (const args of [['--send'], ['--send', '--dry-run'], ['--limit'], ['--limit', '0'], ['--limit', '-1'], ['--limit', '1.5'], ['--limit', '2', '--limit', '3'], ['--typo'], ['destinataire']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('CSV : virgules, points-virgules et guillemets', () => {
  assert.deepEqual(parseCsvLine('"Boutique, Lyon","Jean ""J""",contact@boutique.fr', ','), ['Boutique, Lyon', 'Jean "J"', 'contact@boutique.fr']);
  assert.deepEqual(parseCsvLine('Boutique;Jean;contact@boutique.fr', ';'), ['Boutique', 'Jean', 'contact@boutique.fr']);
  assert.deepEqual(parseCsvLine('"date","contact@boutique.fr","id"', ','), ['date', 'contact@boutique.fr', 'id']);
});

test('adresse seule : refuse listes, injection et domaines fictifs', () => {
  assert.equal(isEmail('contact@boutique.fr'), true);
  for (const value of [undefined, '', 'a@b.fr,c@d.fr', 'Nom <a@b.fr>', 'a@b.fr\r\nBcc: c@d.fr', 'a@b.invalid', 'a@example.com']) assert.equal(isEmail(value), false);
});

test('personnalisation échappée et opposition présente', () => {
  const target = { commerce: '<script>alert(1)</script>', contact: 'Jean & Marie' };
  assert.match(buildText(target), /STOP/);
  assert.match(buildHtml(target), /Jean &amp; Marie/);
  assert.ok(!buildHtml(target).includes('<script>'));
  assert.ok(!buildText(target).includes('conformité'));
  // Design : en-tête dégradé IZI + bouton d'action + pied de page sombre
  assert.match(buildHtml(target), /linear-gradient\(135deg,#5b21b6,#7c3aed\)/);
  assert.match(buildHtml(target), /D&eacute;couvrir IZI<\/a>/);
  assert.match(buildHtml(target), /background-color:#172033/);
  assert.match(buildText(target), /15 minutes/);
});
