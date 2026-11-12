
/* =========================================================
   CHIMIC CONNECT — SERVICE WORKER
   Offline support, caching and application updates
   ========================================================= */

const CACHE_NAME = 'chimic-connect-v2';
const OFFLINE_URL = '/index.html';

const STATIC_ASSETS = [
  OFFLINE_URL
];

/* INSTALL */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      await cache.addAll(STATIC_ASSETS);

      await self.skipWaiting();
    })()
  );
});

/* ACTIVATE */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter((key) =>
            key.startsWith('chimic-connect-') &&
            key !== CACHE_NAME
          )
          .map((key) => caches.delete(key))
      );

      await self.clients.claim();
    })()
  );
});

/* FETCH */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  // Only handle requests from this website.
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // Never cache private API responses.
  if (
    requestUrl.pathname.startsWith('/api/') ||
    requestUrl.pathname.startsWith('/socket.io/')
  ) {
    return;
  }

  // Do not cache browser extension or unsupported requests.
  if (requestUrl.protocol !== 'http:' &&
      requestUrl.protocol !== 'https:') {
    return;
  }

  // Navigation: try network first, then offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(OFFLINE_URL, response.clone());
          }

          return response;
        } catch (error) {
          return (
            await caches.match(OFFLINE_URL)
          ) || Response.error();
        }
      })()
    );

    return;
  }

  // Static assets: try network, then cache.
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);

        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }

        return response;
      } catch (error) {
        return (
          await caches.match(request)
        ) || Response.error();
      }
    })()
  );
});

/* MESSAGE */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
