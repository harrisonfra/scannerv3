const CACHE_NAME = "vin-viewer-cache-v4";
const STATIC_ASSETS = [
    "./",
    "./index.html",
    "./styles.css",
    "./script.js",
    "./manifest.json",
    "./UAR.png",
];

// Install: cache static assets
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// Network-first: serve fresh, fall back to cache offline, keep cache updated
function networkFirst(request) {
    return fetch(request)
        .then(response => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
            return response;
        })
        .catch(() => caches.match(request));
}

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;

    // Cross-origin (NHTSA API, CDNs, eBay): never cache — APIs must stay live
    if (new URL(request.url).origin !== self.location.origin) return;

    // Network-first for everything same-origin (JS/CSS included) so deploys
    // are picked up immediately; the cache is an offline fallback only.
    event.respondWith(networkFirst(request));
});
