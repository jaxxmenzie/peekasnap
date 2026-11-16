/* PeekaSnap service worker: app-shell cache, offline fallback, push + notification clicks */
const VERSION = 'peekasnap-v10';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/game.js', '/hunt.js', '/call.js', '/manifest.json', '/offline.html', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js', '/socket.io/socket.io.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'peekasnap-photos').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;            // map tiles etc. go straight to the network
  if (url.pathname.startsWith('/api/') || (url.pathname.startsWith('/socket.io/') && url.search)) return; // live data never cached
  if (req.mode === 'navigate') {                                                  // pages: network first, cached shell, then offline page
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('/', copy)); return r; })
      .catch(async () => (await caches.match('/')) || caches.match('/offline.html')));
    return;
  }
  if (url.pathname.startsWith('/uploads/')) {                                     // photos have unique names: cache first
    e.respondWith(caches.open('peekasnap-photos').then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  // app code, styles, manifest: network first so a new deploy is used immediately; the cache is only an offline fallback
  e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })
    .catch(async () => (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true })) || Response.error()));
});

// Web Push: show a notification unless the app is open and visible (it shows its own in-app banner then)
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { title: 'PeekaSnap', body: e.data && e.data.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.some(c => c.visibilityState === 'visible' && c.focused)) return;
    return self.registration.showNotification(d.title || 'PeekaSnap', {
      body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', tag: d.tag || 'peekasnap',
      renotify: true, vibrate: d.call ? [500, 300, 500, 300, 500, 300, 500] : [200, 100, 200, 100, 400], data: { url: d.url || '/' },
      requireInteraction: !!d.call,
    });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(x => new URL(x.url).origin === location.origin);
    if (c) { c.postMessage({ type: 'open', url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
