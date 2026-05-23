// Phill da Rythm — service worker (offline + PWA).
// Estratégia: cache-first com atualização em background (stale-while-revalidate),
// só pra GETs do próprio origin. Não precisa enumerar arquivos (cacheia conforme usa) —
// robusto pra app estático sem build. Bump CACHE pra forçar limpeza em update.
const CACHE = 'phill-rythm-v3';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
