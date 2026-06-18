const CACHE_NAME = "vin-scanner-v2";

const urlsToCache = [
    "./",
    "./index.html",
    "./vinscanner.js",
    "./vinscanner.css",
    "./manifest.json"
];

// Install
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
    self.skipWaiting();
});

// Activate
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: network-first for same-origin (fresh app, cache as offline fallback);
// cross-origin (NHTSA, Wikipedia, CDNs) goes straight to the network untouched.
self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;
    if (new URL(request.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                return response;
            })
            .catch(() => caches.match(request))
    );
});
