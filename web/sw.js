// 미믹 서비스 워커(K-09 모바일 설치·PWA).
// 화면 파일(index.html·JS·CSS·아이콘)만 캐시한다. /api·/webdav·영상·음악은 절대 캐시하지 않는다(사용자 데이터·쿼터).
// 네트워크 우선: 연결돼 있으면 늘 서버 파일(브라우저 HTTP 캐시의 304 로 빠름), 오프라인일 때만 캐시.
// 캐시를 먼저 보여 주면 배포 직후 옛 ui.js 와 새 화면 모듈이 섞여 화면이 깨지므로 그렇게 하지 않는다.
const CACHE = 'mimic-shell-v3';
const SHELL = ['/', '/app.js', '/ui.js', '/layout.js', '/styles.css', '/pwa.js', '/logo.svg', '/manifest.webmanifest', '/icons/icon-192.png'];
const STATIC = /\.(?:js|css|svg|png|webmanifest|woff2?)$/i;

// 캐시할 요청이면 캐시 키(문자열), 아니면 null
function cacheKey(req) {
  if (req.method !== 'GET' || req.headers.has('range')) return null;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return null;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webdav') || url.pathname === '/sw.js') return null;
  if (['video', 'audio', 'track'].includes(req.destination)) return null;
  if (req.mode === 'navigate') return /\.[a-z0-9]+$/i.test(url.pathname) ? null : '/'; // 화면 주소는 모두 같은 index.html(SPA, server/index.js 와 같은 규칙)
  return STATIC.test(url.pathname) ? url.pathname + url.search : null;
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const key = cacheKey(e.request);
  if (!key) return; // 브라우저 기본 동작(네트워크)
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      fetch(e.request).then(
        async (res) => {
          if (res.ok && res.type === 'basic') await cache.put(key, res.clone()).catch(() => {});
          return res;
        },
        async (err) => (await cache.match(key)) || Promise.reject(err), // 오프라인
      ),
    ),
  );
});

// 앱 푸시(K-05): 서버(server/core/notify.js)가 보낸 { title, body, link } 를 알림으로 띄운다.
// tag 를 주지 않는다: 같은 tag 면 앞 알림을 소리 없이 덮어써서(보안 알림이 문의 답변을 가리는 등) 하나씩 따로 띄운다
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data?.json() || {};
  } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Mimic', { body: d.body || '', icon: '/icons/icon-192.png', data: { link: d.link || null } }));
});

// 알림을 누르면 열려 있는 미믹 창을 앞으로 가져와 링크로 옮기고, 없으면 새 창을 연다
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url;
  try {
    url = new URL(e.notification.data?.link || '/drive/notifications', self.location.origin);
  } catch {}
  if (!url || !/^https?:$/.test(url.protocol)) url = new URL('/drive/notifications', self.location.origin);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
      const w = url.origin === self.location.origin && wins.find((c) => new URL(c.url).origin === url.origin);
      if (w) {
        await w.focus();
        if (await w.navigate(url.href).catch(() => null)) return;
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
