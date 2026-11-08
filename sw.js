const VERSION = 'v1';
const CACHE = `scorecard-${VERSION}`;
const ASSETS = ['./', './index.html', './manifest.webmanifest', './css/tokens.css', './css/base.css', './css/components.css', './js/app.js', './js/dom.js', './js/model.js', './js/store.js', './js/keypad.js', './js/views/home.js', './js/views/setup.js', './js/views/game.js', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
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

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(request).catch(() => caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
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
