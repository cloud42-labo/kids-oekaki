const CACHE = 'kids-oekaki-v2';
const CACHE_PREFIX = 'kids-oekaki-';
// self.registration.scopeはこのservice workerが実際に登録されたURL（サブパス配信も含む）を
// 指すため、これを起点にすることでGitHub Pagesのプロジェクトサイトのようにルート以外の
// パスへデプロイしても壊れない。
const SCOPE = self.registration.scope;
const APP_SHELL = [SCOPE, `${SCOPE}manifest.webmanifest`, `${SCOPE}icon.svg`];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match(SCOPE))),
  );
});
