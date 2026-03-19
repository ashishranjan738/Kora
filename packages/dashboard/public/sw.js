// Kora Dashboard Service Worker — shell-only caching for offline support
// IMPORTANT: Only cache the HTML shell. Vite-hashed JS/CSS are always fresh.
const CACHE_NAME = "kora-shell-v1";
const SHELL_URLS = ["/", "/index.html"];

// Install: cache only the app shell HTML
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first, offline fallback to cached shell only
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET, API, WebSocket, and terminal requests
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/") || url.pathname.startsWith("/terminal/")) return;

  // Only intercept navigation requests (HTML pages) — let Vite-hashed assets go direct
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(() => {
      // Offline: serve cached shell (SPA will handle routing)
      return caches.match("/").then((cached) => cached || new Response("Offline", { status: 503 }));
    })
  );
});
