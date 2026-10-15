// Minimal service worker: makes the app installable. Always goes to the
// network first; only GET requests are touched, so saves and logins pass
// straight through untouched.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', () => self.clients.claim())
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then(r => r || Response.error()))
  )
})
