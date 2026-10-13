// オフラインでもアプリを開けるようにするための Service Worker
// ファイルを更新したら VERSION と index.html の ?v= をそろえて上げる
const VERSION = 'hc-v6';
const ASSETS = [
  './',
  'index.html',
  'style.css?v=6',
  'app.js?v=6',
  'dashboard.js?v=6',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 自分のファイルは「ネット優先・ダメならキャッシュ」。Apps Script への通信には触らない
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // ブラウザの一時保存（HTTPキャッシュ）を使わず、毎回サーバーに最新か確認する
  const net = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(req, { cache: 'no-cache' });
  e.respondWith(
    net
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
