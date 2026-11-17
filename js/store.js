// Lokale Datenhaltung (IndexedDB) und Datenmodell.
// Die gesamte Sammlung ist ein JSON-Objekt; Fotos liegen separat als Blobs.

const DB_NAME = 'pokemon-sammlung';
const DB_VERSION = 1;
let idbPromise;

function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const res = fn(s);
    t.oncomplete = () => resolve(res && 'result' in res ? res.result : res);
    t.onerror = () => reject(t.error);
  });
}

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k) => tx('kv', 'readwrite', (s) => s.delete(k)),
};
export const photoStore = {
  get: (k) => tx('photos', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('photos', 'readwrite', (s) => s.put(v, k)),
  del: (k) => tx('photos', 'readwrite', (s) => s.delete(k)),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export const now = () => new Date().toISOString();

export function emptyCollection() {
  return { schema: 1, sets: {}, deleted: {}, updatedAt: now() };
}

// Ein Eintrag ist entweder eine einzelne Karte (kind 'karte') oder ein versiegeltes Produkt
// (kind 'produkt', z. B. Display, Top-Trainer-Box, Booster, Tin). Mehrere Exemplare je Eintrag.
export function newSet(fields = {}) {
  return {
    id: uid(),
    kind: 'karte',     // 'karte' | 'produkt'
    name: '',
    pokemon: '',       // Pokémon für Sortierung/Filter, z. B. "Glurak" (aus dem Kartennamen abgeleitet)
    // Karte
    setId: '',         // TCGdex-Set-ID, z. B. "sv03.5"
    setName: '',       // z. B. "151"
    serie: '',         // z. B. "Karmesin & Purpur"
    number: '',        // Kartennummer im Set, z. B. "006"
    setTotal: null,    // offizielle Kartenanzahl des Sets, z. B. 165
    rarity: '',
    category: '',      // Pokémon | Trainer | Energie
    types: '',         // z. B. "Feuer"
    hp: null,
    illustrator: '',
    language: 'Deutsch',
    tcgdexId: '',      // z. B. "sv03.5-006"
    // Produkt
    productType: '',   // Display, Top-Trainer-Box, Booster, Blister, Tin, Kollektion …
    ean: '',
    cmId: null,        // Cardmarket-Produkt-ID (für den Marktwert)
    cmName: '',        // Name des Produkts bei Cardmarket
    cmAuto: false,     // automatisch verknüpft (wird bei Änderungen neu gesucht)
    // gemeinsam
    releaseDate: '',   // Erscheinungsdatum JJJJ-MM-TT
    year: null,        // Erscheinungsjahr
    uvp: null,         // UVP Deutschland in Euro (v. a. Produkte)
    marketValue: null, // Marktwert in Euro (Cardmarket-Trend bei Karten)
    marketUpdated: '',
    imageUrl: '',
    wishlist: false,
    notes: '',
    research: null,    // { status, source, at, message }
    copies: [],
    photos: [],        // { id, copyId, thumb, enhanced, createdAt }
    createdAt: now(),
    updatedAt: now(),
    ...fields,
  };
}

export function newCopy(fields = {}) {
  return {
    id: uid(),
    purchaseDate: '',  // JJJJ-MM-TT
    price: null,       // Einkaufspreis in Euro
    shop: '',          // Händler / Quelle
    variant: '',       // Karte: Normal, Holo, Reverse Holo, 1. Edition …
    edition: '',       // Karte: 1. Edition, Unlimited, Shadowless, Promo …
    condition: null,   // Zustand 1–10 (10 = sehr gut)
    grading: '',       // Karte: Cardmarket-Zustand (Mint, Near Mint …)
    graded: false,     // Karte: professionell bewertet (gegradet)?
    grader: '',        // PSA, BGS, CGC …
    grade: '',         // Note, z. B. "10" oder "9.5"
    certNumber: '',    // Zertifikatsnummer
    damage: '',        // Beschädigungen (Freitext)
    state: '',         // Produkt: versiegelt | geöffnet ; Karte: Hülle (Sleeve, Toploader, Slab …)
    location: '',      // Lagerort, z. B. Ordner 3, Seite 12
    soldDate: '',
    soldPrice: null,
    notes: '',
    ...fields,
  };
}

// Zwei Stände der Sammlung zusammenführen: pro Set gewinnt der neuere Stand,
// Löschungen (Tombstones) gewinnen, wenn sie neuer sind als die letzte Änderung.
export function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = emptyCollection();
  out.deleted = { ...a.deleted };
  for (const [id, ts] of Object.entries(b.deleted || {})) {
    if (!out.deleted[id] || out.deleted[id] < ts) out.deleted[id] = ts;
  }
  const ids = new Set([...Object.keys(a.sets || {}), ...Object.keys(b.sets || {})]);
  for (const id of ids) {
    const x = a.sets[id], y = b.sets[id];
    let pick = !x ? y : !y ? x : (x.updatedAt >= y.updatedAt ? x : y);
    if (out.deleted[id] && out.deleted[id] >= pick.updatedAt) continue;
    out.sets[id] = pick;
  }
  const sa = a.settings, sb = b.settings;
  if (sa || sb) out.settings = !sa ? sb : !sb ? sa : (sa.updatedAt >= sb.updatedAt ? sa : sb);
  out.updatedAt = a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt;
  return out;
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
export function sameContent(a, b) {
  return stable(a) === stable(b);
}

export function normalizeSetNumber(n) {
  return String(n ?? '').trim().replace(/\s+/g, '').replace(/\.0$/, '');
}

// Kartennummer vergleichbar machen: "6/165" -> "6", "006" -> "6", "TG05" bleibt "TG05"
export function normalizeCardNumber(n) {
  let s = String(n ?? '').trim().split('/')[0].replace(/\.0$/, '');
  if (/^\d+$/.test(s)) s = String(parseInt(s, 10));
  return s.toUpperCase();
}
