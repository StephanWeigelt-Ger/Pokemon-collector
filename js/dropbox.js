// Dropbox-Anbindung direkt aus dem Browser (OAuth 2 mit PKCE, ohne eigenen Server).
// Die App nutzt einen eigenen "App-Ordner" in der Dropbox: /Apps/<App-Name>/pokemon/
import { kv } from './store.js';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

// Eigene Adresse der Pokémon-App
function appUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}
// Anmeldung läuft per Code (ohne Weiterleitung); die Adresse wird nur für den alten Weg gebraucht.
export function redirectUri() {
  return appUrl();
}

function b64url(bytes) {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startLogin(appKey) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = 'pk.' + b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem('dbx_pkce', JSON.stringify({ verifier, state, appKey }));
  const p = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri(),
    token_access_type: 'offline',
    state,
  });
  location.href = `${AUTH_URL}?${p}`;
}

// Nach der Rückleitung von Dropbox den Code gegen Tokens tauschen.
export async function finishLoginIfNeeded() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code && !q.get('error')) return false;
  const saved = JSON.parse(sessionStorage.getItem('dbx_pkce') || 'null');
  history.replaceState(null, '', appUrl() + location.hash);
  if (q.get('error')) throw new Error('Dropbox-Anmeldung abgebrochen.');
  if (!saved || saved.state !== q.get('state')) throw new Error('Dropbox-Anmeldung ungültig, bitte erneut verbinden.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
      client_id: saved.appKey,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error('Dropbox-Anmeldung fehlgeschlagen: ' + (await res.text()));
  const t = await res.json();
  await kv.set('dbx_auth', {
    appKey: saved.appKey,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: Date.now() + (t.expires_in - 60) * 1000,
    accountId: t.account_id,
  });
  sessionStorage.removeItem('dbx_pkce');
  return true;
}

// Anmeldung ohne Weiterleitung: Dropbox zeigt nach "Zulassen" einen Code an, der in der App
// eingefügt wird. Dafür muss in der Dropbox-App keine Weiterleitungs-Adresse hinterlegt sein.
export async function startCodeLogin(appKey) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await kv.set('dbx_code_pkce', { verifier, appKey });
  const p = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  return `${AUTH_URL}?${p}`;
}

export async function finishCodeLogin(code) {
  const saved = await kv.get('dbx_code_pkce');
  if (!saved) throw new Error('Bitte zuerst auf „Mit Dropbox verbinden“ tippen.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', code_verifier: saved.verifier, client_id: saved.appKey }),
  });
  if (!res.ok) throw new Error('Code wurde nicht angenommen. Bitte erneut verbinden und den neuen Code einfügen.');
  const t = await res.json();
  await kv.set('dbx_auth', {
    appKey: saved.appKey,
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: Date.now() + (t.expires_in - 60) * 1000,
    accountId: t.account_id,
  });
  await kv.del('dbx_code_pkce');
  return true;
}

export async function isConnected() {
  const a = await kv.get('dbx_auth');
  return !!(a && a.refreshToken);
}

export async function disconnect() {
  const a = await kv.get('dbx_auth');
  if (a?.accessToken) {
    fetch(API + '/auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + a.accessToken } }).catch(() => {});
  }
  await kv.del('dbx_auth');
}

async function token() {
  const a = await kv.get('dbx_auth');
  if (!a) throw new Error('Nicht mit Dropbox verbunden.');
  if (a.accessToken && Date.now() < a.expiresAt) return a.accessToken;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: a.appKey }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) await kv.del('dbx_auth');
    throw new Error('Dropbox-Verbindung abgelaufen, bitte in den Einstellungen neu verbinden.');
  }
  const t = await res.json();
  a.accessToken = t.access_token;
  a.expiresAt = Date.now() + (t.expires_in - 60) * 1000;
  await kv.set('dbx_auth', a);
  return a.accessToken;
}

// Dropbox verlangt, dass der JSON-Header nur ASCII enthält.
function headerArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Anfrage mit Zugangsschlüssel; lehnt Dropbox den Schlüssel ab (401), wird er einmal erneuert und neu versucht.
async function send(url, headers, body) {
  const go = async () => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), ...headers }, body });
  let res = await go();
  if (res.status === 401) {
    const txt = await res.clone().text().catch(() => '');
    if (!txt.includes('missing_scope')) {
      const a = await kv.get('dbx_auth');
      if (a && a.refreshToken) { a.expiresAt = 0; await kv.set('dbx_auth', a); res = await go(); }
    }
  }
  return res;
}

// Fehlermeldung von Dropbox verständlich machen (z. B. fehlende Berechtigung der Dropbox-App).
async function fail(res, what) {
  let txt = '';
  try { txt = await res.text(); } catch (e) { /* egal */ }
  const scope = (txt.match(/required scope '([^']+)'/) || txt.match(/"required_scope":\s*"([^"]+)"/) || [])[1];
  if (scope || txt.includes('missing_scope')) {
    await kv.del('dbx_auth');
    const e = new Error('Der Dropbox-App fehlt die Berechtigung „' + (scope || 'files.content') + '“. Bitte auf dropbox.com/developers/apps die App öffnen, unter „Permissions“ files.content.read und files.content.write anhaken, „Submit“ tippen und danach hier neu mit Dropbox verbinden.');
    e.scope = true;
    throw e;
  }
  console.warn('Dropbox', what, res.status, txt);
  if (res.status === 401) {
    await kv.del('dbx_auth');
    throw new Error('Die Dropbox-Verbindung ist nicht mehr gültig. Bitte oben auf „Dropbox verbinden“ tippen und neu verbinden.');
  }
  throw new Error('Dropbox-' + what + ' fehlgeschlagen (' + res.status + ')' + (txt ? ': ' + txt.slice(0, 160) : ''));
}

export async function download(path) {
  const res = await send(CONTENT + '/files/download', { 'Dropbox-API-Arg': headerArg({ path }) });
  if (res.status === 409) {
    const txt = await res.text();
    if (txt.includes('not_found')) return null;
    throw new Error('Dropbox: ' + txt);
  }
  if (!res.ok) await fail(res, 'Download');
  const meta = JSON.parse(res.headers.get('Dropbox-API-Result') || '{}');
  return { blob: await res.blob(), rev: meta.rev };
}

// mode: 'add' | 'overwrite' | { update: rev }
export async function upload(path, data, mode = 'overwrite') {
  const m = typeof mode === 'string' ? mode : { '.tag': 'update', update: mode.update };
  const res = await send(CONTENT + '/files/upload', {
    'Content-Type': 'application/octet-stream',
    'Dropbox-API-Arg': headerArg({ path, mode: m, autorename: false, mute: true }),
  }, data);
  if (res.status === 409) {
    const txt = await res.text();
    if (txt.includes('conflict')) {
      const e = new Error('conflict');
      e.conflict = true;
      throw e;
    }
    throw new Error('Dropbox: ' + txt);
  }
  if (!res.ok) await fail(res, 'Upload');
  return res.json();
}

export async function remove(path) {
  const res = await send(API + '/files/delete_v2', { 'Content-Type': 'application/json' }, JSON.stringify({ path }));
  if (!res.ok && res.status !== 409) await fail(res, 'Löschen');
}
