// Import und Export von Excel-Listen (über SheetJS).
import { newSet, newCopy, normalizeCardNumber } from './store.js';

export const FIELDS = [
  ['kind', 'Art (Karte / Produkt)', /^(art|typ|kategorie|karte\s*\/\s*produkt)$/i],
  ['name', 'Name', /^(name|karte|kartenname|bezeichnung|titel|produkt(name)?|beschreibung)$/i],
  ['pokemon', 'Pokémon', /^(pok[eé]mon|pkmn)$/i],
  ['setName', 'Set / Erweiterung', /^(set|set[\s-]*name|erweiterung|edition[\s-]*name|serie|expansion)/i],
  ['number', 'Kartennummer', /(karten[\s-]*n(umme)?r|^n(umme)?r\.?$|^nummer|^#|^no\.?$|number)/i],
  ['language', 'Sprache', /(sprache|language|lang)/i],
  ['rarity', 'Seltenheit', /(seltenheit|rarit)/i],
  ['variant', 'Variante (Holo, Reverse …)', /(variante|holo|reverse|foil)/i],
  ['edition', 'Edition (1. Edition …)', /^(edition|auflage|1\.?\s*ed)/i],
  ['productType', 'Produktart (Display, Box …)', /(produktart|produkttyp|art des produkts|verpackungsart)/i],
  ['year', 'Erscheinungsjahr', /(jahr|year|erschein)/i],
  ['uvp', 'UVP', /(uvp|rrp|listenpreis|neupreis|empf)/i],
  ['purchaseDate', 'Kaufdatum', /(kaufdatum|gekauft am|datum|date)/i],
  ['price', 'Einkaufspreis', /(einkauf|kaufpreis|ek|bezahlt|^preis)/i],
  ['shop', 'Händler', /(händler|haendler|shop|gekauft bei|quelle|laden|verkäufer)/i],
  ['condition', 'Zustand (1–10)', /^(zustand|condition)(\s*\(?1\s*[-–]\s*10\)?)?$/i],
  ['grading', 'Zustand Cardmarket (NM, EX …)', /(near mint|grading|kartenzustand|cardmarket)/i],
  ['graded', 'Gegradet (ja/nein)', /^(gegrad|graded|grading\??$)/i],
  ['grader', 'Grading-Firma (PSA, BGS …)', /(grader|grading[\s-]*firma|psa|bgs|cgc|bewertet von)/i],
  ['grade', 'Grading-Note', /^(note|grade|bewertung)$/i],
  ['damage', 'Beschädigungen', /(schad|schäd|beschäd|mängel|defekt)/i],
  ['quantity', 'Anzahl Exemplare', /^(anzahl|menge|stück|stk|qty|exemplare)$/i],
  ['marketValue', 'Marktwert', /(marktwert|wert|market)/i],
  ['location', 'Lagerort', /(lager|ort|standort|ordner)/i],
  ['notes', 'Bemerkung', /(bemerk|notiz|kommentar|hinweis|info)/i],
];

export async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: 'array', cellDates: true });
}

export function sheetRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  let hi = rows.findIndex((r) => r.filter((c) => typeof c === 'string' && c.trim()).length >= 2);
  if (hi < 0) hi = 0;
  return { headers: (rows[hi] || []).map((h) => String(h).trim()), rows: rows.slice(hi + 1).filter((r) => r.some((c) => c !== '')) };
}

export function guessMapping(headers) {
  const map = {};
  const used = new Set();
  for (const [key, , re] of FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && h && re.test(h));
    if (idx >= 0) { map[key] = idx; used.add(idx); }
  }
  return map;
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function date(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return s;
}
const txt = (v) => String(v ?? '').trim();

function language(v) {
  const s = txt(v).toLowerCase();
  if (!s) return '';
  if (/^(de|ger|deu|deutsch|german)/.test(s)) return 'Deutsch';
  if (/^(en|eng|englisch|english)/.test(s)) return 'Englisch';
  if (/^(jp|ja|jap)/.test(s)) return 'Japanisch';
  if (/^(fr|franz)/.test(s)) return 'Französisch';
  if (/^(it|ital)/.test(s)) return 'Italienisch';
  if (/^(es|span)/.test(s)) return 'Spanisch';
  if (/^(ko|kor)/.test(s)) return 'Koreanisch';
  return txt(v);
}

export function itemKey(s) {
  return s.kind === 'karte'
    ? ['k', s.language, (s.tcgdexId || s.setName).toLowerCase(), normalizeCardNumber(s.number), s.tcgdexId ? '' : s.name.toLowerCase()].join('|')
    : ['p', s.name.toLowerCase(), s.setName.toLowerCase(), s.language].join('|');
}

// Zeilen in Einträge umwandeln. Gleiche Karte / gleiches Produkt in mehreren Zeilen = mehrere Exemplare.
export function buildItems(rows, map, existing = [], defaultKind = 'karte') {
  const byKey = new Map(existing.map((s) => [itemKey(s), s]));
  const touched = new Map();
  const cell = (r, k) => (map[k] === undefined || map[k] === '' ? '' : r[map[k]]);
  for (const r of rows) {
    const name = txt(cell(r, 'name'));
    const number = txt(cell(r, 'number')).replace(/\.0$/, '');
    const setName = txt(cell(r, 'setName'));
    const productType = txt(cell(r, 'productType'));
    if (!name && !number && !productType) continue;
    const kindTxt = txt(cell(r, 'kind')).toLowerCase();
    const kind = /karte|card|single/.test(kindTxt) ? 'karte'
      : kindTxt ? 'produkt'
      : productType ? 'produkt' : number ? 'karte' : defaultKind;
    const draft = newSet({ kind, name, setName, number: kind === 'karte' ? number : '', productType, language: language(cell(r, 'language')) || 'Deutsch' });
    const key = itemKey(draft);
    let item = touched.get(key) || byKey.get(key) || draft;
    const pick = (k, v) => { if ((item[k] === null || item[k] === '') && v !== null && v !== '') item[k] = v; };
    pick('rarity', txt(cell(r, 'rarity')));
    pick('pokemon', txt(cell(r, 'pokemon')));
    pick('year', num(cell(r, 'year')));
    pick('uvp', num(cell(r, 'uvp')));
    pick('marketValue', num(cell(r, 'marketValue')));
    const note = txt(cell(r, 'notes'));
    if (note && !item.notes.includes(note)) item.notes = item.notes ? item.notes + '\n' + note : note;
    const qtyRaw = num(cell(r, 'quantity'));
    const qty = qtyRaw === null ? 1 : Math.max(0, Math.round(qtyRaw));
    for (let i = 0; i < qty; i++) {
      const cond = num(cell(r, 'condition'));
      item.copies.push(newCopy({
        purchaseDate: date(cell(r, 'purchaseDate')),
        price: num(cell(r, 'price')),
        shop: txt(cell(r, 'shop')),
        variant: txt(cell(r, 'variant')),
        edition: txt(cell(r, 'edition')),
        condition: cond !== null && cond >= 1 && cond <= 10 ? Math.round(cond) : null,
        grading: txt(cell(r, 'grading')),
        grader: txt(cell(r, 'grader')),
        graded: /^(ja|j|yes|y|x|1|true|wahr)$/i.test(txt(cell(r, 'graded'))) || !!txt(cell(r, 'grader')) || !!txt(cell(r, 'grade')),
        grade: txt(cell(r, 'grade')),
        damage: txt(cell(r, 'damage')),
        state: kind === 'produkt' ? 'versiegelt' : '',
        location: txt(cell(r, 'location')),
      }));
    }
    if (qty === 0) item.wishlist = true;
    touched.set(key, item);
  }
  return [...touched.values()];
}

export function exportExcel(items) {
  const rows = [];
  for (const s of items) {
    const base = {
      Art: s.kind === 'karte' ? 'Karte' : 'Produkt', Name: s.name, Pokémon: s.pokemon, Set: s.setName, Kartennummer: s.number ? s.number + (s.setTotal ? '/' + s.setTotal : '') : '',
      Sprache: s.language, Seltenheit: s.rarity, Produktart: s.productType, Erscheinungsdatum: s.releaseDate || s.year,
      'UVP (€)': s.uvp, 'Marktwert (€)': s.marketValue, Bemerkung: s.notes,
    };
    if (!s.copies.length) rows.push({ ...base, Exemplar: '' });
    s.copies.forEach((c, i) => rows.push({
      ...base, Exemplar: i + 1, Kaufdatum: c.purchaseDate, 'Einkaufspreis (€)': c.price, Händler: c.shop,
      Variante: c.variant, Edition: c.edition, 'Zustand (1-10)': c.condition, 'Zustand Cardmarket': c.grading,
      Gegradet: c.graded ? 'ja' : 'nein', Grading: c.graded ? [c.grader, c.grade].filter(Boolean).join(' ') : '', Zertifikat: c.certNumber, Beschädigungen: c.damage,
      'Verpackung / Hülle': c.state, Lagerort: c.location, 'Verkauft am': c.soldDate, 'Verkaufspreis (€)': c.soldPrice,
    }));
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sammlung');
  XLSX.writeFile(wb, `Pokemon-Sammlung-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
