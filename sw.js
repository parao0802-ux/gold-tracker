/* 금시세 트래커 — 서비스 워커 (앱 셸 오프라인 캐시)
   CACHE 버전을 올리면 activate 때 이전 캐시를 통째로 비운다.
   화면이 바뀌었는데 폰에 반영이 안 될 때 여기를 올리는 게 확실한 방법이다. */
const CACHE = 'gold-tracker-v2';
const SHELL = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 시세·환율 등 외부 API(교차 출처)는 항상 네트워크에서 최신값을 받는다.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // 같은 출처라도 /api는 시세 프록시라 캐시하면 안 된다.
  if (new URL(req.url).pathname.startsWith('/api/')) return;

  // 같은 출처의 앱 셸: 캐시 우선 + 백그라운드 갱신(stale-while-revalidate).
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
