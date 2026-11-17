// Service Worker des Pokémon-Collectors: macht die App offline nutzbar.
// Eigene Dateien: zuerst aus dem Netz (damit Updates sofort ankommen), sonst aus dem Cache.
const CACHE = 'pokemon-v11';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/basis.css',
  'js/app.js', 'js/store.js', 'js/data.js', 'js/dropbox.js', 'js/research.js', 'js/importer.js',
  'js/photo.js', 'js/config.js', 'vendor/xlsx.full.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pokemon-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Dropbox/TCGdex nie hier cachen
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
