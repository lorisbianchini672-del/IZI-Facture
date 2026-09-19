// ============================================================
// lib/facturx.test.js — XML CII (EN 16931) et incorporation PDF
// ------------------------------------------------------------
// Invariants testés : les totaux du XML sont TOUJOURS recalculés
// depuis les lignes (aucune confiance dans le client), le XML est
// échappé, et le PDF d'origine reste bit-à-bit intact après
// l'incorporation incrémentale.
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./facturx');

const FACTURE = {
  number: 'FAC-2026-0001',
  client: 'ACME <SARL> & Fils',
  issueDate: '2026-01-15',
  dueDate: '2026-02-15',
  items: [
    { description: 'Développement', quantity: 2, price: 500, taxRate: 0.2 },
    { description: 'Maintenance', quantity: 1, price: 100, taxRate: 0.1 }
  ],
  company: { legalName: 'IZI SAS', billingAddress: '12 rue de Paris', vatNumber: 'FR40849203118' }
};

// ---------- Fabrication d'un PDF minimaliste (structure pdfkit) ----------
function buildFixturePdf() {
  const header = '%PDF-1.7\n';
  const dictionaries = [
    '<< /Type /Catalog /Lang (fr-FR) >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'
  ];
  let body = header;
  const offsets = [0];
  dictionaries.forEach((dict, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${dict}\nendobj\n`;
  });
  const xrefOffset = body.length;
  let xref = `xref\n0 ${dictionaries.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= dictionaries.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const id = '<0102030405060708090a0b0c0d0e0f10>';
  const trailer = `trailer\n<< /Size ${dictionaries.length + 1} /Root 1 0 R /ID [${id} ${id}] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

// ---------- Sérialisation CII ----------
test('xmlEscape neutralise les vecteurs XML et retire les caractères de contrôle', () => {
  assert.equal(fx.xmlEscape('ACME <SARL> & Fils'), 'ACME &lt;SARL&gt; &amp; Fils');
  assert.equal(fx.xmlEscape('L\'été "chaud"'), 'L&apos;été &quot;chaud&quot;');
  assert.equal(fx.xmlEscape('a\u0000b\u0007c'), 'abc');
  assert.equal(fx.xmlEscape(null), '');
  assert.equal(fx.xmlEscape(42), '42');
});

test('formats CII : montants, quantités, taux et dates', () => {
  assert.equal(fx.ciiAmount(1234.5), '1234.50');
  assert.equal(fx.ciiAmount(Number.NaN), '0.00');
  assert.equal(fx.ciiQuantity(2.5), '2.5000');
  assert.equal(fx.ciiRate(0.2), '20.00');
  assert.equal(fx.ciiRate(0.055), '5.50');
  assert.equal(fx.ciiDate('2026-02-15'), '20260215');
  assert.equal(fx.ciiDate('15/02/2026'), '');
  assert.equal(fx.ciiDate(undefined), '');
  assert.equal(fx.pdfDate(new Date('2026-01-20T10:00:00Z')), '20260120100000');
  assert.equal(fx.pdfHexString('factur-x.xml'), '<FEFF006600610063007400750072002D0078002E0078006D006C>');
});

// ---------- XML CII (EN 16931) ----------
test('buildFacturxXml recalcule les totaux depuis les lignes', () => {
  const xml = fx.buildFacturxXml(FACTURE);
  // 2 × 500 € HT à 20 % : base 1000, TVA 200 ; 1 × 100 € à 10 % : TVA 10.
  assert.match(xml, /<ram:LineTotalAmount>1000\.00<\/ram:LineTotalAmount>/);
  assert.match(xml, /<ram:BasisAmount>1000\.00<\/ram:BasisAmount>/);
  assert.match(xml, /<ram:CalculatedAmount>200\.00<\/ram:CalculatedAmount>/);
  assert.match(xml, /<ram:CalculatedAmount>10\.00<\/ram:CalculatedAmount>/);
  assert.match(xml, /<ram:GrandTotalAmount>1310\.00<\/ram:GrandTotalAmount>/);
  assert.match(xml, /<ram:TaxBasisTotalAmount>1100\.00<\/ram:TaxBasisTotalAmount>/);
  // Une rubrique de TVA d'en-tête par taux (exigence EN 16931) ; les
  // rubriques de ligne utilisent un autre élément (RateApplicablePercent
  // sans CalculatedAmount).
  assert.equal((xml.match(/<ram:CalculatedAmount>/g) || []).length, 2);
});

test('buildFacturxXml échappe les données métier', () => {
  const xml = fx.buildFacturxXml(FACTURE);
  assert.ok(xml.includes('<ram:BuyerTradeParty>\n        <ram:Name>ACME &lt;SARL&gt; &amp; Fils</ram:Name>'), xml);
  assert.ok(xml.includes('<ram:LineOne>12 rue de Paris</ram:LineOne>'));
  assert.ok(xml.includes('schemeID="VA">FR40849203118'));
});

test('buildFacturxXml produit un document EN 16931 complet', () => {
  const xml = fx.buildFacturxXml(FACTURE);
  assert.match(xml, /<rsm:CrossIndustryInvoice\b/);
  assert.match(xml, /<ram:TypeCode>380<\/ram:TypeCode>/, 'code 380 = facture commerciale');
  assert.ok(xml.includes('<ram:ID>FAC-2026-0001</ram:ID>'));
  assert.match(xml, /<ram:IssueDateTime><udt:DateTimeString format="102">20260115<\/udt:DateTimeString>/);
  assert.match(xml, /<ram:DueDateDateTime><udt:DateTimeString format="102">20260215<\/udt:DateTimeString>/);
  assert.match(xml, /<ram:CountryID>FRA<\/ram:CountryID>/);
  assert.match(xml, /<ram:InvoiceCurrencyCode>EUR<\/ram:InvoiceCurrencyCode>/);
  // Numérotation des lignes à partir de 1.
  assert.match(xml, /<ram:LineID>1<\/ram:LineID>/);
  assert.match(xml, /<ram:LineID>2<\/ram:LineID>/);
});

test('buildFacturxXml tolère une facture minimale sans échéance ni société', () => {
  const xml = fx.buildFacturxXml({
    number: 'DEV-2026-0007',
    client: 'Client seul',
    issueDate: '2026-03-01',
    items: [{ description: 'Prestation', quantity: 1, price: 99.9, taxRate: 0 }]
  });
  assert.ok(!xml.includes('SpecifiedTradePaymentTerms'), 'pas de termes sans date d’échéance');
  assert.match(xml, /<ram:GrandTotalAmount>99\.90<\/ram:GrandTotalAmount>/);
  // Taux 0 % : une seule rubrique de TVA d'en-tête.
  assert.equal((xml.match(/<ram:CalculatedAmount>/g) || []).length, 1);
  assert.match(xml, /<ram:RateApplicablePercent>0\.00<\/ram:RateApplicablePercent>/);
});

// ---------- Incorporation PDF incrémentale ----------
test('parsePdfDict ignore les noms figurant dans les valeurs (pas de doublon)', () => {
  const entries = fx.parsePdfDict('<< /Type /Catalog /Lang (fr-FR) /AF [5 0 R] >>');
  assert.deepEqual([...entries.keys()], ['Type', 'Lang', 'AF'], 'aucune fausse clé « Catalog »');
  assert.equal(entries.get('Type'), '/Catalog');
  assert.equal(entries.get('Lang'), '(fr-FR)');
  // Dictionnaire imbriqué : la valeur est capturée en entier, ses clés internes
  // ne fuient pas au premier niveau.
  const nested = fx.parsePdfDict('<< /Params << /ModDate (D:2026) /Size 12 >> /F (a.xml) >>');
  assert.deepEqual([...nested.keys()], ['Params', 'F']);
  assert.equal(nested.get('Params'), '<< /ModDate (D:2026) /Size 12 >>');
});

test('appendFacturxToPdf ajoute un segment valide et préserve le PDF d’origine', () => {
  const original = buildFixturePdf();
  const xml = fx.buildFacturxXml(FACTURE);
  const enriched = fx.appendFacturxToPdf(original, xml, { modDate: new Date('2026-01-20T10:00:00Z') });
  const s = enriched.toString('latin1');

  // Le PDF d'origine est conservé octet par octet (exigence d'intégrité).
  assert.ok(enriched.subarray(0, original.length).equals(original));

  // startxref final pointe sur le nouveau croisement (les lecteurs PDF
  // ne lisent que le dernier segment).
  const startMatch = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(s);
  assert.ok(startMatch, 'startxref final présent');
  assert.equal(s.slice(Number(startMatch[1]), Number(startMatch[1]) + 4), 'xref');

  // Les cinq objets ajoutés existent (base = /Size d'origine = 4).
  for (const objectNumber of [4, 5, 6, 7, 8]) {
    assert.ok(s.includes(`\n${objectNumber} 0 obj\n`), `objet ${objectNumber} présent`);
  }
  assert.ok(s.includes('/Type /EmbeddedFile'), 'XML incorporé');
  assert.ok(s.includes('/AFRelationship /Data'), 'relation Factur-X = pièce de données');
  assert.ok(s.includes('/UF <FEFF006600610063007400750072002D0078002E0078006D006C>'), 'nom Unicode factur-x.xml');
  assert.ok(/\/AF \[5 0 R\]/.test(s), 'le catalogue référence la filespec');
  assert.ok(s.includes('fx:DocumentType'), 'métadonnées XMP Factur-X');
  assert.ok(s.includes('/ModDate (D:20260120100000)'), 'horodatage déterministe');

  // Nouveau catalogue : clés d'origine conservées + branchement Factur-X.
  assert.ok(/8 0 obj\n<< \/Type \/Catalog \/Lang \(fr-FR\) \/AF \[5 0 R\]/.test(s), 'Lang conservée, AF ajoutée');
  assert.ok(/\/Metadata 7 0 R/.test(s));
  assert.ok(/\/Names << \/EmbeddedFiles 6 0 R >>/.test(s));

  // Nouveau trailer : /Size mis à jour, /Root modifié, /ID préservé.
  assert.ok(/trailer\n<< \/Size 9 \/Root 8 0 R \/ID \[<0102030405060708090a0b0c0d0e0f10> <0102030405060708090a0b0c0d0e0f10>\] >>/.test(s));
  assert.ok(/4 5\n/.test(s.slice(Number(startMatch[1]))), 'le croisement couvre les 5 nouveaux objets');

  // Le XML est bien le contenu du flux incorporé.
  assert.ok(s.includes('ACME &lt;SARL&gt; &amp; Fils'));
});

test('appendFacturxToPdf produit des offsets xref exacts', () => {
  const original = buildFixturePdf();
  const enriched = fx.appendFacturxToPdf(original, fx.buildFacturxXml(FACTURE));
  const s = enriched.toString('latin1');
  const startMatch = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(s);
  const xrefBlock = s.slice(Number(startMatch[1]));
  const entries = xrefBlock.match(/^\d{10} 00000 n $/gm) || [];
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    const target = Number(entry.slice(0, 10));
    assert.match(s.slice(target, target + 12), /^\d+ 0 obj/, `offset ${target} pointe sur un objet`);
  }
});

test('appendFacturxToPdf refuse un PDF inexploitable', () => {
  const xml = fx.buildFacturxXml(FACTURE);
  assert.throws(() => fx.appendFacturxToPdf(Buffer.from('pas un pdf'), xml), /%%EOF/);
  assert.throws(
    () => fx.appendFacturxToPdf(Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\nstartxref\n9\n%%EOF\n'), xml),
    /trailer/
  );
  // Catalogue référencé mais absent.
  assert.throws(
    () => fx.appendFacturxToPdf(
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 7 0 R /ID [<aa> <aa>] >>\nstartxref\n40\n%%EOF\n'),
      xml
    ),
    /catalogue/
  );
});

test('le XML incorporé est intact dans le flux (taille cohérente)', () => {
  const original = buildFixturePdf();
  const xml = fx.buildFacturxXml(FACTURE);
  const xmlBytes = Buffer.from(xml, 'utf8');
  const enriched = fx.appendFacturxToPdf(original, xml);
  const s = enriched.toString('latin1');
  const streamMatch = /4 0 obj\n<< \/Type \/EmbeddedFile[\s\S]*?\/Length (\d+) >>\nstream\n/.exec(s);
  assert.ok(streamMatch, 'flux incorporé trouvé');
  assert.equal(Number(streamMatch[1]), xmlBytes.length, 'Length = taille réelle du XML');
});
