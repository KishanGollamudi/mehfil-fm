const CACHE = 'mehfil-v1';
const SHELL = ['/', '/assets/index-DuC8RpyE.js', '/assets/index-Djy534jB.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept API, stream, or Subsonic calls
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/stream') ||
      url.pathname.startsWith('/rest/') ||
      url.pathname.startsWith('/proxy-stream')) {
    return;
  }

  // Network-first for navigation; cache-first for assets
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r || fetch(request))),
    );
  } else {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
  }
});
