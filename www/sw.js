/* =============================================================================
   مقاضي العائلة — service worker
   - caches the tiny app shell so the icon opens instantly / offline
   - never caches /api responses (the list must always be live)
   - receives Web Push messages and shows them in the phone's notification tray
   ============================================================================= */
const CACHE = "mqadi-family-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./api.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;          // CDN fonts/scripts
  if (url.pathname.startsWith("/api/")) return;             // always live
  if (url.pathname === "/fg-config.js") return;             // origin-specific

  // App shell: network first so a new version arrives, cache as the fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put("./index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});

/* --------------------------------------------------------------- Web Push */

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "مقاضي العائلة";
  const options = {
    body: data.body || "يوجد تحديث جديد في قائمة المقاضي.",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    dir: "rtl",
    lang: "ar",
    tag: data.tag || "family-groceries",
    renotify: !!data.tag,
    data: { url: data.url || "./" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
