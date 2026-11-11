/* Service worker PLWR : notifications push (même app fermée), action « Reporter », coquille hors ligne. */
const CACHE = 'plwr-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'PLWR', body: event.data ? event.data.text() : '' };
  }
  const supportsActions = 'maxActions' in Notification && Notification.maxActions > 0;
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag,
    renotify: true,
    data: { url: data.url || '/', snoozeToken: data.snoozeToken, supportsActions },
  };
  if (supportsActions && data.snoozeToken) {
    options.actions = [
      { action: 'snooze', title: 'Reporter 10 min' },
      { action: 'open', title: 'Ouvrir' },
    ];
  }
  event.waitUntil(self.registration.showNotification(data.title || 'PLWR', options));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  if (event.action === 'snooze' && d.snoozeToken) {
    event.waitUntil(
      fetch('/api/push/snooze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: d.snoozeToken }),
      }).catch(() => {}),
    );
    return;
  }
  // Sans boutons d'action (iPhone), on ouvre une page qui propose « Reporter ».
  const target = !d.supportsActions && d.snoozeToken ? `/rappel?t=${encodeURIComponent(d.snoozeToken)}&url=${encodeURIComponent(d.url || '/')}&titre=${encodeURIComponent(n.title)}` : d.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
