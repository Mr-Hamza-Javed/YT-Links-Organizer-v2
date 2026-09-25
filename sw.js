/* =========================================================
   sw.js — service worker (makes the app installable)

   Network-first for this site's own files: when online you ALWAYS get the
   latest version (no stale files after a release); the last copy is only
   used when the network is unavailable. Everything else (Firebase, YouTube,
   CDNs) is not touched at all.
   ========================================================= */
const CACHE = "ylo-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("ylo-shell-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Firebase / YouTube / CDNs: untouched
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === "navigate" });
      if (hit) return hit;
      if (req.mode === "navigate") {
        const shell = await caches.match(new URL("./", self.registration.scope).href);
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
