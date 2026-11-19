// Zentrale Datenverwaltung: Sammlung im Speicher, lokal gesichert, mit Dropbox synchronisiert.
import { kv, photoStore, emptyCollection, merge, sameContent, now } from './store.js';
import * as dbx from './dropbox.js';

const DB_PATH = '/pokemon/sammlung.json';
const photoPath = (id) => `/pokemon/fotos/${id}.jpg`;

let collection = emptyCollection();
let listeners = [];
let syncTimer = null;
let syncing = false;
let syncAgain = false;

export const state = { status: 'offline', message: '', lastSync: null };

export function onChange(fn) { listeners.push(fn); }
function emit() { listeners.forEach((fn) => fn()); }

export async function load() {
  collection = (await kv.get('collection')) || emptyCollection();
  state.lastSync = await kv.get('lastSync');
}

export function all() { return Object.values(collection.sets); }
export function get(id) { return collection.sets[id]; }

export async function save(set) {
  set.updatedAt = now();
  collection.sets[set.id] = set;
  collection.updatedAt = set.updatedAt;
  await kv.set('collection', collection);
  emit();
  scheduleSync();
}

export async function saveMany(sets) {
  const ts = now();
  for (const s of sets) { s.updatedAt = ts; collection.sets[s.id] = s; }
  collection.updatedAt = ts;
  await kv.set('collection', collection);
  emit();
  scheduleSync(500);
}

export async function remove(id) {
  const set = collection.sets[id];
  delete collection.sets[id];
  collection.deleted[id] = now();
  collection.updatedAt = now();
  await kv.set('collection', collection);
  emit();
  scheduleSync();
  if (set) for (const p of set.photos) deletePhotoFile(p.id);
}

// Einstellungen, die über Dropbox auf alle Geräte übertragen werden (z. B. Sprache der Recherche)
export function getSettings() { return collection.settings || {}; }
export async function saveSettings(values) {
  collection.settings = { ...(collection.settings || {}), ...values, updatedAt: now() };
  collection.updatedAt = now();
  await kv.set('collection', collection);
  emit();
  scheduleSync(500);
}

// Set-Checklisten: von Hand als vorhanden markierte Karten je Set ({ marks: { kartenId: true }, updatedAt })
export function getChecklist(setId) { return collection.checklists?.[setId]?.marks || {}; }
export function allChecklists() { return collection.checklists || {}; }
export async function toggleChecklistMark(setId, cardId) {
  const marks = { ...getChecklist(setId) };
  if (marks[cardId]) delete marks[cardId]; else marks[cardId] = true;
  collection.checklists = { ...(collection.checklists || {}), [setId]: { marks, updatedAt: now() } };
  collection.updatedAt = now();
  await kv.set('collection', collection);
  emit();
  scheduleSync(800);
}

export function exportJson() { return JSON.stringify(collection, null, 2); }

export async function replaceAll(data) {
  collection = merge(collection, data);
  await kv.set('collection', collection);
  emit();
  scheduleSync(500);
}

// ---------- Fotos ----------
export async function addPhotoBlob(id, blob) {
  await photoStore.set(id, blob);
  const pending = (await kv.get('photoOutbox')) || [];
  pending.push(id);
  await kv.set('photoOutbox', pending);
  scheduleSync(500);
}

export async function getPhotoBlob(id) {
  let blob = await photoStore.get(id);
  if (blob) return blob;
  if (!(await dbx.isConnected())) return null;
  const r = await dbx.download(photoPath(id));
  if (!r) return null;
  await photoStore.set(id, r.blob);
  return r.blob;
}

export async function deletePhotoFile(id) {
  await photoStore.del(id);
  const pending = ((await kv.get('photoOutbox')) || []).filter((x) => x !== id);
  await kv.set('photoOutbox', pending);
  const del = (await kv.get('photoDeletes')) || [];
  del.push(id);
  await kv.set('photoDeletes', del);
  scheduleSync(500);
}

// ---------- Synchronisierung ----------
export function scheduleSync(delay = 2000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), delay);
}

function setStatus(status, message = '') {
  state.status = status;
  state.message = message;
  emit();
}

export async function sync() {
  if (syncing) { syncAgain = true; return; }
  if (!(await dbx.isConnected())) { setStatus('offline'); return; }
  if (!navigator.onLine) { setStatus('waiting', 'Keine Internetverbindung, Änderungen sind auf diesem Gerät gespeichert.'); return; }
  syncing = true;
  setStatus('syncing');
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await dbx.download(DB_PATH);
      const remoteData = remote ? JSON.parse(await remote.blob.text()) : null;
      const merged = merge(collection, remoteData);
      if (!sameContent(merged, collection)) {
        collection = merged;
        await kv.set('collection', collection);
        emit();
      }
      if (remoteData && sameContent(merged, remoteData)) break;
      try {
        await dbx.upload(DB_PATH, JSON.stringify(merged), remote ? { update: remote.rev } : 'add');
        break;
      } catch (e) {
        if (!e.conflict) throw e; // anderes Gerät war schneller: neu laden und erneut zusammenführen
      }
    }
    // ausstehende Fotos hochladen
    let pending = (await kv.get('photoOutbox')) || [];
    for (const id of [...pending]) {
      const blob = await photoStore.get(id);
      if (blob) await dbx.upload(photoPath(id), blob, 'overwrite');
      pending = pending.filter((x) => x !== id);
      await kv.set('photoOutbox', pending);
    }
    let dels = (await kv.get('photoDeletes')) || [];
    for (const id of [...dels]) {
      await dbx.remove(photoPath(id));
      dels = dels.filter((x) => x !== id);
      await kv.set('photoDeletes', dels);
    }
    state.lastSync = now();
    await kv.set('lastSync', state.lastSync);
    setStatus('ok');
  } catch (e) {
    console.error(e);
    setStatus('error', e.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(300); });
