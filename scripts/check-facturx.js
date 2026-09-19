// Vérification manuelle du module Factur-X (non exécutée par `npm test`) :
//   node scripts/check-facturx.js
// Génère un PDF pdfkit réel, y attache un XML Factur-X et contrôle la
// structure du PDF incrémental : startxref, objets, XMP, offsets, intégrité.
const PDFDocument = require('pdfkit');
const fx = require('../lib/facturx');

function generatePlainPdf() {
  return new Promise(resolve => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.text('FACTURE FAC-2026-0001');
    doc.end();
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const plain = await generatePlainPdf();
  const xml = fx.buildFacturxXml({
    number: 'FAC-2026-0001',
    client: 'ACME <SARL>',
    issueDate: '2026-01-15',
    dueDate: '2026-02-15',
    items: [{ description: 'Développement & UI', quantity: 2, price: 500, taxRate: 0.2 }],
    company: { legalName: 'IZI SAS', billingAddress: '12 rue de Paris' }
  });
  const enriched = fx.appendFacturxToPdf(plain, xml, { modDate: new Date('2026-01-20T10:00:00Z') });
  const s = enriched.toString('latin1');

  const lastXref = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(s);
  const offset = Number(lastXref && lastXref[1]);
  console.log('startxref pointe sur:', JSON.stringify(s.slice(offset, offset + 4)));
  const objects = [...s.matchAll(/\n(\d+) 0 obj/g)].map(match => match[1]);
  console.log('objets:', objects.join(','));
  console.log('EmbeddedFile:', s.includes('/Type /EmbeddedFile'));
  console.log('AFRelationship /Data:', s.includes('/AFRelationship /Data'));
  console.log('Catalog /AF:', /\/AF \[\d+ 0 R\]/.test(s));
  console.log('XMP fx:DocumentType:', s.includes('fx:DocumentType'));
  console.log('client échappé:', s.includes('ACME &lt;SARL&gt;'));
  console.log('tailles:', plain.length, '→', enriched.length);
  console.log('original intact:', enriched.subarray(0, plain.length).equals(plain));

  const xrefBlock = s.slice(offset);
  const entries = xrefBlock.match(/^\d{10} 00000 n $/gm) || [];
  const offsetsOk = entries.every(entry => {
    const target = Number(entry.slice(0, 10));
    return /^\d+ 0 obj/.test(s.slice(target, target + 12));
  });
  console.log('offsets xref valides:', offsetsOk, `(${entries.length} entrées)`);
}

main().catch(error => {
  console.error('Échec de la vérification Factur-X :', error);
  process.exitCode = 1;
});
