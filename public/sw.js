/*
 * OpsPM360 service worker — cold-start offline for remote mine sites.
 *
 * Strategy:
 *  - /_next/static and font/icon assets: cache-first (immutable, hashed URLs).
 *  - Page navigations: network-first with cache fallback; last-known copy of
 *    each visited page is kept so the app boots offline after a reload.
 *    If nothing is cached for the URL, fall back to the cached dashboard.
 *  - API calls (/api/*) are NEVER cached — the Dexie outbox owns offline
 *    mutations; serving stale API responses would corrupt sync semantics.
 */

const VERSION = "opspm360-v1";
const RUNTIME = `${VERSION}-runtime`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(RUNTIME)
      .then((cache) => cache.addAll(["/", "/manifest.webmanifest", "/icon.svg"]).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // sync engine territory

  // Immutable build assets: cache-first. The final .catch matters: an
  // uncached asset fetched while offline would otherwise REJECT respondWith
  // (an unhandled rejection surfacing as a browser-level network error page).
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith(
      caches
        .match(req)
        .then(
          (hit) =>
            hit ??
            fetch(req).then((res) => {
              if (res.ok) {
                const copy = res.clone();
                caches.open(RUNTIME).then((cache) => cache.put(req, copy));
              }
              return res;
            })
        )
        .catch(
          () =>
            new Response("", {
              status: 504,
              statusText: "Offline and not cached",
            })
        )
    );
    return;
  }

  // Navigations: network-first, cache fallback, dashboard as last resort.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          if (hit) return hit;
          const home = await caches.match("/");
          return (
            home ??
            new Response(
              "<h1>Offline</h1><p>OpsPM360 has no cached copy of this page yet. Reconnect and retry.</p>",
              { status: 503, headers: { "Content-Type": "text/html" } }
            )
          );
        })
    );
  }
});
