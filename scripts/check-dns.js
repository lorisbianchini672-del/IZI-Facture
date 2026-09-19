// Diagnostic de mise en ligne de izifacture.fr (non exécuté par `npm test`) :
//   node scripts/check-dns.js        (ou `npm run check:dns`)
//
// Contrôle, SANS RIEN MODIFIER, les 4 conditions d'un partage correct du site :
//   1. DNS      : izifacture.fr / www pointent-ils vers la VM (51.158.106.168) ?
//   2. TLS      : le certificat présenté est-il valide ET au bon nom ?
//   3. Application : est-ce bien VOTRE site qui répond (comparaison des <title>) ?
//   4. Partages : robots.txt / sitemap.xml / og-image.png sont-ils servis ?
// Aucun identifiant ni secret n'est affiché.
const dns = require('node:dns');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const DOMAIN = 'izifacture.fr';
const WWW = `www.${DOMAIN}`;
// Cible actuelle de la VM (URL de secours tant que le DNS n'est pas basculé).
const FALLBACK_HOST = process.env.IZI_FALLBACK_HOST || '51.158.106.168.nip.io';
const REQUIRED_FILES = ['robots.txt', 'sitemap.xml', 'og-image.png'];
const TIMEOUT_MS = 12000;

const ok = (m) => console.log(`✅ ${m}`);
const ko = (m) => console.log(`❌ ${m}`);
const warn = (m) => console.log(`⚠  ${m}`);

function localTitle() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    return (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
  } catch {
    return '';
  }
}

async function resolve(host) {
  try {
    const addresses = await dns.promises.resolve4(host);
    return addresses.sort();
  } catch (error) {
    return { error: error.code || error.message };
  }
}

// Requête HTTPS en ignorant la vérification : on veut lire l'erreur TLS
// plutôt que la subir, et obtenir le certificat réellement présenté.
function probe(host, { connectTo = host, route = '/' } = {}) {
  return new Promise((resolve) => {
    let activeSocket = null;
    const req = https.request({
      host: connectTo,
      port: 443,
      path: route,
      method: 'GET',
      servername: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: TIMEOUT_MS,
      headers: { 'user-agent': 'izi-check-dns', accept: '*/*' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 400000) body += chunk; });
      res.on('end', () => {
        const socket = activeSocket || res.socket;
        const cert = (socket && typeof socket.getPeerCertificate === 'function' && socket.getPeerCertificate()) || {};
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : '',
          cn: cert.subject?.CN || '',
          issuer: cert.issuer?.O || '',
          validTo: cert.valid_to || '',
          altNames: cert.subjectaltname || '',
          title: (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '',
          hasOgImage: /<meta[^>]+property=["']og:image["']/i.test(body),
          hasTwitterCard: /<meta[^>]+name=["']twitter:card["']/i.test(body)
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', (error) => resolve({ error: error.message }));
    req.on('socket', (socket) => { activeSocket = socket; });
    req.end();
  });
}

function certCoversHost(result, host) {
  if (!result.altNames) return result.cn === host;
  return result.altNames.split(',').some((entry) => entry.trim().replace(/^DNS:/, '') === host);
}

async function main() {
  const expectedTitle = localTitle();
  console.log(`Diagnostic de partage — ${DOMAIN}`);
  console.log(`Titre attendu (index.html local) : ${expectedTitle || '(introuvable)'}`);
  console.log('');

  // ---- 1. DNS ----
  console.log('— 1. DNS —');
  const apex = await resolve(DOMAIN);
  const www = await resolve(WWW);
  const fallback = await resolve(FALLBACK_HOST);
  const expectedIp = Array.isArray(fallback) ? fallback[0] : null;

  console.log(`   ${DOMAIN.padEnd(28)} -> ${Array.isArray(apex) ? apex.join(', ') : `aucune réponse (${apex.error})`}`);
  console.log(`   ${WWW.padEnd(28)} -> ${Array.isArray(www) ? www.join(', ') : `aucune réponse (${www.error})`}`);
  console.log(`   ${FALLBACK_HOST.padEnd(28)} -> ${expectedIp || 'aucune réponse'}  (VM de référence)`);

  const dnsOnVm = Boolean(expectedIp)
    && Array.isArray(apex) && apex.includes(expectedIp)
    && Array.isArray(www) && www.includes(expectedIp);
  const dnsElsewhere = Array.isArray(apex) && expectedIp && !apex.includes(expectedIp);
  if (dnsOnVm) ok(`${DOMAIN} et ${WWW} pointent bien vers la VM (${expectedIp}).`);
  else if (dnsElsewhere) ko(`${DOMAIN} pointe ailleurs (${apex.join(', ')}) : ce n'est pas votre serveur.`);
  else warn('DNS non résolu ; impossible de conclure.');

  // ---- 2 & 3. TLS + application réellement servie ----
  console.log('');
  console.log('— 2. Certificat TLS et site réellement servi —');
  const reference = await probe(FALLBACK_HOST);
  console.log(`   [référence] ${FALLBACK_HOST}`);
  if (reference.error) warn(`   injoignable : ${reference.error}`);
  else console.log(`   HTTP ${reference.status} | certificat ${reference.authorized ? 'valide' : 'INVALIDE'} (${reference.cn})`);

  for (const host of [DOMAIN, WWW]) {
    console.log('');
    console.log(`   [public] https://${host}/`);
    const result = await probe(host);
    if (result.error) { ko(`   injoignable : ${result.error}`); continue; }
    console.log(`   HTTP ${result.status} | émetteur ${result.issuer || '?'} | CN ${result.cn || '?'}`);
    console.log(`   Titre servi : ${result.title || '(aucun)'}`);

    if (result.authorized && certCoversHost(result, host)) ok('   Certificat valide et au bon nom.');
    else if (!result.authorized) ko(`   Certificat refusé par les navigateurs : ${result.authorizationError || 'auto-signé'} → page « connexion non privée ».`);
    else warn(`   Certificat valide mais ne couvre pas ${host}.`);

    if (!expectedTitle) warn('   Titre local illisible : comparaison impossible.');
    else if (result.title === expectedTitle) ok('   C\'est bien votre application IZI.');
    else ko('   Ce n\'est PAS votre application (titre différent).');
  }

  // ---- 4. Fichiers de partage ----
  const publicTarget = dnsOnVm ? DOMAIN : FALLBACK_HOST;
  console.log('');
  console.log(`— 3. Fichiers de partage (sur ${publicTarget}) —`);
  for (const file of REQUIRED_FILES) {
    const result = await probe(publicTarget, { route: `/${file}` });
    if (result.error) ko(`   /${file} injoignable (${result.error}).`);
    else if (result.status === 200) ok(`   /${file} -> 200 ${result.contentType.split(';')[0]}`);
    else ko(`   /${file} -> ${result.status}`);
  }
  const home = await probe(publicTarget);
  if (!home.error && home.hasOgImage && home.hasTwitterCard) ok('   index.html expose og:image et twitter:card.');
  else if (!home.error) warn('   index.html : balises de partage incomplètes (og:image / twitter:card).');

  // ---- Conclusion ----
  console.log('');
  console.log('— Conclusion —');
  if (dnsOnVm && !reference.error) {
    ok('Le partage est opérationnel : izifacture.fr sert votre application en HTTPS.');
  } else {
    if (dnsElsewhere) ko('NE PAS PARTAGER izifacture.fr : il pointe vers un autre hébergement.');
    console.log(`   En attendant, partagez : https://${FALLBACK_HOST}`);
    console.log('   Avant de basculer le DNS : obtenir le certificat sur la VM');
    console.log('   (voir l\'en-tête de nginx_conf.sh), puis appliquer nginx_conf.sh.');
  }
  console.log('');
  process.exitCode = dnsOnVm ? 0 : 1;
}

main().catch((error) => {
  console.error('❌ Diagnostic interrompu :', error.message);
  process.exitCode = 1;
});