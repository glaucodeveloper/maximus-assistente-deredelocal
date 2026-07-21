const CACHE_NAME = 'okf-chat-shell-v2';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app-config.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate' || url.pathname.endsWith('/app-config.json')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached ?? caches.match('./index.html'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached ?? fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    })),
  );
});
