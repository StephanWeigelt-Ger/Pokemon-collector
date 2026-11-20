import { newSet, newCopy, uid, now, kv, normalizeCardNumber } from './store.js';
import * as data from './data.js';
import * as dbx from './dropbox.js';
import * as photo from './photo.js';
import * as research from './research.js';
import * as importer from './importer.js';
import { DROPBOX_APP_KEY } from './config.js';

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- Hilfsfunktionen ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => (v === null || v === undefined || v === '' ? '–' : Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const dateDe = (v) => (v ? new Date(v + (v.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('de-DE') : '');
const numOrNull = (v) => { if (v === '' || v === null) return null; const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const opts = (list, cur, empty) => (empty !== undefined ? `<option value="">${empty}</option>` : '') + list.map((o) => `<option ${cur === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
const today = () => new Date().toISOString().slice(0, 10);

const COND_CARD = { 1: 'stark beschädigt', 2: 'sehr stark bespielt', 3: 'stark bespielt', 4: 'bespielt', 5: 'deutliche Gebrauchsspuren', 6: 'leichte Gebrauchsspuren', 7: 'gut', 8: 'sehr gut', 9: 'nahezu perfekt', 10: 'perfekt / wie neu' };
const COND_PACK = { 1: 'sehr schlecht', 2: 'stark beschädigt', 3: 'deutlich beschädigt', 4: 'beschädigt', 5: 'mittelmäßig', 6: 'akzeptabel', 7: 'gut mit Gebrauchsspuren', 8: 'gut', 9: 'sehr gut', 10: 'neuwertig / perfekt' };
const CM_GRADES = ['Mint (MT)', 'Near Mint (NM)', 'Excellent (EX)', 'Good (GD)', 'Light Played (LP)', 'Played (PL)', 'Poor (PO)'];
const GRADERS = ['PSA', 'BGS (Beckett)', 'CGC', 'SGC', 'TAG', 'PCA', 'GSG', 'Andere'];
const VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'Cosmos Holo', 'Pokéball-Reverse', 'Meisterball-Reverse', 'Promo / Stempel', 'Fehldruck'];
const EDITIONS = ['Unlimited', '1. Edition', 'Shadowless'];
const SLEEVES = ['ohne Hülle', 'Sleeve', 'Toploader', 'Card Saver', 'Magnet-Case', 'Slab (gegradet)', 'Ordner / Binder'];
const PRODUCT_TYPES = ['Display (Booster-Box)', 'Top-Trainer-Box (ETB)', 'Booster', 'Sleeved Booster', 'Blister', 'Booster-Bundle', 'Tin', 'Mini-Tin', 'Kollektion', 'Premium-Kollektion', 'Ultra-Premium-Kollektion', 'Themendeck / Starterdeck', 'Build & Battle Box', 'Sammelkoffer', 'Sonstiges'];
const PRODUCT_STATES = ['versiegelt', 'geöffnet', 'nur Verpackung'];

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), ms);
}

const isCard = (s) => s.kind === 'karte';
function activeCopies(s) { return s.copies.filter((c) => !c.soldDate && c.soldPrice === null); }
function copyValue(s, c) {
  if (isCard(s) && !s.marketManual && s.marketValueHolo && /holo|reverse|ball/i.test(c.variant || '') && !/^holo$/i.test(s.rarity || '')) return s.marketValueHolo;
  return s.marketValue || 0;
}
// Titelbild: selbst gewähltes Foto, sonst das automatisch gefundene Bild, sonst das erste eigene Foto
function itemImage(s) {
  const own = s.titlePhoto && s.photos.find((p) => p.id === s.titlePhoto);
  return own ? own.thumb : s.imageUrl || (s.photos[0] ? s.photos[0].thumb : '');
}
function numberLabel(s) { return s.number ? s.number + (s.setTotal ? '/' + s.setTotal : '') : ''; }
function title(s) { return s.name || s.productType || 'Ohne Namen'; }

// leere Werte ans Ende, sonst alphabetisch
const last = (x, y) => (!x && !y ? 0 : !x ? 1 : !y ? -1 : x.localeCompare(y, 'de'));

function sortItems(list, by) {
  const cmp = {
    name: (a, b) => title(a).localeCompare(title(b), 'de'),
    setName: (a, b) => last(a.setName, b.setName) || String(a.number).localeCompare(String(b.number), 'de', { numeric: true }) || title(a).localeCompare(title(b), 'de'),
    pokemon: (a, b) => last(a.pokemon, b.pokemon) || title(a).localeCompare(title(b), 'de') || (a.setName || '').localeCompare(b.setName || '', 'de'),
    set: (a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || a.setName.localeCompare(b.setName, 'de') || String(a.number).localeCompare(String(b.number), 'de', { numeric: true }),
    date: (a, b) => (b.releaseDate || String(b.year || '')).localeCompare(a.releaseDate || String(a.year || '')),
    value: (a, b) => (b.marketValue || 0) - (a.marketValue || 0),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  }[by] || (() => 0);
  return list.sort(cmp);
}

// ---------- Übersicht ----------
const ui = { search: '', sort: 'setName', kind: '', set: '', pokemon: '', show: 'all' };

function renderList() {
  const items = data.all();
  const owned = items.filter((s) => !s.wishlist);
  let copies = 0, invested = 0, market = 0, uvpSum = 0;
  for (const s of owned) {
    const act = activeCopies(s);
    copies += act.length;
    for (const c of act) { invested += c.price || 0; market += copyValue(s, c); }
    if (!isCard(s)) uvpSum += (s.uvp || 0) * act.length;
  }
  const nCards = owned.filter(isCard).length, nProducts = owned.length - nCards;
  const setNames = [...new Set(items.map((s) => s.setName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const pokemons = [...new Set(items.map((s) => s.pokemon).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const q = ui.search.toLowerCase();
  let list = items.filter((s) => {
    if (ui.kind && s.kind !== ui.kind) return false;
    if (ui.set && s.setName !== ui.set) return false;
    if (ui.pokemon && s.pokemon !== ui.pokemon) return false;
    if (ui.show === 'wish' && !s.wishlist) return false;
    if (ui.show === 'owned' && s.wishlist) return false;
    if (ui.show === 'graded' && !s.copies.some((c) => c.graded || c.grader)) return false;
    if (ui.show === 'multi' && activeCopies(s).length < 2) return false;
    if (ui.show === 'missing' && s.research?.status === 'ok') return false;
    if (!q) return true;
    return [s.name, s.pokemon, s.setName, s.number, s.rarity, s.productType, s.language, s.notes, ...s.copies.map((c) => [c.damage, c.location, c.shop, c.variant, c.grader, c.certNumber].join(' '))].join(' ').toLowerCase().includes(q);
  });
  list = sortItems(list, ui.sort);

  app.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${nCards}</b><span>Karten</span></div>
      <div class="stat"><b>${nProducts}</b><span>Produkte</span></div>
      <div class="stat"><b>${copies}</b><span>Exemplare</span></div>
      <div class="stat"><b>${eur(invested)}</b><span>Summe Einkaufspreise</span></div>
      ${market ? `<div class="stat"><b>${eur(market)}</b><span>Marktwert (Cardmarket)</span></div>` : ''}
      ${market && invested ? `<div class="stat"><b>${eur(Math.abs(market - invested))}</b><span>${market >= invested ? 'Wertzuwachs' : 'unter Einkaufspreis'} (${Math.round(Math.abs(market / invested - 1) * 100)} %)</span></div>` : ''}
      ${uvpSum ? `<div class="stat"><b>${eur(uvpSum)}</b><span>Summe UVP Produkte</span></div>` : ''}
    </div>
    <div class="toolbar">
      <input class="search" type="search" placeholder="Suchen: Name, Set, Nummer, Schaden …" value="${esc(ui.search)}" id="q">
      <select id="sort" aria-label="Sortierung">
        ${[['setName', 'Setname (A–Z)'], ['pokemon', 'Pokémon (A–Z)'], ['set', 'Set nach Erscheinung'], ['name', 'Kartenname'], ['date', 'Erscheinung (neueste)'], ['value', 'Marktwert'], ['updated', 'Zuletzt geändert']]
          .map(([v, l]) => `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <a class="btn primary" href="#/neu">＋ Neu</a>
    </div>
    <div class="row" style="margin-bottom:14px">
      <select id="kind" style="max-width:170px" aria-label="Art">
        ${[['', 'Karten & Produkte'], ['karte', 'Nur Karten'], ['produkt', 'Nur Produkte']].map(([v, l]) => `<option value="${v}" ${ui.kind === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="setF" style="max-width:220px" aria-label="Set"><option value="">Alle Sets</option>${opts(setNames, ui.set)}</select>
      <select id="pkF" style="max-width:200px" aria-label="Pokémon"><option value="">Alle Pokémon</option>${opts(pokemons, ui.pokemon)}</select>
      <select id="show" style="max-width:200px" aria-label="Filter">
        ${[['all', 'Alle'], ['owned', 'Nur Sammlung'], ['wish', 'Wunschliste'], ['graded', 'Gegradet'], ['multi', 'Mehrfach vorhanden'], ['missing', 'Daten unvollständig']]
          .map(([v, l]) => `<option value="${v}" ${ui.show === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="muted small">${list.length} von ${items.length}</span>
    </div>
    ${list.length ? `<div class="set-list">${list.map(itemRow).join('')}</div>` : `
      <div class="empty">${items.length ? 'Keine Treffer.' : 'Noch nichts erfasst.<br><br><a class="btn primary" href="#/neu">Erste Karte oder erstes Produkt anlegen</a> <a class="btn" href="#/einstellungen">Excel-Liste importieren</a>'}</div>`}
  `;
  const qi = $('#q');
  qi.addEventListener('input', () => { ui.search = qi.value; renderListKeepFocus(); });
  $('#sort').onchange = (e) => { ui.sort = e.target.value; renderList(); };
  $('#kind').onchange = (e) => { ui.kind = e.target.value; renderList(); };
  $('#setF').onchange = (e) => { ui.set = e.target.value; renderList(); };
  $('#pkF').onchange = (e) => { ui.pokemon = e.target.value; renderList(); };
  $('#show').onchange = (e) => { ui.show = e.target.value; renderList(); };
}

function renderListKeepFocus() {
  const pos = $('#q').selectionStart;
  renderList();
  const qi = $('#q');
  qi.focus();
  qi.setSelectionRange(pos, pos);
}

function itemRow(s) {
  const act = activeCopies(s);
  const conds = act.map((c) => c.condition).filter(Boolean);
  const graded = act.filter((c) => c.graded || c.grader).map((c) => ((c.grader || 'gegradet').split(' ')[0] + ' ' + (c.grade || '')).trim());
  const img = itemImage(s);
  const meta = isCard(s)
    ? [s.setName, numberLabel(s), s.rarity, s.language !== 'Deutsch' ? s.language : ''].filter(Boolean)
    : [s.productType !== s.name ? s.productType : '', s.setName, s.year, s.language !== 'Deutsch' ? s.language : ''].filter(Boolean);
  return `<a class="set-item" href="#/item/${s.id}">
    ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="thumb">${isCard(s) ? '🃏' : '📦'}</div>`}
    <div>
      <div class="title">${esc(title(s))}</div>
      <div class="meta">${meta.map(esc).join(' · ')}${s.marketValue ? ' · Wert ' + eur(s.marketValue) : ''}</div>
      <div class="badges">
        ${s.wishlist ? '<span class="badge warn">Wunschliste</span>' : `<span class="badge">${act.length}× vorhanden</span>`}
        ${graded.map((g) => `<span class="badge ok">${esc(g)}</span>`).join('')}
        ${conds.length ? `<span class="badge">Zustand ${conds.join(' / ')}</span>` : ''}
        ${!isCard(s) && act.some((c) => c.state === 'versiegelt') ? '<span class="badge">versiegelt</span>' : ''}
        ${s.research && s.research.status !== 'ok' ? '<span class="badge warn">Daten fehlen</span>' : ''}
      </div>
    </div>
  </a>`;
}

// Setnamen aus dem Katalog plus selbst eingetragene (neue) Sets
function allSetNames(sets) {
  const own = data.all().map((x) => x.setName).filter(Boolean);
  return [...new Set([...own, ...sets.map((x) => x.nameDe || x.nameEn)])].sort((a, b) => a.localeCompare(b, 'de'));
}

// Cardmarket-Produkt auswählen (für Marktwert versiegelter Produkte)
function cmPicker(box, query, onPick) {
  box.innerHTML = `<label class="field"><span>Cardmarket-Produkt suchen (für den Marktwert)</span>
    <input class="cmQ" value="${esc(query)}" placeholder="z. B. 151 Top-Trainer-Box"></label><div class="cmHits"></div>`;
  const inp = $('.cmQ', box), list = $('.cmHits', box);
  let t;
  const run = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const hits = inp.value.trim().length >= 2 ? await research.searchProducts(inp.value) : [];
      list.innerHTML = hits.length ? hits.map((h) => `<button class="cm-hit" data-id="${h.id}"><b>${esc(h.name)}</b>
          <span>${esc(h.type)}${h.trend != null ? ' · Marktwert ' + eur(h.trend) : ''}</span></button>`).join('')
        : inp.value.trim().length >= 2 ? '<p class="muted small">Kein Produkt gefunden. Tipp: englische Begriffe probieren, z. B. „Elite Trainer Box“, „Booster Box“, „Collection“.</p>' : '';
      $$('.cm-hit', list).forEach((b) => (b.onclick = () => {
        $$('.cm-hit', list).forEach((x) => x.classList.toggle('on', x === b));
        onPick(hits.find((h) => String(h.id) === b.dataset.id));
      }));
    }, 250);
  };
  inp.addEventListener('input', () => { inp.dataset.touched = '1'; run(); });
  run();
  return { setQuery: (q) => { if (!inp.dataset.touched) { inp.value = q; run(); } } };
}

// ---------- Neu anlegen ----------
const newUi = { kind: 'karte', language: 'Deutsch', setId: '' };

async function renderNew() {
  const sets = await research.allSets();
  const card = newUi.kind === 'karte';
  app.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a href="#/" class="btn small">← Übersicht</a></div>
    <h1>Neu erfassen</h1>
    <div class="seg" id="kindSeg" style="margin-bottom:12px"><button data-k="karte" class="${card ? 'on' : ''}">🃏 Karte</button><button data-k="produkt" class="${card ? '' : 'on'}">📦 Versiegeltes Produkt</button></div>
    ${card ? `
    <div class="card">
      <div class="grid two">
        <label class="field"><span>Kartenname suchen</span><input id="cQ" placeholder="z. B. Glurak, Pikachu" autofocus></label>
        <label class="field"><span>Set (optional)</span><select id="cSet"><option value="">alle Sets</option>
          ${sets.map((s) => `<option value="${s.id}" ${newUi.setId === s.id ? 'selected' : ''}>${esc(s.nameDe || s.nameEn)}${s.releaseDate ? ' (' + s.releaseDate.slice(0, 4) + ')' : ''}</option>`).join('')}</select></label>
        <label class="field"><span>Sprache der Karte</span><select id="cLang">${opts(Object.keys(research.LANGS), newUi.language)}</select></label>
      </div>
      <p class="muted small">Tipp: Set wählen und die Kartennummer eintippen (z. B. 6 oder 006/165), dann erscheint genau diese Karte.</p>
      ${sets.length ? '' : '<p class="small">⚠️ Der Kartenkatalog ist noch nicht geladen. Die Suche funktioniert, sobald er einmal erstellt wurde. Bis dahin unten von Hand anlegen.</p>'}
      <label class="check"><input type="checkbox" id="nWish"> Nur auf die Wunschliste (noch nicht gekauft)</label>
      <div id="cResults" class="hits"></div>
    </div>
    <h2>Nicht gefunden? Direkt eintragen</h2>
    <div class="card">
      <p class="muted small">Für ganz neue Sets und Karten, Promos oder Sonderdrucke. Ein neues Set einfach mit seinem Namen eintippen; es steht danach in allen Listen zur Auswahl.</p>
      <div class="grid">
        <label class="field"><span>Kartenname</span><input id="mName" placeholder="z. B. Glurak-ex"></label>
        <label class="field"><span>Pokémon</span><input id="mPk" placeholder="z. B. Glurak"></label>
        <label class="field"><span>Set (vorhanden oder neu)</span><input id="mSet" list="setList"></label>
        <label class="field"><span>Kartennummer</span><input id="mNum" placeholder="z. B. 006"></label>
        <label class="field"><span>Karten im Set</span><input id="mTotal" type="number" inputmode="numeric" placeholder="z. B. 165"></label>
        <label class="field"><span>Seltenheit</span><input id="mRar" placeholder="z. B. Illustration Rare"></label>
        <label class="field"><span>Erscheinungsdatum</span><input id="mDate" type="date"></label>
      </div>
      <datalist id="setList">${allSetNames(sets).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="mCreate">Karte anlegen</button></div>
    </div>` : `
    <div class="card">
      <div class="grid two">
        <label class="field"><span>Produktart</span><select id="pType">${opts(PRODUCT_TYPES, '')}</select></label>
        <label class="field"><span>Name / Bezeichnung</span><input id="pName" placeholder="z. B. Top-Trainer-Box Karmesin & Purpur 151"></label>
        <label class="field"><span>Set / Erweiterung</span><input id="pSet" list="setList" placeholder="z. B. 151"></label>
        <label class="field"><span>Sprache</span><select id="pLang">${opts(Object.keys(research.LANGS), newUi.language)}</select></label>
        <label class="field"><span>UVP Deutschland (€, falls bekannt)</span><input id="pUvp" type="number" step="0.01" inputmode="decimal"></label>
      </div>
      <datalist id="setList">${allSetNames(sets).map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label class="check"><input type="checkbox" id="nWish"> Nur auf die Wunschliste (noch nicht gekauft)</label>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="pCreate">Anlegen</button><a class="btn" href="#/">Abbrechen</a></div>
      <p class="muted small">Erscheinungsdatum und Cardmarket-Marktwert werden automatisch ergänzt; das passende Cardmarket-Produkt sucht die App selbst. Eine UVP gibt es für Pokémon-Produkte in keiner freien Datenbank; bitte von Hand eintragen.</p>
    </div>`}`;

  $$('#kindSeg button').forEach((b) => (b.onclick = () => { newUi.kind = b.dataset.k; renderNew(); }));
  if (card) {
    let timer;
    const search = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = $('#cQ').value.trim();
        newUi.setId = $('#cSet').value;
        newUi.language = $('#cLang').value;
        const box = $('#cResults');
        if (!q && !newUi.setId) { box.innerHTML = ''; return; }
        if (q.length < 2 && !newUi.setId) { box.innerHTML = ''; return; }
        const hits = await research.searchCards(q, { language: newUi.language, setId: newUi.setId, limit: newUi.setId && !q ? 400 : 60 });
        box.innerHTML = hits.length ? hits.map((h) => `<button class="hit" data-id="${esc(h.id)}">
            ${h.image ? `<img src="${esc(h.image)}/low.webp" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="noimg">🃏</div>'}
            <b>${esc(h.name)}</b><span>${esc(h.setName)} · ${esc(h.localId)}${h.official ? '/' + h.official : ''}</span></button>`).join('')
          : '<p class="muted">Keine Karte gefunden. Unten kannst du sie von Hand anlegen.</p>';
        $$('.hit', box).forEach((b) => (b.onclick = () => createCard({ tcgdexId: b.dataset.id })));
      }, 250);
    };
    $('#cQ').addEventListener('input', search);
    $('#cSet').onchange = search;
    $('#cLang').onchange = search;
    if (newUi.setId) search();
    $('#mCreate').onclick = () => {
      const name = $('#mName').value.trim(), setName = $('#mSet').value.trim(), number = $('#mNum').value.trim();
      if (!name && !number) return toast('Bitte Name oder Kartennummer eingeben.');
      const releaseDate = $('#mDate').value;
      createCard({ name, setName, number, pokemon: $('#mPk').value.trim(), rarity: $('#mRar').value.trim(),
        setTotal: numOrNull($('#mTotal').value), releaseDate, year: releaseDate ? Number(releaseDate.slice(0, 4)) : null });
    };
  } else {
    const suggest = () => { if (!$('#pName').value) $('#pName').placeholder = $('#pType').value + ($('#pSet').value ? ' ' + $('#pSet').value : ''); };
    $('#pType').onchange = suggest;
    $('#pSet').addEventListener('change', suggest);
    $('#pCreate').onclick = async () => {
      const productType = $('#pType').value, setName = $('#pSet').value.trim();
      const name = $('#pName').value.trim() || [productType, setName].filter(Boolean).join(' ');
      if (!name) return toast('Bitte Produktart oder Name angeben.');
      newUi.language = $('#pLang').value;
      const item = newSet({ kind: 'produkt', name, productType, setName, language: newUi.language, uvp: numOrNull($('#pUvp').value), wishlist: $('#nWish').checked });
      if (!item.wishlist) item.copies.push(newCopy({ purchaseDate: today(), state: 'versiegelt' }));
      await data.save(item);
      location.hash = '#/item/' + item.id;
      autoResearch(item.id);
    };
  }
}

async function createCard(fields) {
  const language = $('#cLang')?.value || newUi.language;
  const wish = $('#nWish')?.checked;
  const existing = fields.tcgdexId && data.all().find((s) => s.tcgdexId === fields.tcgdexId && s.language === language);
  if (existing && !confirm('Diese Karte ist schon vorhanden. Stattdessen ein weiteres Exemplar hinzufügen?')) return;
  let item = existing;
  if (!item) {
    item = newSet({ kind: 'karte', language, wishlist: !!wish, ...fields });
    if (!item.wishlist) item.copies.push(newCopy({ purchaseDate: today() }));
  } else {
    item.copies.push(newCopy({ purchaseDate: today() }));
    item.wishlist = false;
  }
  await data.save(item);
  location.hash = '#/item/' + item.id;
  if (!existing) autoResearch(item.id);
}

async function autoResearch(id, overwrite = false) {
  const item = data.get(id);
  if (!item) return;
  toast('Recherche läuft …');
  await research.enrich(item, { overwrite });
  await data.save(item);
  const r = item.research;
  toast(r.status === 'ok' ? 'Daten gefunden und ergänzt.' + (r.message ? ' (' + r.message + ')' : '') : r.status === 'partial' ? 'Teilweise gefunden: ' + r.message : 'Recherche: ' + r.message, 4500);
  if (location.hash === '#/item/' + id) renderItem(id);
}

// ---------- Detail ----------
function field(label, name, value, type = 'text', extra = '') {
  return `<label class="field"><span>${label}</span><input data-f="${name}" type="${type}" value="${esc(value ?? '')}" ${extra}></label>`;
}
function select(label, name, list, value, attr = 'data-f') {
  const all = value && !list.includes(value) ? [...list, value] : list;
  return `<label class="field"><span>${label}</span><select ${attr}="${name}">${opts(all, value || '', '–')}</select></label>`;
}

// Cardmarket-Preise einer Einzelkarte: Ab-Preis, Trend und Durchschnitte, getrennt nach normal und Holo/Reverse
function cardmarketBox(s) {
  const p = s.cmPrices;
  const manual = s.marketManual ? `<p class="small" style="margin-top:8px">Dein selbst eingetragener Marktwert (${eur(s.marketValue)}) gilt und wird bei Aktualisierungen nicht überschrieben. Leere das Feld „Marktwert aktuell“, um wieder den Cardmarket-Preis zu verwenden.</p>` : '';
  const warn = p?.warning ? `<p class="small" style="color:var(--warn);margin-bottom:8px">⚠️ ${esc(p.warning)}. Die Werte unten gehören daher wohl zu einer anderen Karte. Öffne die Karte über „Cardmarket ↗“ und trage den Preistrend selbst bei „Marktwert aktuell“ ein.</p>` : '';
  if (!p || (!p.normal && !p.holo)) {
    return `<h2>Wert bei Cardmarket</h2><div class="card"><p class="small muted">Noch keine Cardmarket-Preise für diese Karte. Tippe auf „Daten &amp; Marktwert aktualisieren“, um sie abzurufen.</p>${manual}</div>`;
  }
  const cols = [['normal', 'Normal'], ['holo', 'Holo / Reverse']].filter(([k]) => p[k]);
  const rows = [['low', 'Ab-Preis'], ['trend', 'Preistrend'], ['avg30', 'Ø 30 Tage'], ['avg7', 'Ø 7 Tage'], ['avg1', 'Ø 1 Tag']]
    .filter(([k]) => cols.some(([c]) => p[c][k] != null));
  return `<h2>Wert bei Cardmarket</h2><div class="card">${warn}
    <table class="prices"><thead><tr><th></th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([k, l]) => `<tr${k === 'trend' ? ' class="main"' : ''}><td>${l}</td>${cols.map(([c]) => `<td>${eur(p[c][k])}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="small muted" style="margin-top:8px">Als Marktwert zählt der Preistrend${p.holo && p.normal ? ' (für Exemplare mit Variante Holo, Reverse oder Ball der Holo-Wert)' : ''}.${p.updated ? ' Preisstand ' + dateDe(p.updated) + '.' : ''} Quelle: Cardmarket über TCGdex.</p>${manual}
  </div>`;
}

const NUM_FIELDS = ['year', 'uvp', 'marketValue', 'setTotal', 'hp'];

function renderItem(id) {
  const s = data.get(id);
  if (!s) { app.innerHTML = '<div class="empty">Eintrag nicht gefunden. <a href="#/">Zur Übersicht</a></div>'; return; }
  const card = isCard(s);
  const img = itemImage(s);
  const r = s.research;
  app.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a href="#/" class="btn small">← Übersicht</a><span class="spacer"></span>
      <button class="btn small danger" id="delItem">Löschen</button></div>
    <div class="detail-head ${card ? 'is-card' : ''}">
      ${img ? `<img class="hero" src="${esc(img)}" alt="" onerror="this.style.visibility='hidden'">` : `<div class="hero thumb" style="font-size:48px">${card ? '🃏' : '📦'}</div>`}
      <div>
        <h1>${esc(title(s))}</h1>
        <div class="muted">${(card ? [s.setName, numberLabel(s), s.rarity, s.language] : [s.productType, s.setName, s.language]).filter(Boolean).map(esc).join(' · ')}</div>
        <div class="badges" style="margin-top:8px">
          ${s.releaseDate ? `<span class="badge">erschienen ${dateDe(s.releaseDate)}</span>` : s.year ? `<span class="badge">erschienen ${s.year}</span>` : '<span class="badge warn">Erscheinungsjahr fehlt</span>'}
          ${s.marketValue ? `<span class="badge ok">Marktwert ${eur(s.marketValue)}${s.marketManual ? ' (selbst eingetragen)' : s.marketValueHolo ? ' · Holo/Reverse ' + eur(s.marketValueHolo) : ''}</span>` : ''}
          ${card && s.cmPrices?.warning && !s.marketManual ? '<span class="badge warn">Marktwert prüfen</span>' : ''}
          ${!card ? (s.uvp ? `<span class="badge">UVP ${eur(s.uvp)}</span>` : '<span class="badge warn">UVP fehlt</span>') : ''}
          ${s.wishlist ? '<span class="badge warn">Wunschliste</span>' : ''}
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn small" id="doResearch">🔎 ${card ? 'Daten & Marktwert aktualisieren' : 'Daten recherchieren'}</button>
          <a class="btn small" href="${research.cardmarketUrl(s)}" target="_blank" rel="noopener">Cardmarket ↗</a>
          ${!card ? `<a class="btn small" href="https://www.google.de/search?q=${encodeURIComponent('UVP ' + title(s) + ' ' + (s.setName || '') + ' Pokémon ' + (s.language || ''))}" target="_blank" rel="noopener">UVP suchen ↗</a>` : ''}
        </div>
        ${r ? `<p class="muted small">Letzte Recherche: ${new Date(r.at).toLocaleString('de-DE')} (${esc(r.source)})${r.message ? ' – ' + esc(r.message) : ''}${s.marketUpdated ? ' · Preisstand ' + dateDe(s.marketUpdated) : ''}</p>` : ''}
      </div>
    </div>

    ${card ? cardmarketBox(s) : ''}
    <h2>${card ? 'Kartendaten' : 'Produktdaten'}</h2>
    <div class="card"><div class="grid">
      ${field('Name', 'name', s.name)}
      ${field('Pokémon', 'pokemon', s.pokemon, 'text', 'list="pkList" placeholder="z. B. Glurak"')}
      ${card ? `
        ${field('Set / Erweiterung', 'setName', s.setName, 'text', 'list="setList"')}
        ${field('Kartennummer', 'number', s.number)}
        ${field('Karten im Set', 'setTotal', s.setTotal, 'number', 'inputmode="numeric"')}
        ${field('Seltenheit', 'rarity', s.rarity)}
        ${field('Kategorie', 'category', s.category)}
        ${field('Typ', 'types', s.types)}
        ${field('KP', 'hp', s.hp, 'number', 'inputmode="numeric"')}
        ${field('Illustrator', 'illustrator', s.illustrator)}`
      : `
        ${select('Produktart', 'productType', PRODUCT_TYPES, s.productType)}
        ${field('Set / Erweiterung', 'setName', s.setName, 'text', 'list="setList"')}
        ${field('UVP Deutschland (€)', 'uvp', s.uvp, 'number', 'step="0.01" inputmode="decimal"')}
        ${field('EAN / Barcode', 'ean', s.ean, 'text', 'inputmode="numeric"')}`}
      ${select('Sprache', 'language', Object.keys(research.LANGS), s.language)}
      ${field('Serie', 'serie', s.serie)}
      ${field('Erscheinungsdatum', 'releaseDate', s.releaseDate, 'date')}
      ${field('Erscheinungsjahr', 'year', s.year, 'number', 'inputmode="numeric"')}
      ${field('Marktwert aktuell (€)', 'marketValue', s.marketValue, 'number', 'step="0.01" inputmode="decimal"')}
      <label class="check"><input type="checkbox" data-f="wishlist" ${s.wishlist ? 'checked' : ''}> Wunschliste</label>
    </div>
    ${!card ? `<div style="margin-top:12px"><p class="small">${s.cmId ? `Cardmarket-Produkt${s.cmAuto ? ' (automatisch gefunden)' : ''}: <b>${esc(s.cmName)}</b> <button class="btn small" id="cmChange">falsch? ändern</button>` : '⚠️ Kein passendes Cardmarket-Produkt gefunden. <button class="btn small" id="cmChange">selbst auswählen</button>'}</p><div id="cmBox"></div></div>` : ''}
    <label class="field" style="margin-top:12px"><span>Notizen</span><textarea data-f="notes">${esc(s.notes)}</textarea></label>
    <datalist id="setList"></datalist>
    <datalist id="pkList">${[...new Set(data.all().map((x) => x.pokemon).filter(Boolean))].sort().map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    </div>

    <h2>Exemplare & Käufe (${s.copies.length})</h2>
    ${s.copies.map((c, i) => copyCard(s, c, i)).join('') || '<p class="muted">Noch kein Exemplar erfasst.</p>'}
    <div class="row" style="margin-top:12px"><button class="btn" id="addCopy">＋ Exemplar / Kauf hinzufügen</button></div>
    ${s.copies.length ? `<p class="muted small">Summe Einkauf: ${eur(s.copies.reduce((a, c) => a + (c.price || 0), 0))}
      · Durchschnitt: ${eur(s.copies.filter((c) => c.price).reduce((a, c, _, arr) => a + c.price / arr.length, 0) || null)}</p>` : ''}

    <h2>Eigene Fotos (${s.photos.length})</h2>
    <p class="muted small">Ergänzend zum automatisch gefundenen Bild, beliebig viele, auch je Exemplar (z. B. Vorder- und Rückseite, Beschädigungen).</p>
    <div class="row" style="margin-bottom:10px">
      <label class="btn">📷 Foto aufnehmen<input type="file" accept="image/*" capture="environment" id="camInput" hidden></label>
      <label class="btn">🖼️ Aus Mediathek<input type="file" accept="image/*" multiple id="libInput" hidden></label>
    </div>
    <div class="photos">${s.photos.map((p) => {
      const ci = s.copies.findIndex((c) => c.id === p.copyId);
      return `<div class="photo" data-photo="${p.id}"><img src="${p.thumb}" alt="">${ci >= 0 ? `<span class="tag">Exemplar ${ci + 1}</span>` : ''}</div>`;
    }).join('')}</div>
  `;
  research.allSets().then((sets) => { const dl = $('#setList'); if (dl) dl.innerHTML = allSetNames(sets).map((n) => `<option value="${esc(n)}">`).join(''); });

  $$('[data-f]').forEach((el) => {
    el.addEventListener('change', async () => {
      const f = el.dataset.f;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (NUM_FIELDS.includes(f)) v = numOrNull(v);
      if (typeof v === 'string') v = v.trim();
      const idChanged = card && ['setName', 'number', 'language'].includes(f) && v !== s[f];
      s[f] = v;
      if (f === 'releaseDate' && v) s.year = Number(v.slice(0, 4));
      if (f === 'marketValue') s.marketManual = v != null; // eigener Wert wird bei Aktualisierungen nicht überschrieben
      if (idChanged && f !== 'language') { s.tcgdexId = ''; s.setId = f === 'setName' ? '' : s.setId; }
      await data.save(s);
      if (idChanged && s.number && (s.setName || s.setId)) { autoResearch(id, f !== 'language'); return; }
      if (!card && ['setName', 'productType', 'name'].includes(f) && (s.cmAuto || !s.cmId)) {
        s.cmId = null; s.cmName = ''; await data.save(s); autoResearch(id, f === 'setName'); return;
      }
      if (['name', 'pokemon', 'setName', 'number', 'language', 'wishlist', 'uvp', 'year', 'releaseDate', 'marketValue', 'productType', 'rarity'].includes(f)) renderItem(id);
    });
  });
  $$('[data-c]').forEach((el) => {
    el.addEventListener('change', async () => {
      const c = s.copies.find((x) => x.id === el.dataset.c);
      const f = el.dataset.cf;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (['price', 'soldPrice'].includes(f)) v = numOrNull(v);
      c[f] = v;
      if (f === 'graded' && v && !c.state) c.state = 'Slab (gegradet)';
      await data.save(s);
      if (['graded', 'soldDate', 'soldPrice'].includes(f)) renderItem(id);
    });
  });
  $$('.cond button').forEach((b) => {
    b.onclick = async () => {
      const c = s.copies.find((x) => x.id === b.dataset.copy);
      const v = Number(b.dataset.v);
      c.condition = c.condition === v ? null : v;
      await data.save(s);
      renderItem(id);
    };
  });
  $$('[data-delcopy]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Dieses Exemplar wirklich löschen?')) return;
      s.copies = s.copies.filter((c) => c.id !== b.dataset.delcopy);
      s.photos.forEach((p) => { if (p.copyId === b.dataset.delcopy) p.copyId = null; });
      await data.save(s);
      renderItem(id);
    };
  });
  $('#addCopy').onclick = async () => {
    s.copies.push(newCopy({ purchaseDate: today(), state: card ? '' : 'versiegelt' }));
    s.wishlist = false;
    await data.save(s);
    renderItem(id);
  };
  $('#delItem').onclick = async () => {
    if (!confirm(`„${title(s)}“ mit allen Exemplaren und Fotos löschen?`)) return;
    await data.remove(s.id);
    location.hash = '#/';
  };
  if ($('#cmChange')) $('#cmChange').onclick = () => {
    cmPicker($('#cmBox'), [s.setName, (s.productType || '').replace(/\s*\(.*\)/, '')].filter(Boolean).join(' '), async (h) => {
      s.cmId = h.id; s.cmName = h.name; s.cmAuto = false;
      await data.save(s);
      autoResearch(id);
    });
  };
  $('#doResearch').onclick = () => autoResearch(id, s.research?.status === 'ok' && confirm('Vorhandene Angaben mit den recherchierten Werten überschreiben? (Abbrechen = nur Lücken füllen und Marktwert aktualisieren)'));
  $('#camInput').onchange = (e) => handlePhotos(s, e.target.files);
  $('#libInput').onchange = (e) => handlePhotos(s, e.target.files);
  $$('[data-photo]').forEach((el) => (el.onclick = () => showPhoto(s, el.dataset.photo)));
}

function copyCard(s, c, i) {
  const card = isCard(s);
  const cf = (name) => `data-c="${c.id}" data-cf="${name}"`;
  const sel = (label, name, list) => select(label, name, list, c[name], `data-c="${c.id}" data-cf`);
  const condText = card ? COND_CARD : COND_PACK;
  return `<div class="card copy">
    <div class="copy-head"><h3>Exemplar ${i + 1}</h3>
      ${c.graded || c.grader ? `<span class="badge ok">${esc((c.grader || 'gegradet').split(' ')[0])} ${esc(c.grade)}</span>` : ''}
      ${c.soldDate || c.soldPrice !== null ? '<span class="badge">verkauft</span>' : ''}
      <span class="spacer"></span><button class="btn small danger" data-delcopy="${c.id}">Löschen</button></div>
    <div class="grid">
      <label class="field"><span>Kaufdatum</span><input type="date" ${cf('purchaseDate')} value="${esc(c.purchaseDate)}"></label>
      <label class="field"><span>Einkaufspreis (€)</span><input type="number" step="0.01" inputmode="decimal" ${cf('price')} value="${esc(c.price ?? '')}"></label>
      <label class="field"><span>Händler / Quelle</span><input ${cf('shop')} value="${esc(c.shop)}" placeholder="z. B. Cardmarket, Laden, Tausch"></label>
      ${card ? `${sel('Variante', 'variant', VARIANTS)}${sel('Edition', 'edition', EDITIONS)}${sel('Zustand (Cardmarket)', 'grading', CM_GRADES)}${sel('Aufbewahrung', 'state', SLEEVES)}`
        : sel('Zustand der Verpackung', 'state', PRODUCT_STATES)}
      <label class="field"><span>Lagerort</span><input ${cf('location')} value="${esc(c.location)}" placeholder="${card ? 'z. B. Ordner 2, Seite 14' : 'z. B. Regal 3'}"></label>
    </div>
    ${card ? `<div class="grid" style="margin-top:12px">
      <label class="check"><input type="checkbox" ${cf('graded')} ${c.graded ? 'checked' : ''}> Gegradet</label>
      ${c.graded ? `${sel('Gegradet von', 'grader', GRADERS)}<label class="field"><span>Note</span><input ${cf('grade')} value="${esc(c.grade)}" inputmode="decimal" placeholder="z. B. 10 oder 9.5"></label>
      <label class="field"><span>Zertifikatsnummer</span><input ${cf('certNumber')} value="${esc(c.certNumber)}" inputmode="numeric"></label>` : ''}
    </div>` : ''}
    <div style="margin-top:12px">
      <span class="muted small">${card ? 'Zustand der Karte' : 'Zustand der Packung'} (10 = sehr gut)</span>
      <div class="cond">${Array.from({ length: 10 }, (_, k) => k + 1).map((v) => `<button data-copy="${c.id}" data-v="${v}" class="${c.condition === v ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="cond-label">${c.condition ? c.condition + ' – ' + condText[c.condition] : 'nicht bewertet'}</div>
    </div>
    <label class="field" style="margin-top:12px"><span>Beschädigungen</span>
      <textarea ${cf('damage')} placeholder="${card ? 'z. B. Kante oben weißlich; Kratzer auf der Holo-Fläche; Ecke unten links leicht geknickt' : 'z. B. Ecke vorne rechts oben gestaucht; Folie an der Rückseite eingerissen'}">${esc(c.damage)}</textarea></label>
    <details style="margin-top:8px"><summary>Verkauf & Notizen</summary>
      <div class="grid" style="margin-top:10px">
        <label class="field"><span>Verkauft am</span><input type="date" ${cf('soldDate')} value="${esc(c.soldDate)}"></label>
        <label class="field"><span>Verkaufspreis (€)</span><input type="number" step="0.01" inputmode="decimal" ${cf('soldPrice')} value="${esc(c.soldPrice ?? '')}"></label>
      </div>
      <label class="field" style="margin-top:10px"><span>Notizen zum Exemplar</span><textarea ${cf('notes')}>${esc(c.notes)}</textarea></label>
    </details>
  </div>`;
}

// ---------- Fotos ----------
function modal(html) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-box">${html}</div>`;
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
  return m;
}

async function handlePhotos(item, files) {
  for (const file of [...files]) await processPhoto(item, file);
}

function processPhoto(item, file) {
  return new Promise(async (resolve) => {
    const m = modal('<p>Foto wird verbessert …</p>');
    let orig, enhanced;
    try {
      const img = await photo.loadImage(file);
      orig = photo.toCanvas(img);
      await new Promise((r) => setTimeout(r, 30));
      enhanced = photo.enhance(orig, { glare: 0.8 });
    } catch (e) {
      m.remove();
      toast('Foto konnte nicht verarbeitet werden: ' + e.message, 5000);
      return resolve();
    }
    let useEnhanced = true;
    const origUrl = orig.toDataURL('image/jpeg', 0.85);
    let enhUrl = enhanced.toDataURL('image/jpeg', 0.85);
    const levels = { 0: null, 0.8: enhanced, 1: null };
    const box = m.querySelector('.modal-box');
    box.innerHTML = `
      <h3>Foto hinzufügen</h3>
      <div class="row" style="margin-bottom:10px">
        <div class="seg" id="verSeg"><button data-v="1" class="on">Verbessert</button><button data-v="0">Original</button></div>
        <span class="muted small">Helligkeit, Kontrast und Spiegelungen (z. B. von Hülle oder Folie) angepasst; Knicke und Schäden bleiben sichtbar.</span>
      </div>
      <img class="preview" src="${enhUrl}" alt="Vorschau">
      <div class="row" style="margin-top:8px"><span class="small muted">Spiegelungen reduzieren:</span>
        <div class="seg" id="glareSeg"><button data-g="0">aus</button><button data-g="0.8" class="on">normal</button><button data-g="1">stark</button></div></div>
      <label class="field" style="margin-top:12px"><span>Gehört zu</span><select id="pCopy">
        <option value="">${isCard(item) ? 'Karte' : 'Produkt'} allgemein</option>
        ${item.copies.map((c, i) => `<option value="${c.id}" ${item.copies.length === 1 ? 'selected' : ''}>Exemplar ${i + 1}${c.purchaseDate ? ' (gekauft ' + dateDe(c.purchaseDate) + ')' : ''}</option>`).join('')}
      </select></label>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="pSave">Speichern</button><button class="btn" id="pCancel">Verwerfen</button></div>`;
    const prev = box.querySelector('.preview');
    box.querySelectorAll('#verSeg button').forEach((b) => (b.onclick = () => {
      useEnhanced = b.dataset.v === '1';
      box.querySelectorAll('#verSeg button').forEach((x) => x.classList.toggle('on', x === b));
      prev.src = useEnhanced ? enhUrl : origUrl;
    }));
    box.querySelectorAll('#glareSeg button').forEach((b) => (b.onclick = async () => {
      const g = Number(b.dataset.g);
      box.querySelectorAll('#glareSeg button').forEach((x) => x.classList.toggle('on', x === b));
      if (!levels[g]) { await new Promise((r) => setTimeout(r, 20)); levels[g] = photo.enhance(orig, { glare: g }); }
      enhanced = levels[g];
      enhUrl = enhanced.toDataURL('image/jpeg', 0.85);
      if (useEnhanced) prev.src = enhUrl;
    }));
    box.querySelector('#pCancel').onclick = () => { m.remove(); resolve(); };
    box.querySelector('#pSave').onclick = async () => {
      const cv = useEnhanced ? enhanced : orig;
      const id = uid();
      const blob = await photo.canvasToBlob(cv);
      await data.addPhotoBlob(id, blob);
      const fresh = data.get(item.id);
      fresh.photos.push({ id, copyId: box.querySelector('#pCopy').value || null, thumb: photo.thumbnail(cv), enhanced: useEnhanced, createdAt: now() });
      await data.save(fresh);
      m.remove();
      renderItem(item.id);
      resolve();
    };
  });
}

async function showPhoto(item, photoId) {
  const p = item.photos.find((x) => x.id === photoId);
  const m = modal(`<img class="preview" src="${p.thumb}" alt="">
    <p class="muted small" id="pInfo">Lade Foto in voller Größe …</p>
    <label class="field"><span>Gehört zu</span><select id="pCopy"><option value="">allgemein</option>
      ${item.copies.map((c, i) => `<option value="${c.id}" ${p.copyId === c.id ? 'selected' : ''}>Exemplar ${i + 1}</option>`).join('')}</select></label>
    <div class="row" style="margin-top:12px"><button class="btn" id="pFirst">${item.titlePhoto === p.id ? 'Nicht mehr als Titelbild' : 'Als Titelbild'}</button><a class="btn" id="pDl" download="pokemon-${esc(item.id)}.jpg">Herunterladen</a>
      <span class="spacer"></span><button class="btn danger" id="pDel">Löschen</button><button class="btn" id="pClose">Schließen</button></div>`);
  try {
    const blob = await data.getPhotoBlob(photoId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      m.querySelector('.preview').src = url;
      m.querySelector('#pDl').href = url;
      m.querySelector('#pInfo').textContent = p.enhanced ? 'Verbesserte Version' : 'Originalfoto';
    } else m.querySelector('#pInfo').textContent = 'Foto in voller Größe noch nicht verfügbar (Dropbox nicht verbunden?).';
  } catch (e) { m.querySelector('#pInfo').textContent = 'Fehler: ' + e.message; }
  m.querySelector('#pClose').onclick = () => m.remove();
  m.querySelector('#pCopy').onchange = async (e) => { p.copyId = e.target.value || null; await data.save(item); renderItem(item.id); };
  m.querySelector('#pFirst').onclick = async () => { item.titlePhoto = item.titlePhoto === p.id ? null : p.id; await data.save(item); m.remove(); renderItem(item.id); };
  m.querySelector('#pDel').onclick = async () => {
    if (!confirm('Foto löschen?')) return;
    item.photos = item.photos.filter((x) => x.id !== photoId);
    await data.save(item);
    data.deletePhotoFile(photoId);
    m.remove();
    renderItem(item.id);
  };
}

// ---------- Einstellungen ----------
async function runResearch(list, prog, label) {
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    prog.textContent = `${label} ${i + 1} von ${list.length}: ${title(list[i])} …`;
    const s = data.get(list[i].id);
    if (!s) continue;
    await research.enrich(s);
    await data.save(s);
    if (s.research.status === 'ok') ok++;
    await new Promise((r) => setTimeout(r, 250));
  }
  prog.textContent = `Fertig: ${ok} von ${list.length} vollständig.`;
}

async function renderSettings() {
  const connected = await dbx.isConnected();
  const appKey = (await kv.get('dropboxAppKey')) || DROPBOX_APP_KEY;
  const missing = data.all().filter((s) => s.research?.status !== 'ok');
  const cards = data.all().filter((s) => isCard(s) && s.tcgdexId);
  const sets = await research.allSets();
  app.innerHTML = `
    <div class="row" style="margin-bottom:8px"><a href="#/" class="btn small">← Übersicht</a></div>
    <h1>Einstellungen</h1>

    <h2>Dropbox (Speicher & Abgleich zwischen Geräten)</h2>
    <div class="card">
      ${connected ? `<p>✅ Mit Dropbox verbunden. Daten liegen im App-Ordner im Unterordner <b>pokemon</b>.</p>
        <p class="muted small">Letzter Abgleich: ${data.state.lastSync ? new Date(data.state.lastSync).toLocaleString('de-DE') : '–'}</p>
        <div class="row"><button class="btn" id="syncNow">Jetzt abgleichen</button><button class="btn danger" id="dbxOff">Trennen</button></div>`
      : `<p>Ohne Dropbox werden die Daten nur auf diesem Gerät gespeichert.</p>
        <label class="field"><span>Dropbox App-Key </span><input id="appKey" value="${esc(appKey)}" placeholder="z. B. abc123xyz"></label>
        <div class="row" style="margin-top:10px"><button class="btn primary" id="dbxOn">Mit Dropbox verbinden</button></div>
        <div id="dbxCodeBox" hidden style="margin-top:12px">
          <p class="small"><b>So geht's:</b> Im neuen Fenster bei Dropbox auf „Zulassen“ tippen. Dropbox zeigt dann einen Code an. Diesen Code kopieren, hierher zurückkehren und unten einfügen.</p>
          <label class="field"><span>Code von Dropbox</span><input id="dbxCode" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="dbxCodeOk">Verbindung abschließen</button></div>
        </div>`}
    </div>

    <h2>Online-Recherche</h2>
    <div class="card">
      <p class="small">Karten, Sets, Erscheinungsdaten, Seltenheit, Bilder und Cardmarket-Marktwerte kommen aus der freien Datenbank <a href="https://tcgdex.dev" target="_blank" rel="noopener">TCGdex</a>. Kartenkatalog: ${sets.length ? sets.length + ' Sets geladen' : '⚠️ noch nicht erstellt'}.</p>
      <div class="row"><button class="btn" id="resMissing" ${missing.length ? '' : 'disabled'}>Fehlende Daten recherchieren (${missing.length})</button>
        <button class="btn" id="resPrices" ${cards.length ? '' : 'disabled'}>Marktwerte aller Karten aktualisieren (${cards.length})</button></div>
      <p class="muted small">Automatisch: beim Anlegen sofort und danach jeden Montag ab 00:01 Uhr (deutsche Zeit), sobald die App geöffnet ist. Letzte wöchentliche Aktualisierung: ${esc(data.getSettings().weeklyUpdate || '–')}</p>
      <p class="small" id="resProgress"></p>
    </div>

    <h2>Excel-Import</h2>
    <div class="card">
      <p>Excel-Liste (.xlsx, .xls oder .csv) auswählen. Gleiche Karten bzw. Produkte in mehreren Zeilen werden als mehrere Exemplare übernommen. Danach werden die fehlenden Daten automatisch recherchiert.</p>
      <label class="btn">📄 Datei wählen<input type="file" id="xlsIn" accept=".xlsx,.xls,.xlsm,.csv" hidden></label>
      <div id="importArea"></div>
    </div>

    <h2>Export & Sicherung</h2>
    <div class="card row">
      <button class="btn" id="expXlsx">Als Excel exportieren</button>
      <button class="btn" id="expJson">Sicherung (JSON) herunterladen</button>
      <label class="btn">Sicherung einspielen<input type="file" id="impJson" accept=".json" hidden></label>
    </div>

    <h2>App installieren</h2>
    <div class="card small">
      <p><b>iPhone / iPad:</b> In Safari auf „Teilen“ tippen, dann „Zum Home-Bildschirm“.</p>
      <p><b>Computer:</b> In Chrome oder Edge auf das Installations-Symbol in der Adressleiste klicken, oder die Seite als Lesezeichen speichern.</p>
    </div>
    <p class="muted small">Pokémon und alle zugehörigen Namen sind Marken von Nintendo, Creatures und GAME FREAK. Diese App ist ein privates Sammlerwerkzeug und steht in keiner Verbindung zu den Rechteinhabern.</p>`;

  if (connected) {
    $('#syncNow').onclick = () => data.sync();
    $('#dbxOff').onclick = async () => { if (confirm('Verbindung zu Dropbox auf diesem Gerät trennen? Die Daten in der Dropbox bleiben erhalten.')) { await dbx.disconnect(); renderSettings(); updateSyncUi(); } };
  } else {
    if (await kv.get('dbx_code_pkce')) $('#dbxCodeBox').hidden = false;
    $('#dbxOn').onclick = async () => {
      const k = $('#appKey').value.trim();
      if (!k) return toast('Bitte zuerst den Dropbox App-Key eintragen.');
      await kv.set('dropboxAppKey', k);
      const win = window.open('about:blank', '_blank');
      const url = await dbx.startCodeLogin(k);
      if (win) win.location.href = url; else location.href = url;
      $('#dbxCodeBox').hidden = false;
      $('#dbxCode').focus();
    };
    $('#dbxCodeOk').onclick = async () => {
      const code = $('#dbxCode').value.trim();
      if (!code) return toast('Bitte den Code von Dropbox einfügen.');
      try {
        await dbx.finishCodeLogin(code);
        toast('Mit Dropbox verbunden.');
        await renderSettings();
        updateSyncUi();
        data.sync();
      } catch (e) { toast(e.message, 5000); }
    };
  }
  $('#resMissing').onclick = () => runResearch(missing, $('#resProgress'), 'Recherche');
  $('#resPrices').onclick = () => runResearch(cards, $('#resProgress'), 'Marktwert');
  $('#xlsIn').onchange = (e) => startImport(e.target.files[0]);
  $('#expXlsx').onclick = () => importer.exportExcel(sortItems(data.all(), 'set'));
  $('#expJson').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data.exportJson()], { type: 'application/json' }));
    a.download = `pokemon-sammlung-${today()}.json`;
    a.click();
  };
  $('#impJson').onchange = async (e) => {
    try {
      const obj = JSON.parse(await e.target.files[0].text());
      if (!obj.sets) throw new Error('Keine gültige Sicherung.');
      await data.replaceAll(obj);
      toast('Sicherung eingespielt.');
    } catch (err) { toast('Fehler: ' + err.message, 5000); }
  };
}

async function startImport(file) {
  if (!file) return;
  const area = $('#importArea');
  area.innerHTML = '<p>Datei wird gelesen …</p>';
  let wb;
  try { wb = await importer.readWorkbook(file); } catch (e) { area.innerHTML = `<p>Datei konnte nicht gelesen werden: ${esc(e.message)}</p>`; return; }
  const sheetSel = wb.SheetNames.length > 1;
  const draw = (sheet) => {
    const { headers, rows } = importer.sheetRows(wb, sheet);
    const map = importer.guessMapping(headers);
    area.innerHTML = `
      ${sheetSel ? `<label class="field" style="margin-top:12px"><span>Tabellenblatt</span><select id="sheet">${wb.SheetNames.map((n) => `<option ${n === sheet ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
      <p><b>${rows.length} Zeilen</b> gefunden. Bitte prüfen, welche Spalte wohin gehört:</p>
      <label class="field"><span>Zeilen ohne eindeutige Art sind …</span><select id="defKind"><option value="karte">Karten</option><option value="produkt">versiegelte Produkte</option></select></label>
      <table class="map">${importer.FIELDS.map(([k, label]) => `<tr><td>${label}</td><td><select data-map="${k}">
        <option value="">– nicht übernehmen –</option>${headers.map((h, i) => `<option value="${i}" ${map[k] === i ? 'selected' : ''}>${esc(h || 'Spalte ' + (i + 1))}</option>`).join('')}
      </select></td></tr>`).join('')}</table>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="doImport">Importieren</button></div>`;
    if (sheetSel) $('#sheet').onchange = (e) => draw(e.target.value);
    $('#doImport').onclick = async () => {
      const m = {};
      $$('[data-map]').forEach((s) => { if (s.value !== '') m[s.dataset.map] = Number(s.value); });
      if (m.name === undefined && m.number === undefined) return toast('Bitte mindestens Name oder Kartennummer zuordnen.');
      const items = importer.buildItems(rows, m, data.all(), $('#defKind').value);
      await data.saveMany(items);
      area.innerHTML = `<p>✅ ${items.length} Einträge importiert bzw. ergänzt. Fehlende Daten werden jetzt recherchiert …</p><p class="small" id="impProgress"></p>`;
      await runResearch(items.filter((s) => s.research?.status !== 'ok'), $('#impProgress'), 'Recherche');
      toast('Import abgeschlossen.');
    };
  };
  draw(wb.SheetNames[0]);
}

// ---------- Wöchentliche Aktualisierung (Montag 00:01 Uhr deutsche Zeit) ----------
// Beim ersten Öffnen der App nach Montag 00:01 Uhr (Europe/Berlin) werden die Marktwerte aller Karten
// und die Daten unvollständiger Einträge neu recherchiert. Der Zeitpunkt wird über Dropbox geteilt,
// damit nur ein Gerät die Aktualisierung macht.
function berlinNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).replace('T', ' ').slice(0, 16); // "JJJJ-MM-TT HH:MM"
}
function lastMondayBerlin() {
  const now = berlinNow();
  const d = new Date(now.slice(0, 10) + 'T12:00:00Z');
  const back = (d.getUTCDay() + 6) % 7; // Tage seit Montag
  d.setUTCDate(d.getUTCDate() - back);
  let monday = d.toISOString().slice(0, 10) + ' 00:01';
  if (monday > now) { d.setUTCDate(d.getUTCDate() - 7); monday = d.toISOString().slice(0, 10) + ' 00:01'; }
  return monday;
}
let weeklyRunning = false;
async function weeklyUpdate(force = false) {
  if (weeklyRunning || !navigator.onLine) return;
  const due = lastMondayBerlin();
  const last = data.getSettings().weeklyUpdate || '';
  if (!force && last >= due) return;
  research.resetProducts();
  const todo = data.all().filter((s) => (isCard(s) && (s.tcgdexId || (s.setName && s.number))) || s.cmId || s.research?.status !== 'ok');
  weeklyRunning = true;
  await data.saveSettings({ weeklyUpdate: berlinNow() });
  const bar = $('#weeklyBar');
  let failed = 0;
  for (let i = 0; i < todo.length; i++) {
    bar.hidden = false;
    bar.textContent = `Wöchentliche Aktualisierung der Marktwerte (Karten und Produkte): ${i + 1} von ${todo.length} …`;
    const s = data.get(todo[i].id);
    if (!s) continue;
    try { await research.enrich(s); await data.save(s); } catch { failed++; }
    if (/nicht erreichbar/.test(s.research?.message || '')) failed++;
    await new Promise((r) => setTimeout(r, 300));
  }
  bar.hidden = true;
  weeklyRunning = false;
  if (todo.length) toast(failed ? `Aktualisierung fertig, ${failed} Einträge konnten nicht abgerufen werden.` : 'Marktwerte aktualisiert.', 4000);
}

// ---------- Sync-Anzeige & Routing ----------
async function updateSyncUi() {
  const bar = $('#syncBar');
  const btn = $('#syncBtn');
  const connected = await dbx.isConnected();
  btn.classList.toggle('spin', data.state.status === 'syncing');
  if (!connected) {
    bar.hidden = false;
    bar.innerHTML = 'Daten werden nur auf diesem Gerät gespeichert. <a href="#/einstellungen">Dropbox verbinden</a>';
  } else if (data.state.status === 'error' || data.state.status === 'waiting') {
    bar.hidden = false;
    bar.textContent = data.state.message;
  } else bar.hidden = true;
}

function route() {
  const h = location.hash || '#/';
  window.scrollTo(0, 0);
  if (h.startsWith('#/item/')) renderItem(h.slice(7));
  else if (h === '#/neu') renderNew();
  else if (h === '#/einstellungen') renderSettings();
  else renderList();
}

let rerenderTimer;
data.onChange(() => {
  updateSyncUi();
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    const h = location.hash || '#/';
    if ((h === '#/' || h === '') && document.activeElement?.id !== 'q') renderList();
  }, 200);
});

async function init() {
  await data.load();
  try {
    if (await dbx.finishLoginIfNeeded()) toast('Mit Dropbox verbunden.');
  } catch (e) { toast(e.message, 5000); }
  window.addEventListener('hashchange', route);
  $('#syncBtn').onclick = async () => {
    if (!(await dbx.isConnected())) { location.hash = '#/einstellungen'; return; }
    await data.sync();
    if (data.state.status === 'ok') toast('Abgeglichen.');
  };
  route();
  updateSyncUi();
  await data.sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  weeklyUpdate();
  setInterval(() => weeklyUpdate(), 15 * 60 * 1000); // App bleibt offen: jede Viertelstunde prüfen
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(() => weeklyUpdate(), 3000); });
}
init();
