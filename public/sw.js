const CACHE_NAME = 'maximus-intelligence-shell-v6';

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app-config.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key =>
          key.startsWith('maximus-intelligence-shell-') &&
          key !== CACHE_NAME
        )
        .map(key => caches.delete(key)),
    );
    await self.clients.claim();

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of clients) {
      client.postMessage({
        type: 'MAXIMUS_VERSION_READY',
        version: 'v6',
      });
    }
  })());
});

async function networkFirst(request) {
  try {
    const response = await fetch(request, {cache: 'no-store'});

    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, copy);
    }

    return response;
  } catch (error) {
    const cached = await caches.match(request);

    if (cached) return cached;
    if (request.mode === 'navigate') {
      return caches.match('./index.html');
    }

    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);

  if (response.ok) {
    const copy = response.clone();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, copy);
  }

  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // O modelo permanece no OPFS e não deve passar pelo Cache Storage.
  if (url.pathname.endsWith('.litertlm') || request.headers.has('range')) {
    return;
  }

  const mustUpdateFromNetwork =
    request.mode === 'navigate' ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'worker' ||
    url.pathname.includes('/assets/') ||
    url.pathname.endsWith('/app-config.json') ||
    url.pathname.endsWith('/manifest.webmanifest') ||
    url.pathname.endsWith('/sw.js');

  if (mustUpdateFromNetwork) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
