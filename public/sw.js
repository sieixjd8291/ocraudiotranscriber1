// Bumped to v4: the caching strategy changed (immutable /assets/* are now
// cache-first with NO background revalidation, and cross-origin CDN URLs were
// removed from the install precache). A version bump ensures every existing
// client discards the old v3 caches built under the wasteful SWR-everywhere
// strategy and adopts the leaner one on the next deploy.
const CACHE_NAME = 'cleanvoice-studio-v4';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/favicon.ico',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Only same-origin core assets are precached. Cross-origin CDN URLs
      // (Google Fonts CSS, MathJax, Font Awesome) were previously precached
      // here too, but:
      //  - Font Awesome (cdnjs) is never referenced at runtime — pure waste.
      //  - MathJax (jsdelivr) loads on demand via ResultMarkdownRenderer and
      //    dedupes itself; precaching it downloads ~1MB most sessions never use.
      //  - The Inter font CSS is already pulled by index.html's <link> on first
      //    paint and lands in cache via the SWR handler below.
      // SWR caches each on first real fetch, so they remain available offline.
      console.log('[Service Worker] Pre-caching core assets');
      return cache.addAll(CORE_ASSETS).catch((error) => {
        console.warn('[Service Worker] Pre-cache failing for some static files:', error);
      });
    })
  );
  // Force active service worker to take control immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      // Every entry must resolve to a Promise so Promise.all never drops a
      // deletion. Previously the matching-cache branch returned `undefined`
      // (no explicit return), which is harmless here but fragile — and the
      // intent ("delete everything that isn't the current version") must hold
      // reliably across cache-version bumps or users get stuck on stale assets.
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cache);
            return caches.delete(cache);
          }
          return Promise.resolve();
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 1. Bypass non-http/https protocols (like chrome-extension, internal, ws)
  if (!request.url.startsWith('http://') && !request.url.startsWith('https://')) {
    return;
  }

  // 1b. Only GET requests are cacheable. Every other method (PUT uploads to
  //     Cleanvoice's R2 storage, POST/DELETE API mutations, etc.) must bypass
  //     the service worker entirely and go straight to the network. Letting
  //     them fall through previously made the SW call Cache.put() on a PUT,
  //     which throws "Request method 'PUT' is unsupported", and risked
  //     buffering/interfering with streaming uploads.
  if (request.method !== 'GET') {
    return;
  }

  // 2. Bypass API and media/audio operations - must always hit network
  if (
    request.url.includes('/api/') ||
    request.url.includes('blob:') ||
    request.url.includes('.mp3') ||
    request.url.includes('.wav') ||
    request.url.includes('.ogg') ||
    request.url.includes('.m4a') ||
    request.url.includes('cleanvoice.ai') ||
    request.headers.get("accept")?.includes("audio/")
  ) {
    return;
  }

  // 3. Bypass development HMR / websocket assets
  if (request.url.includes('@vite') || request.url.includes('node_modules') || request.url.includes('hot-update')) {
    return;
  }

  // 4. Handle navigation requests (network-first with cache update + offline fallback)
  //    Network-first ensures users always see the latest index.html (with its
  //    freshly-hashed asset references) on each new deploy / dev rebuild, instead
  //    of being served a stale cached shell that points at old bundles.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          // Persist the fresh HTML so the offline fallback stays current.
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('/', responseToCache.clone());
              cache.put('/index.html', responseToCache);
            }).catch(() => {
              // Ignore non-fatal cache-write failures so they don't surface as
              // uncaught promise rejections in the console.
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('/').then((response) => {
            return response || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // 5. Immutable, content-hashed Vite assets (/assets/*) are served with
  //    `Cache-Control: max-age=31536000, immutable` (see netlify.toml). Vite
  //    content-hashes these filenames, so a given URL NEVER changes once
  //    deployed — the next deploy produces a new hash. Revalidating them on
  //    every load (the old SWR behavior) fired a background fetch per cached
  //    chunk per navigation, which across the many lazy-loaded route/feature
  //    chunks was the single largest source of redundant edge requests.
  //    Serve cache-first with NO background refetch: if cached, return
  //    immediately; otherwise fetch once and cache.
  if (request.url.startsWith(self.location.origin) && request.url.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            }).catch(() => {
              // Ignore non-fatal cache-write failures.
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 6. Caching Strategy for Core Assets & Static Files: Stale-While-Revalidate / Cache-First fallback
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached version immediately and refresh in background
        fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            }).catch(() => {
              // Ignore non-fatal cache-write failures so they don't surface as
              // uncaught promise rejections in the console.
            });
          }
        }).catch(() => {
          // Ignore network errors during background refresh when offline
        });
        return cachedResponse;
      }

      // Fallback to fetching over network and caching if not in static cache
      return fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          }).catch(() => {
            // Ignore non-fatal cache-write failures so they don't surface as
            // uncaught promise rejections in the console.
          });
        }
        return networkResponse;
      }).catch((fetchError) => {
        console.log('[Service Worker] Offline fetch fallback failed:', fetchError);
      });
    })
  );
});
