const VERSION = 'v3';
const CACHE = `scorecard-${VERSION}`;
// Every app file must be listed here; test/sw-assets.test.mjs enforces it.
const ASSETS = [
  './', './manifest.webmanifest',
  './css/tokens.css', './css/base.css', './css/components.css',
  './js/app.js', './js/cloud.js', './js/config.js', './js/dom.js', './js/icons-data.js', './js/icons.js',
  './js/keypad.js', './js/model.js', './js/stats.js', './js/store.js', './js/sync.js', './js/syncer.js', './js/ui.js',
  './js/views/account.js', './js/views/game.js', './js/views/home.js', './js/views/settings.js',
  './js/views/setup.js', './js/views/shared.js', './js/views/stats.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

// A redirected response cannot be served for a navigation; rebuild it as a plain response.
async function unredirected(res) {
  if (!res || res.redirected !== true) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(ASSETS.map(async (path) => {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`precache ${path}: ${res.status}`);
        await c.put(path, await unredirected(res));
      }))
    )
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('scorecard-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/auth/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./').then((cached) => (cached ? unredirected(cached) : fetch(request).catch(() => caches.match('./').then(unredirected))))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return unredirected(cached);
      const network = fetch(event.request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(event.request, copy)));
        }
        return res;
      });
      return network.catch(() => Response.error());
    })
  );
});
