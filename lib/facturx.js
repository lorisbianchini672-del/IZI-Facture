// ============================================================
// lib/facturx.js — Factur-X 1.0 ( profil EN 16931 )
// ------------------------------------------------------------
// Génération du XML CII (CrossIndustryInvoice, EN 16931) et
// incorporation dans un PDF par MISE À JOUR INCRÉMENTALE :
// le PDF d'origine reste intact, on lui ajoute un segment
// (fichier incorporé + catalogue mis à jour + métadonnées XMP)
// exactement comme le requiert la spécification Factur-X.
//
// Limite assumée et documentée : la conformité PDF/A-3 stricte
// exige en outre des polices incorporées et un OutputIntent ICC
// (pdfkit utilise les polices de base non incorporées). La
// structure Factur-X (pièce jointe + XMP) est, elle, conforme.
// ============================================================
const money = require('./money');

// ---------- Utilitaires de sérialisation ----------

/**
 * Échappe une valeur pour un nœud texte ou un attribut XML.
 * @param {unknown} value
 * @returns {string}
 */
function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    // Les caractères de contrôle sont interdits en XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * Formate un montant CII : exactement deux décimales, point décimal.
 * @param {number} amount
 * @returns {string}
 */
function ciiAmount(amount) {
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
}

/**
 * Formate une quantité CII : jusqu'à quatre décimales.
 * @param {number} quantity
 * @returns {string}
 */
function ciiQuantity(quantity) {
  return (Number.isFinite(quantity) ? quantity : 0).toFixed(4);
}

/**
 * Formate un taux de TVA CII : deux décimales (0.2 → « 20.00 »).
 * @param {number} rate
 * @returns {string}
 */
function ciiRate(rate) {
  return (Number.isFinite(rate) ? rate * 100 : 0).toFixed(2);
}

/**
 * Convertit « AAAA-MM-JJ » en date CII format 102 (« AAAAMMJJ »).
 * @param {string} isoDate
 * @returns {string} chaîne vide si la date est absente ou invalide
 */
function ciiDate(isoDate) {
  const compact = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  return compact ? `${compact[1]}${compact[2]}${compact[3]}` : '';
}

/**
 * Horodatage PDF (« D:AAAAMMJJHHmmSS », temps universel).
 * @param {Date} date
 * @returns {string}
 */
function pdfDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * Chaîne PDF UTF-16BE hexadécimale (avec BOM), pour les noms non ASCII.
 * @param {string} text
 * @returns {string}
 */
function pdfHexString(text) {
  const bytes = Buffer.from(`\uFEFF${text}`, 'utf16le').swap16();
  return `<${bytes.toString('hex').toUpperCase()}>`;
}

// ---------- Génération du XML CII (EN 16931) ----------

/**
 * Construit le XML Factur-X (profil EN 16931) d'une facture.
 * Les totaux sont TOUJOURS recalculés depuis les lignes : un montant
 * falsifié côté client ne peut pas entrer dans le document fiscal.
 * @param {{
 *   number: string,
 *   client: string,
 *   issueDate: string,
 *   dueDate?: string,
 *   items: Array<{ description?: string, quantity?: number, price?: number, taxRate?: number }>,
 *   company?: { legalName?: string, billingAddress?: string, vatNumber?: string }
 * }} invoice facture normalisée
 * @param {{ currency?: string }} [options]
 * @returns {string} XML CII complet
 */
function buildFacturxXml(invoice, { currency = 'EUR' } = {}) {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const totals = money.computeTotals(items.map(item => ({
    quantity: Number(item?.quantity) || 0,
    price: Number(item?.price) || 0,
    taxRate: Number(item?.taxRate) || 0
  })));
  const issueDate = ciiDate(invoice.issueDate);
  const dueDate = ciiDate(invoice.dueDate);
  const sellerName = invoice.company?.legalName || 'IZI SAS';

  const lines = items
    .filter(item => item?.description || Number(item?.price) !== 0)
    .map((item, index) => {
      const quantity = Number(item?.quantity) || 0;
      const price = Number(item?.price) || 0;
      const rate = Number(item?.taxRate) || 0;
      const lineHT = money.round2(quantity * price);
      return `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${index + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${xmlEscape(item.description || 'Prestation')}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:GrossPriceProductTradePrice><ram:ChargeAmount>${ciiAmount(price)}</ram:ChargeAmount></ram:GrossPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">${ciiQuantity(quantity)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>${ciiRate(rate)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${ciiAmount(lineHT)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
    });

  // Ventilation de TVA : une rubrique par taux (exigence EN 16931).
  const taxBreakdown = totals.byRate.map(bucket => `      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${ciiAmount(bucket.amount)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${ciiAmount(bucket.base)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${ciiRate(bucket.rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('\n');

  const sellerAddress = invoice.company?.billingAddress
    ? `\n        <ram:PostalTradeAddress><ram:LineOne>${xmlEscape(invoice.company.billingAddress)}</ram:LineOne><ram:CountryID>FRA</ram:CountryID></ram:PostalTradeAddress>`
    : '';
  const sellerVat = invoice.company?.vatNumber
    ? `\n        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(invoice.company.vatNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`
    : '';
  const paymentTerms = dueDate
    ? `\n      <ram:SpecifiedTradePaymentTerms>\n        <ram:DueDateDateTime><udt:DateTimeString format="102">${dueDate}</udt:DateTimeString></ram:DueDateDateTime>\n      </ram:SpecifiedTradePaymentTerms>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEscape(invoice.number)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${issueDate}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${lines.join('\n')}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${xmlEscape(sellerName)}</ram:Name>${sellerAddress}${sellerVat}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${xmlEscape(invoice.client)}</ram:Name>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${xmlEscape(currency)}</ram:InvoiceCurrencyCode>${paymentTerms}
${taxBreakdown}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${ciiAmount(totals.ht)}</ram:LineTotalAmount>
        <ram:ChargeTotalAmount>0.00</ram:ChargeTotalAmount>
        <ram:AllowanceTotalAmount>0.00</ram:AllowanceTotalAmount>
        <ram:TaxBasisTotalAmount>${ciiAmount(totals.ht)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${xmlEscape(currency)}">${ciiAmount(totals.tva)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${ciiAmount(totals.ttc)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${ciiAmount(totals.ttc)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

/**
 * Métadonnées XMP décrivant le document Factur-X (exigence Factur-X 1.0).
 * @param {Date} modDate date de dernière modification (UTC)
 * @param {string} [conformanceLevel] profil électronique (ex. « EN 16931 »)
 * @returns {string} document XMP complet
 */
function buildXmpMetadata(modDate, conformanceLevel = 'EN 16931') {
  const iso = modDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Facture Factur-X</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>IZI SAS</rdf:li></rdf:Seq></dc:creator>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>IZI Facture</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${xmlEscape(conformanceLevel)}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>${iso}</xmp:CreateDate>
      <xmp:ModifyDate>${iso}</xmp:ModifyDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ---------- Écriture PDF incrémentale ----------

/**
 * Découpe la valeur d'un dictionnaire PDF : renvoie la fin de chaque type
 * de valeur (référence, dictionnaire, tableau, chaîne, hex, nombre, booléen).
 * @param {string} text texte source
 * @param {number} start index de début de la valeur
 * @returns {{ value: string, end: number }} valeur brute et index suivant
 */
function readPdfValue(text, start) {
  const rest = text.slice(start);
  const head = /^[\s]*([^\s/<>[(]+)?/.exec(rest);
  const firstChar = rest.trimStart()[0] || '';

  // Référence « N G R » : deux entiers suivis de R.
  const ref = /^\s*(\d+)\s+(\d+)\s+R\b/.exec(rest);
  if (ref) return { value: ref[0].trim(), end: start + ref.index + ref[0].length };
  if (firstChar === '/' || head?.[1]) {
    const token = /^\s*(\/[^\s/<>[(]*|[^\s/<>[(]+)/.exec(rest);
    return { value: token ? token[1] : '', end: start + (token ? token.index + token[1].length : 0) };
  }
  if (firstChar === '<' && rest.trimStart()[1] !== '<') {
    const hex = /^\s*<[^>]*>/.exec(rest);
    return { value: hex[0], end: start + hex.index + hex[0].length };
  }
  if (firstChar === '<') {
    const dict = readBalanced(text, start, '<<', '>>');
    return dict;
  }
  if (firstChar === '[') {
    const array = readBalanced(text, start, '[', ']');
    return array;
  }
  if (firstChar === '(') {
    const str = readPdfString(text, start);
    return str;
  }
  return { value: '', end: start + rest.length };
}

/**
 * Lit une structure équilibrée (« <<…>> » ou « […] ») avec imbrication.
 * @param {string} text texte source
 * @param {number} start index du délimiteur ouvrant
 * @param {string} open délimiteur ouvrant
 * @param {string} close délimiteur fermant
 * @returns {{ value: string, end: number }}
 */
function readBalanced(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text.startsWith(open, i)) { depth += 1; i += open.length - 1; continue; }
    if (text.startsWith(close, i)) {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start, i + close.length), end: i + close.length };
      i += close.length - 1;
    }
  }
  return { value: text.slice(start), end: text.length };
}

/**
 * Lit une chaîne littérale PDF « (… ) » en respectant les échappements.
 * @param {string} text texte source
 * @param {number} start index de la parenthèse ouvrante
 * @returns {{ value: string, end: number }}
 */
function readPdfString(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return { value: text.slice(start), end: text.length };
}

/**
 * Analyse un dictionnaire PDF au premier niveau : nom → valeur brute.
 * Tolérant aux valeurs imbriquées (dictionnaires, tableaux, chaînes).
 * @param {string} raw corps du dictionnaire, délimiteurs « << >> » inclus
 * @returns {Map<string, string>} clés /Name → valeur brute
 */
function parsePdfDict(raw) {
  const entries = new Map();
  const keyPattern = /\/([A-Za-z][A-Za-z0-9]*)/g;
  let match;
  while ((match = keyPattern.exec(raw)) !== null) {
    const key = match[1];
    // Une clé de premier niveau se trouve juste à l'intérieur du `<<`
    // ouvrant : la profondeur y vaut exactement 2. Les clés imbriquées
    // (valeur de type dictionnaire, ex. /Params) sont à 4 ou plus.
    if (nestingDepth(raw.slice(0, match.index)) !== TOP_LEVEL_DEPTH) continue;
    const { value, end } = readPdfValue(raw, keyPattern.lastIndex);
    entries.set(key, value.trim());
    // CRUCIAL : on saute la valeur consommée. Sinon la regex traiterait les
    // noms figurant DANS la valeur (ex. /Type /Catalog → fausse clé
    // « Catalog ») et produirait des entrées dupliquées à l'écriture.
    keyPattern.lastIndex = end;
  }
  return entries;
}

/** Profondeur d'une clé de premier niveau : juste après le `<<` ouvrant. */
const TOP_LEVEL_DEPTH = 2;

/**
 * Calcule la profondeur d'imbrication à un point du texte (dicts, tableaux,
 * chaînes). `<<` ajoute 2, `>>` en retire 2, `[`/`]` 1 ; le contenu des
 * chaînes ( … ) est ignoré, y compris les parenthèses échappées.
 * @param {string} prefix texte précédant la clé
 * @returns {number} profondeur courante (2 = premier niveau du dictionnaire)
 */
function nestingDepth(prefix) {
  let depth = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    const char = prefix[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth -= 1; continue; }
    if (depth > 0) continue; // À l'intérieur d'une chaîne : ignorer << >> [].
    if (char === '<' && prefix[i + 1] === '<') { depth += 2; i += 1; continue; }
    if (char === '>' && prefix[i + 1] === '>') { depth -= 2; i += 1; continue; }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
  }
  return depth;
}

// ---------- Incorporation Factur-X dans un PDF ----------

/**
 * Incorpore le XML Factur-X dans un PDF existant par mise à jour
 * incrémentale : le PDF d'origine n'est jamais réécrit, un nouveau
 * segment est ajouté à la fin (fichier incorporé, nouveau catalogue,
 * métadonnées XMP). Le lecteur PDF conserve ainsi l'intégralité du
 * contenu signable d'origine.
 * @param {Buffer} pdfBuffer PDF complet (pdfkit)
 * @param {string} xml XML CII Factur-X (UTF-8)
 * @param {{ modDate?: Date, conformanceLevel?: string }} [options]
 * @returns {Buffer} PDF enrichi, prêt à être envoyé
 * @throws {Error} si la structure PDF est inexploitable
 */
function appendFacturxToPdf(pdfBuffer, xml, { modDate = new Date(), conformanceLevel } = {}) {
  const latin = pdfBuffer.toString('latin1');
  const eofIndex = latin.lastIndexOf('%%EOF');
  if (eofIndex === -1) throw new Error('PDF invalide : marqueur %%EOF introuvable.');
  const trailerMatch = /trailer\s*(<<[\s\S]*?>>)\s*startxref\s+(\d+)\s*%%EOF\s*$/s.exec(latin.slice(0, eofIndex + 5));
  if (!trailerMatch) throw new Error('PDF invalide : trailer ou startxref introuvable.');

  const trailer = parsePdfDict(trailerMatch[1]);
  const rootRef = /^(\d+)\s+\d+\s+R$/.exec(trailer.get('Root') || '');
  const size = Number(trailer.get('Size'));
  const idRaw = trailer.get('ID');
  if (!rootRef || !Number.isInteger(size) || size < 1 || !idRaw) {
    throw new Error('PDF invalide : trailer incomplet (/Size, /Root ou /ID manquant).');
  }
  const catalogNumber = Number(rootRef[1]);
  const catalogPattern = new RegExp(`\\n${catalogNumber} 0 obj\\s*(<<[\\s\\S]*?>>)\\s*endobj`);
  const catalogMatch = catalogPattern.exec(latin);
  if (!catalogMatch) throw new Error(`PDF invalide : objet catalogue ${catalogNumber} introuvable.`);

  // ---------- Nouveaux objets ----------
  const xmlBytes = Buffer.from(xml, 'utf8');
  const xmp = buildXmpMetadata(modDate, conformanceLevel);
  const xmpBytes = Buffer.from(xmp, 'utf8');
  const modDatePdf = pdfDate(modDate);
  const base = size; // premier numéro d'objet disponible
  const efRef = `${base} 0 R`;        // EmbeddedFile (flux XML)
  const fsRef = `${base + 1} 0 R`;    // Filespec
  const namesRef = `${base + 2} 0 R`; // arbre de noms EmbeddedFiles
  const metaRef = `${base + 3} 0 R`;  // flux de métadonnées XMP
  const newCatalogRef = `${base + 4} 0 R`;

  const fileName = 'factur-x.xml';
  const objects = [
    `<< /Type /EmbeddedFile /Subtype (text#2Fxml) /Params << /ModDate (D:${modDatePdf}) /Size ${xmlBytes.length} >> /Length ${xmlBytes.length} >>\nstream\n`,
    xmlBytes,
    `\nendstream`,
    `<< /Type /Filespec /F (${fileName}) /UF ${pdfHexString(fileName)} /EF << /F ${efRef} /UF ${efRef} >> /Desc (Factur-X invoice data) /AFRelationship /Data >>`,
    `<< /Names [(${fileName}) ${fsRef}] >>`,
    `<< /Type /Metadata /Subtype /XML /Length ${xmpBytes.length} >>\nstream\n`,
    xmpBytes,
    `\nendstream`
  ];

  // ---------- Catalogue enrichi (conservation des clés existantes) ----------
  const catalogEntries = parsePdfDict(catalogMatch[1]);
  const oldNames = catalogEntries.get('Names');
  // L'ancien /Names peut porter /Dests : on conserve ses autres entrées et
  // on remplace uniquement /EmbeddedFiles.
  let namesDict = `<< /EmbeddedFiles ${namesRef} >>`;
  if (oldNames && oldNames.startsWith('<<')) {
    const oldNamesEntries = [...parsePdfDict(oldNames).entries()]
      .filter(([key]) => key !== 'EmbeddedFiles')
      .map(([key, value]) => `/${key} ${value}`);
    // Convention de sérialisation du module : `<`+espace (lisible, aligné
    // sur les autres dictionnaires produits ici).
    namesDict = `<< ${oldNamesEntries.join(' ')} /EmbeddedFiles ${namesRef} >>`.replace('<<  <<', '<< <<');
  }
  const kept = [...catalogEntries.keys()].filter(key => key !== 'Type' && key !== 'Names' && key !== 'AF' && key !== 'Metadata');
  const catalogBody = [
    '<<',
    '/Type /Catalog',
    ...kept.map(key => `/${key} ${catalogEntries.get(key)}`),
    `/AF [${fsRef}]`,
    `/Names ${namesDict}`,
    `/Metadata ${metaRef}`,
    '>>'
  ].join(' ');

  // ---------- Assemblage du segment ----------
  const parts = [];
  let running = pdfBuffer.length + 1; // +1 pour le '\n' séparateur initial
  /** @type {Array<{ number: number, offset: number }>} */
  const offsets = [];
  // Les objets texte et leurs flux binaires alternent : on concatène tout.
  const sections = [
    { number: base, content: objects.slice(0, 3) },
    { number: base + 1, content: [objects[3]] },
    { number: base + 2, content: [objects[4]] },
    { number: base + 3, content: objects.slice(5, 8) },
    { number: base + 4, content: [catalogBody] }
  ];
  parts.push(Buffer.from('\n', 'latin1'));
  for (const section of sections) {
    offsets.push({ number: section.number, offset: running });
    const header = Buffer.from(`${section.number} 0 obj\n`, 'latin1');
    const body = section.content.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'));
    const tail = Buffer.from('\nendobj\n', 'latin1');
    parts.push(header, ...body, tail);
    running += header.length + body.reduce((sum, buf) => sum + buf.length, 0) + tail.length;
  }

  const xrefOffset = running;
  const xrefEntries = offsets.map(entry => `${String(entry.offset).padStart(10, '0')} 00000 n \n`).join('');
  const xref = Buffer.from(
    `xref\n${base} 5\n${xrefEntries}trailer\n<< /Size ${base + 5} /Root ${newCatalogRef} /ID ${idRaw} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'latin1'
  );
  parts.push(xref);
  return Buffer.concat([pdfBuffer, ...parts]);
}

module.exports = {
  xmlEscape,
  ciiAmount,
  ciiQuantity,
  ciiRate,
  ciiDate,
  pdfDate,
  pdfHexString,
  buildFacturxXml,
  buildXmpMetadata,
  parsePdfDict,
  readPdfValue,
  appendFacturxToPdf
};
