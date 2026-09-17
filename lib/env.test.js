// ============================================================
// lib/env.test.js — Configuration et audit des secrets
// ------------------------------------------------------------
// Aucun secret réel n'est utilisé ici : les valeurs de test sont
// injectées dans process.env puis restaurées.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('./env');

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

// Exécute un test avec des variables d'environnement temporaires.
function withEnv(variables, run) {
  const previous = new Map();
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('get() renvoie une valeur nettoyée ou une chaîne vide', () => {
  withEnv({ IZI_TEST_VALUE: '  valeur  ' }, () => {
    assert.equal(env.get('IZI_TEST_VALUE'), 'valeur');
  });
  withEnv({ IZI_TEST_VALUE: undefined }, () => {
    assert.equal(env.get('IZI_TEST_VALUE'), '');
    assert.equal(env.get('VARIABLE_TOTALEMENT_ABSENTE'), '');
  });
});

test('isPlaceholder détecte les valeurs d’exemple de .env.example', () => {
  for (const value of ['', '   ', 'change-this-token', 'replace_me', 'sk_test_replace_me', 'whsec_replace_me', 'notifications@example.com', 'smtp.example.com', 'https://xxxx.supabase.co']) {
    assert.equal(env.isPlaceholder(value), true, `${value} devrait être considéré comme un exemple`);
  }
  for (const value of ['sk_live_51AbcDef', 'whsec_9f2b7c', 'notifications@mon-domaine.fr', 'https://abcdefgh.supabase.co', 'un-vrai-jeton-aleatoire']) {
    assert.equal(env.isPlaceholder(value), false, `${value} devrait être considéré comme réel`);
  }
});

test('maskSecret ne révèle jamais le secret complet', () => {
  const secret = 'sk_live_51AbcDefGhiJklMno';
  const masked = env.maskSecret(secret);
  assert.ok(!masked.includes(secret));
  assert.ok(!masked.includes('AbcDef'));
  assert.match(masked, /^sk_\*\*\*\(\d+ car\.\)$/);
  assert.equal(env.maskSecret(''), '(absent)');
  assert.equal(env.maskSecret(undefined), '(absent)');
});

test('auditEnvironment signale un jeton d’administration manquant', () => {
  withEnv({ ADMIN_TOKEN: undefined }, () => {
    const report = env.auditEnvironment();
    assert.equal(report.problems.some(message => message.startsWith('ADMIN_TOKEN')), true);
    assert.equal(env.validateEnvironment({ logger: silentLogger, enforce: false }).ok, false);
  });

  withEnv({ ADMIN_TOKEN: 'jeton-de-test-1234' }, () => {
    const report = env.auditEnvironment();
    assert.equal(report.problems.some(message => message.startsWith('ADMIN_TOKEN')), false);
  });
});

test('validateEnvironment ne bloque le démarrage que si enforce est actif', () => {
  withEnv({ ADMIN_TOKEN: undefined, IZI_ALLOW_INSECURE_ENV: undefined }, () => {
    assert.doesNotThrow(() => env.validateEnvironment({ logger: silentLogger, enforce: false }));
    assert.throws(() => env.validateEnvironment({ logger: silentLogger, enforce: true }), /Configuration incomplète/);
  });

  // Dérogation explicite : le démarrage reste possible en connaissance de cause.
  withEnv({ ADMIN_TOKEN: undefined, IZI_ALLOW_INSECURE_ENV: '1' }, () => {
    assert.doesNotThrow(() => env.validateEnvironment({ logger: silentLogger, enforce: true }));
  });
});

test('Supabase n’est jamais activé par une seule variable', () => {
  withEnv({ SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_SERVICE_ROLE_KEY: undefined }, () => {
    assert.equal(env.auditEnvironment().warnings.some(message => message.includes('SUPABASE_URL')), true);
  });
});

test('checkEnvFilePermissions détecte un .env trop ouvert', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'izi-env-'));
  const openFile = path.join(directory, '.env');
  const closedFile = path.join(directory, '.env.closed');
  try {
    fs.writeFileSync(openFile, 'ADMIN_TOKEN=test\n');
    fs.chmodSync(openFile, 0o644);
    const open = env.checkEnvFilePermissions(openFile);
    assert.equal(open.exists, true);
    assert.equal(open.tooOpen, true);

    fs.writeFileSync(closedFile, 'ADMIN_TOKEN=test\n');
    fs.chmodSync(closedFile, 0o600);
    const closed = env.checkEnvFilePermissions(closedFile);
    assert.equal(closed.tooOpen, false);
    assert.equal(closed.mode, '600');

    const missing = env.checkEnvFilePermissions(path.join(directory, 'absent.env'));
    assert.equal(missing.exists, false);
    assert.equal(missing.tooOpen, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
