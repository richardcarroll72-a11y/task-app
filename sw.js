// Service Worker for My Tasks PWA
const CACHE_NAME = 'my-tasks-v3';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];
const API_CACHE = 'my-tasks-api-v3';

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: static assets from cache, API calls network-first with cache fallback
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests: network first, fall back to cache
  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'GET') {
      event.respondWith(
        fetch(request)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(API_CACHE).then(cache => cache.put(request, clone));
            }
            return response;
          })
          .catch(() =>
            caches.match(request).then(
              cached =>
                cached ||
                new Response(
                  JSON.stringify({ tasks: [], stats: { today: 0, overdue: 0, total: 0 }, offline: true }),
                  { headers: { 'Content-Type': 'application/json' } }
                )
            )
          )
      );
    }
    // Non-GET API calls: always go to network (don't intercept)
    return;
  }

  // Static assets: cache first
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});

// Background sync for pending completions (when back online)
self.addEventListener('sync', event => {
  if (event.tag === 'sync-completions') {
    event.waitUntil(syncPendingCompletions());
  }
});

async function syncPendingCompletions() {
  try {
    const db = await openDB();
    const pending = await getAll(db, 'pending');
    for (const item of pending) {
      try {
        await fetch(`/api/tasks?id=${item.id}`, { method: 'PATCH' });
        await deleteRecord(db, 'pending', item.id);
      } catch (e) {
        // Will retry on next sync
      }
    }
  } catch (e) {
    console.error('Sync failed:', e);
  }
}

// Minimal IndexedDB helpers for pending sync queue
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('my-tasks-sync', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('pending', { keyPath: 'id' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function deleteRecord(db, store, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
