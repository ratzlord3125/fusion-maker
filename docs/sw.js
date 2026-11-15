// Lets Fusion Maker open even without internet once it has been visited.
// The newest version is always fetched when there IS internet; the saved copy is only a fallback.
const CACHE = 'fusion-maker-v1';
const CORE = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'js/app.js', 'js/util.js', 'js/store.js', 'js/media.js', 'js/plan.js', 'js/engine.js', 'js/audio.js', 'js/joins.js', 'js/trim.js',
  'vendor/mediabunny.min.mjs', 'vendor/mediabunny-mp3-encoder.min.mjs',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(request);
      if (fresh.status === 200) cache.put(request, fresh.clone());
      return fresh;
    } catch (err) {
      const saved = await cache.match(request, { ignoreSearch: true });
      if (saved) return saved;
      throw err;
    }
  })());
});
