// 앱 셸 캐시 + 알림 클릭 처리. 파일을 바꾸면 VERSION 을 올린다
const VERSION = 'v7';
const CACHE = `planner-${VERSION}`;
const SHELL = [
    './', 'index.html', 'styles.css', 'app.js', 'core.js', 'sync.js', 'fitness-program.js', 'manifest.webmanifest',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

// 네트워크 우선(새 버전 즉시 반영), 오프라인이면 캐시
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    // 동기화 API 응답(개인 기록)은 캐시하지 않는다
    const { hostname } = new URL(event.request.url);
    if (hostname === 'api.github.com' || hostname.endsWith('githubusercontent.com')) return;
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.ok || response.type === 'opaque') {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
                }
                return response;
            })
            .catch(() => caches.match(event.request, { ignoreSearch: true })),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            const client = clients.find((c) => 'focus' in c);
            return client ? client.focus() : self.clients.openWindow('./');
        }),
    );
});
