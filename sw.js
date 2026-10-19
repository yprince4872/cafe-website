// sw.js — makes the website installable as an app and lets it open even with a weak signal.
//
// Pages, styles and scripts: ALWAYS try the internet first (so the latest version shows up as
// soon as you update the website), and fall back to the saved copy only when offline.
// Orders, payments, menu data and photos come from the backend / other sites and are never
// saved here, so they are always live.

const CACHE = 'musafir-app-v2';
const SHELL = [
  'index.html', 'about.html', 'menu.html', 'gallery.html', 'news.html', 'contact.html', 'account.html', 'offline.html',
  'styles.css', 'script.js', 'content.js', 'account.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;  // backend API, photos, fonts: normal
  if (url.pathname.endsWith('/admin.html')) return;                          // admin is never saved

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) =>
          hit || (req.mode === 'navigate' ? caches.match('offline.html') : Response.error())
        )
      )
  );
});
