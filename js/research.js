// Online-Recherche über TCGdex (https://tcgdex.dev): freie Pokémon-TCG-Datenbank, ohne Schlüssel,
// mit deutschen Namen, Erscheinungsdaten, Seltenheit und Cardmarket-Preisen (Euro, täglich aktualisiert).
// 1) Katalog (data/katalog.json, wöchentlich per GitHub Action erzeugt): alle Sets und Karten auf Deutsch
//    und Englisch für die schnelle Suche, auch offline und beim Excel-Import.
// 2) TCGdex direkt aus der App: Details einer Karte inkl. aktuellem Marktwert.
import { normalizeCardNumber } from './store.js';

const API = 'https://api.tcgdex.net/v2';
export const LANGS = { Deutsch: 'de', Englisch: 'en', Japanisch: 'ja', Französisch: 'fr', Italienisch: 'it', Spanisch: 'es', Portugiesisch: 'pt', Koreanisch: 'ko', 'Chinesisch (trad.)': 'zh-tw' };
export const langCode = (language) => LANGS[language] || 'de';

// ---------- Katalog ----------
// Format: { sets: { id: [name_de, name_en, serie_de, serieId, releaseDate, official, total] },
//           cards: { de: [[id, localId, name, hatBild], ...], en: [...] } }
let catalogPromise = null;
export function catalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('data/katalog.json')
      .then((r) => (r.ok ? r.json() : { sets: {}, cards: {} }))
      .catch(() => ({ sets: {}, cards: {} }));
    catalogPromise.then((c) => { if (!Object.keys(c.sets || {}).length) catalogPromise = null; });
  }
  return catalogPromise;
}

function setInfo(c, setId) {
  const s = c.sets?.[setId];
  if (!s) return null;
  const [nameDe, nameEn, serie, serieId, releaseDate, official, total] = s;
  return { id: setId, nameDe, nameEn, serie, serieId, releaseDate, official, total };
}

function imageUrl(lang, serieId, setId, localId) {
  return serieId ? `https://assets.tcgdex.net/${lang}/${serieId}/${setId}/${encodeURIComponent(localId)}` : '';
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Alle Sets für Auswahllisten (neueste zuerst)
export async function allSets() {
  const c = await catalog();
  return Object.keys(c.sets || {}).map((id) => setInfo(c, id))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}

// Set anhand eines Namens oder Kürzels finden (für Excel-Import), z. B. "151", "Karmesin & Purpur – 151", "sv03.5"
export async function findSet(text) {
  const c = await catalog();
  const t = norm(text);
  if (!t) return null;
  if (c.sets?.[String(text).trim()]) return setInfo(c, String(text).trim());
  let best = null, bestScore = 0;
  for (const id of Object.keys(c.sets || {})) {
    const s = setInfo(c, id);
    for (const n of [s.nameDe, s.nameEn, id]) {
      const nn = norm(n);
      if (!nn) continue;
      let score = 0;
      if (nn === t) score = 100;
      else if (t.endsWith(' ' + nn) || t.startsWith(nn + ' ')) score = 60 + nn.length; // "Karmesin & Purpur 151"
      else if (nn.includes(t) && t.length >= 4) score = 40 + t.length;
      if (score > bestScore) { bestScore = score; best = s; }
    }
  }
  return best;
}

// Karten nach Name suchen (Katalog), optional auf ein Set beschränkt
export async function searchCards(query, { language = 'Deutsch', setId = '', limit = 60 } = {}) {
  const c = await catalog();
  const lang = c.cards?.[langCode(language)] ? langCode(language) : 'de';
  const list = c.cards?.[lang] || [];
  const q = norm(query);
  const num = normalizeCardNumber(query);
  const out = [];
  for (const [id, localId, name, hasImg] of list) {
    const sid = id.slice(0, id.length - String(localId).length - 1);
    if (setId && sid !== setId) continue;
    if (q && !norm(name).includes(q) && !(setId && normalizeCardNumber(localId) === num)) continue;
    const s = setInfo(c, sid) || { id: sid };
    out.push({ id, localId, name, setId: sid, setName: (lang === 'de' ? s.nameDe : s.nameEn) || s.nameDe || s.nameEn || sid,
      releaseDate: s.releaseDate || '', official: s.official, image: hasImg ? imageUrl(lang, s.serieId, sid, localId) : '', lang });
    if (out.length >= limit * 4) break;
  }
  out.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || String(a.localId).localeCompare(String(b.localId), 'de', { numeric: true }));
  return out.slice(0, limit);
}

// Karte über Set + Nummer finden
export async function findCard(setId, number, language = 'Deutsch') {
  const c = await catalog();
  const want = normalizeCardNumber(number);
  for (const lang of [langCode(language), 'de', 'en']) {
    for (const [id, localId] of c.cards?.[lang] || []) {
      if (id.startsWith(setId + '-') && id.length === setId.length + 1 + String(localId).length && normalizeCardNumber(localId) === want) return id;
    }
  }
  return setId && want ? `${setId}-${number}` : '';
}

// Pokémon aus dem Kartennamen ableiten: "Glurak-ex" -> "Glurak", "Erikas Myrapla" -> "Myrapla",
// "Alola-Vulpix" -> "Vulpix", "Pikachu VMAX" -> "Pikachu". Bei Trainer- und Energiekarten leer.
export function pokemonFromName(name, category = '') {
  if (/trainer|energ/i.test(category)) return '';
  let n = String(name || '').trim();
  n = n.replace(/^(Team (Rockets?|Aquas?|Magmas?)'?s?|Rocket's)\s+/i, '');
  for (let i = 0; i < 3; i++) {
    n = n.replace(/^(Mega-|M\s|Alola-|Galar-|Hisui-|Paldea-|Dunkle[sr]?\s|Leuchtende[sr]?\s|Strahlende[sr]?\s|Glänzende[sr]?\s|Schillernde[sr]?\s|Licht-?\s?|Dark\s|Light\s|Shining\s|Radiant\s|Alolan\s|Galarian\s|Hisuian\s|Paldean\s)/i, '');
  }
  n = n.replace(/[\s-]+(ex|EX|GX|V|VMAX|VSTAR|V-STAR|V-UNION|BREAK|LV\.?\s?X|Prime|LEGENDE|LEGEND|δ|☆|Star|TAG TEAM|Spezial)(\b.*)?$/, '');
  const words = n.split(/\s+/);
  if (words.length > 1 && /^[A-ZÄÖÜ][\wäöüß.]*('?s|s')$/.test(words[0]) && !/^(Mr|Mrs)\.?$/.test(words[0])) n = words.slice(1).join(' ');
  n = n.replace(/^Lt\.\s+Surges?\s+/i, '');
  return n.trim();
}

// ---------- TCGdex live ----------
async function api(lang, path) {
  let res;
  try { res = await fetch(`${API}/${lang}/${path}`); } catch { throw new Error('TCGdex nicht erreichbar'); }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('TCGdex nicht erreichbar (' + res.status + ')');
  return res.json();
}

const TYPES_DE = { Grass: 'Pflanze', Fire: 'Feuer', Water: 'Wasser', Lightning: 'Elektro', Psychic: 'Psycho', Fighting: 'Kampf', Darkness: 'Finsternis', Metal: 'Metall', Dragon: 'Drache', Fairy: 'Fee', Colorless: 'Farblos' };
const CAT_DE = { Pokemon: 'Pokémon', 'Pokémon': 'Pokémon', Trainer: 'Trainer', Energy: 'Energie' };

// Cardmarket-Preise einer Einzelkarte (über TCGdex, täglich aktualisiert): normale Version und Holo/Reverse-Holo
const price = (v) => (typeof v === 'number' && v > 0 ? Math.round(v * 100) / 100 : null);
export function cardmarketPrices(cm) {
  const pick = (suffix) => ({ low: price(cm['low' + suffix]), trend: price(cm['trend' + suffix]), avg1: price(cm['avg1' + suffix]),
    avg7: price(cm['avg7' + suffix]), avg30: price(cm['avg30' + suffix]) });
  const has = (o) => Object.values(o).some((v) => v != null);
  const normal = pick(''), holo = pick('-holo');
  return { id: cm.idProduct || null, updated: (cm.updated || '').slice(0, 10), normal: has(normal) ? normal : null, holo: has(holo) ? holo : null };
}

export async function lookupCard(tcgdexId, language = 'Deutsch') {
  const c = await catalog();
  const sid = tcgdexId.replace(/-[^-]+$/, '');
  const result = { tcgdexId };
  const s = setInfo(c, sid);
  if (s) Object.assign(result, { setId: sid, setName: (language === 'Englisch' ? s.nameEn : s.nameDe) || s.nameDe || s.nameEn, serie: s.serie, setTotal: s.official || null, releaseDate: s.releaseDate || '' });
  const sources = [];
  if (s) sources.push('Katalog');
  let card = null, error = '';
  for (const lang of [...new Set([langCode(language), 'de', 'en'])]) {
    try { card = await api(lang, 'cards/' + encodeURIComponent(tcgdexId)); } catch (e) { error = e.message; break; }
    if (card) { card.lang = lang; break; }
  }
  if (card) {
    sources.push('TCGdex');
    Object.assign(result, {
      name: card.name,
      number: card.localId,
      setId: card.set?.id || result.setId,
      setName: result.setName || card.set?.name,
      setTotal: card.set?.cardCount?.official || result.setTotal || null,
      rarity: card.rarity || '',
      category: CAT_DE[card.category] || card.category || '',
      types: (card.types || []).map((t) => TYPES_DE[t] || t).join(', '),
      hp: card.hp || null,
      illustrator: card.illustrator || '',
      imageUrl: card.image ? card.image + '/high.webp' : '',
    });
    let cm = card.pricing?.cardmarket;
    // Manche Sprachversionen liefern keine Preise: dann die englische Fassung derselben Karte fragen
    if (!cm && card.lang !== 'en') {
      try { cm = (await api('en', 'cards/' + encodeURIComponent(tcgdexId)))?.pricing?.cardmarket; } catch { /* egal */ }
    }
    if (cm) {
      result.cmPrices = cardmarketPrices(cm);
      result.marketValue = price(cm.trend) ?? price(cm.avg30) ?? price(cm.avg) ?? price(cm['trend-holo']) ?? price(cm['avg30-holo']);
      result.marketValueHolo = price(cm['trend-holo']) ?? price(cm['avg30-holo']);
      result.marketUpdated = (cm.updated || '').slice(0, 10);
    }
    if (!result.releaseDate && result.setId) {
      try {
        const set = await api(card.lang, 'sets/' + encodeURIComponent(result.setId));
        if (set) { result.releaseDate = set.releaseDate || ''; result.serie = result.serie || set.serie?.name || ''; }
      } catch { /* egal */ }
    }
  } else if (s) {
    const lid = tcgdexId.slice(sid.length + 1);
    const lang = langCode(language) === 'en' ? 'en' : 'de';
    const hit = (c.cards?.[lang] || []).find((x) => x[0] === tcgdexId);
    if (hit) Object.assign(result, { name: hit[2], number: lid, imageUrl: hit[3] ? imageUrl(lang, s.serieId, sid, lid) + '/high.webp' : '' });
  }
  if (result.releaseDate) result.year = Number(result.releaseDate.slice(0, 4)) || null;
  return { result, sources, error };
}

// Produkt: Erscheinungsdatum über das zugehörige Set
export async function lookupProductSet(setName) {
  const s = await findSet(setName);
  if (!s) return null;
  return { setId: s.id, setName: s.nameDe || s.nameEn, serie: s.serie, releaseDate: s.releaseDate || '', year: s.releaseDate ? Number(s.releaseDate.slice(0, 4)) : null,
    logo: s.serieId ? `https://assets.tcgdex.net/${s.nameDe ? 'de' : 'en'}/${s.serieId}/${s.id}/logo.png` : '' };
}

const CARD_FIELDS = ['name', 'pokemon', 'number', 'setId', 'setName', 'serie', 'setTotal', 'rarity', 'category', 'types', 'hp', 'illustrator', 'imageUrl', 'releaseDate', 'year', 'tcgdexId'];
const PRICE_FIELDS = ['marketValue', 'marketValueHolo', 'marketUpdated', 'cmPrices'];

// Ergänzt fehlende Felder (eigene Eingaben bleiben erhalten, außer overwrite = true).
// Der Marktwert wird immer aktualisiert, wenn TCGdex einen liefert.
export async function enrich(item, { overwrite = false } = {}) {
  const apply = (r, fields, force) => {
    for (const k of fields) {
      if (r[k] === null || r[k] === undefined || r[k] === '') continue;
      const empty = item[k] === null || item[k] === '' || item[k] === undefined;
      if (empty || force) item[k] = r[k];
    }
  };
  let sources = [], notes = [];
  if (item.kind === 'karte') {
    if (!item.tcgdexId && item.setId && item.number) item.tcgdexId = await findCard(item.setId, item.number, item.language);
    if (!item.tcgdexId && item.setName && item.number) {
      const s = await findSet(item.setName);
      if (s) item.tcgdexId = await findCard(s.id, item.number, item.language);
    }
    if (item.tcgdexId) {
      const { result, sources: src, error } = await lookupCard(item.tcgdexId, item.language);
      if (result.name) result.pokemon = pokemonFromName(result.name, result.category);
      apply(result, CARD_FIELDS, overwrite);
      apply(result, PRICE_FIELDS, true);
      sources = src;
      if (error) notes.push(error + ', Marktwert nicht aktualisiert');
      else if (src.includes('TCGdex') && result.marketValue == null) notes.push('kein Cardmarket-Preis');
    } else notes.push('Set und Kartennummer angeben, um die Karte zu finden');
    if (!item.pokemon && item.name) item.pokemon = pokemonFromName(item.name, item.category);
  } else {
    if (!item.cmId) {
      const m = await autoMatchProduct(item);
      if (m) { item.cmId = m.id; item.cmName = m.name; item.cmAuto = true; }
    }
    if (item.cmId) {
      const p = await lookupProduct(item.cmId);
      if (p) {
        sources.push('Cardmarket');
        const v = p.trend ?? p.avg30 ?? null;
        if (v != null) { item.marketValue = v; item.marketUpdated = (p.stand || '').slice(0, 10); }
        else notes.push('kein Cardmarket-Preis');
        if (p.image && (!item.imageUrl || item.imageAuto)) { item.imageUrl = p.image; item.imageAuto = true; }
      }
    } else notes.push('kein passendes Cardmarket-Produkt gefunden');
    if (item.setName) {
      const r = await lookupProductSet(item.setName);
      if (r) {
        apply(r, ['setId', 'serie', 'releaseDate', 'year'], overwrite); sources.push('Katalog');
        if (!item.imageUrl && r.logo) { item.imageUrl = r.logo; item.imageAuto = true; }
      }
      else notes.push('Set nicht im Katalog gefunden');
    }
    if (!item.uvp) notes.push('UVP bitte von Hand eintragen');
  }
  if (!item.year) notes.push('Erscheinungsjahr nicht gefunden');
  const complete = item.kind === 'karte' ? !!(item.year && item.name && item.setName) : !!(item.year && item.uvp && item.cmId);
  item.research = {
    status: !sources.length ? 'notfound' : complete ? 'ok' : 'partial',
    source: sources.join(' + ') || '–',
    at: new Date().toISOString(),
    message: (!sources.length ? 'nicht gefunden' + (notes.length ? ' (' : '') : '') + notes.join(', ') + (!sources.length && notes.length ? ')' : ''),
  };
  return item;
}

// ---------- Versiegelte Produkte: Cardmarket-Produktliste mit Marktwert ----------
// data/produkte.json wird wöchentlich aus den frei herunterladbaren Cardmarket-Daten erzeugt.
let productsPromise = null;
export function products() {
  if (!productsPromise) {
    productsPromise = fetch('data/produkte.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : { produkte: [] }))
      .catch(() => ({ produkte: [] }));
    productsPromise.then((c) => { if (!(c.produkte || []).length) productsPromise = null; });
  }
  return productsPromise;
}
export function resetProducts() { productsPromise = null; }

// Deutsche Begriffe in die (englischen) Cardmarket-Produktnamen übersetzen
const DE_EN = [[/top[\s-]*trainer[\s-]*box|ttb/g, 'elite trainer box'], [/display|booster[\s-]*display/g, 'booster box'], [/sammelkoffer/g, 'collector chest'],
  [/kollektion/g, 'collection'], [/premium[\s-]*kollektion/g, 'premium collection'], [/themendeck|starterdeck/g, 'theme deck'], [/booster[\s-]*bundle/g, 'booster bundle'],
  [/karmesin\s*(&|und)?\s*purpur/g, 'scarlet violet'], [/schwert\s*(&|und)?\s*schild/g, 'sword shield'], [/sonne\s*(&|und)?\s*mond/g, 'sun moon']];

function productRow(r, stand) {
  const [id, name, type, exp, trend, avg30, low, img] = r;
  return { id, name, type, exp, trend, avg30, low, stand, image: img ? `https://tcgplayer-cdn.tcgplayer.com/product/${img}_200w.jpg` : '' };
}


export async function searchProducts(query, limit = 40) {
  const c = await products();
  let q = String(query || '').toLowerCase();
  for (const [re, en] of DE_EN) q = q.replace(re, en);
  // deutsche Setnamen durch englische ersetzen (z. B. "Flammende Finsternis" -> "Darkness Ablaze")
  const cat = await catalog();
  for (const s of Object.values(cat.sets || {})) {
    if (s[0] && s[1] && s[0].length > 3 && q.includes(s[0].toLowerCase())) q = q.replace(s[0].toLowerCase(), s[1].toLowerCase());
  }
  const words = norm(q).split(' ').filter((w) => w && !['pokemon', 'und'].includes(w));
  if (!words.length) return [];
  const hits = [];
  for (const r of c.produkte || []) {
    const n = norm(r[1] + ' ' + r[2]);
    if (words.every((w) => n.includes(w))) hits.push(productRow(r, c.stand));
  }
  hits.sort((a, b) => b.id - a.id); // neueste zuerst
  return hits.slice(0, limit);
}

// Deutsche -> englische Pokémon-Namen aus dem Katalog (gleiche Karten-ID in beiden Sprachen)
let pkMap = null;
async function pokemonMap() {
  if (pkMap) return pkMap;
  const c = await catalog();
  const en = new Map((c.cards?.en || []).map((x) => [x[0], x[2]]));
  pkMap = new Map();
  for (const [id, , nameDe] of c.cards?.de || []) {
    const nameEn = en.get(id);
    if (!nameEn) continue;
    const de = norm(pokemonFromName(nameDe)), e = norm(pokemonFromName(nameEn));
    if (de && e && de.length > 2 && !pkMap.has(de)) pkMap.set(de, e);
  }
  return pkMap;
}

// Englische Bezeichnung je Produktart, wie sie bei Cardmarket im Namen steht
const TYPE_EN = {
  'Display (Booster-Box)': ['booster box', 'Display'], 'Top-Trainer-Box (ETB)': ['elite trainer box', 'Top-Trainer-Box'],
  Booster: ['booster', 'Booster'], 'Sleeved Booster': ['sleeved booster', 'Booster'], 'Booster-Bundle': ['booster bundle', 'Display'],
  'Build & Battle Box': ['build battle box', 'Box / Kollektion'], Blister: ['blister', 'Blister'], Tin: ['tin', 'Tin'], 'Mini-Tin': ['mini tin', 'Tin'],
  Kollektion: ['collection', 'Box / Kollektion'], 'Premium-Kollektion': ['premium collection', 'Box / Kollektion'],
  'Ultra-Premium-Kollektion': ['ultra premium collection', 'Box / Kollektion'], 'Themendeck / Starterdeck': ['theme deck', 'Themendeck'],
  Sammelkoffer: ['collector chest', 'Tin'],
};
const PENALTY = ['pokemon center', 'case', 'costco', 'sam s club', '6 cards', '3 cards', 'fun pack', 'version', 'coin', 'promos', 'bundle display', 'mini tin display', 'build battle box display', 'jumbo'];

// Passendes Cardmarket-Produkt automatisch finden (Set + Produktart + ggf. Pokémon im Namen)
export async function autoMatchProduct(item) {
  const c = await products();
  if (!(c.produkte || []).length) return null;
  const set = item.setName ? await findSet(item.setName) : null;
  const setEn = norm(set?.nameEn || set?.nameDe || item.setName || '');
  const [typeEn, typeCat] = TYPE_EN[item.productType] || ['', ''];
  // Zusatzwörter aus dem eigenen Namen (z. B. Pokémon "Glurak" -> "charizard")
  const map = await pokemonMap();
  let extra = norm(item.name);
  for (const w of [setEn, norm(item.setName), norm(item.productType)]) if (w) extra = extra.replace(w, ' ');
  let q = extra;
  for (const [re, en] of DE_EN) q = q.replace(re, en);
  const extraWords = norm(q).split(' ').filter((w) => w.length > 2 && !['box', 'pokemon', 'und', 'mit', 'der', 'die', 'das', 'top', 'trainer', 'display', 'booster', 'tin', 'blister'].includes(w))
    .map((w) => map.get(w) || w);
  if (!setEn && !extraWords.length) return null;
  const want = norm(`${setEn} ${typeEn}`);
  let best = null, bestScore = 0;
  for (const r of c.produkte) {
    const n = norm(r[1]);
    if (setEn && !(' ' + n + ' ').includes(' ' + setEn + ' ')) continue;
    if (typeCat && r[2] !== typeCat) continue;
    if (typeEn && !typeEn.split(' ').every((w) => n.includes(w))) continue;
    let score = 50;
    if (n === want || n === 'pokemon card ' + want) score = 100;
    for (const p of PENALTY) if (n.includes(p) && !want.includes(p) && !extraWords.some((w) => p.includes(w))) score -= 25;
    for (const w of extraWords) score += n.includes(w) ? 15 : -5;
    score -= Math.max(0, n.split(' ').length - want.split(' ').length - extraWords.length) * 2;
    if (score > bestScore || (score === bestScore && best && r[0] > best[0])) { bestScore = score; best = r; }
  }
  return best && bestScore >= 30 ? productRow(best, c.stand) : null;
}

export async function lookupProduct(id) {
  const c = await products();
  const r = (c.produkte || []).find((x) => x[0] === Number(id));
  return r ? productRow(r, c.stand) : null;
}

export function cardmarketUrl(item) {
  if (item.cmName) return 'https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=' + encodeURIComponent(item.cmName);
  const q = item.kind === 'karte' ? [item.name, item.setName, item.number].filter(Boolean).join(' ') : [item.name || item.productType, item.setName].filter(Boolean).join(' ');
  return 'https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=' + encodeURIComponent(q);
}
