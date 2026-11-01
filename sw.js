// Offline support. Code files load from the network first so updates show up right away;
// the cache is only a fallback when offline. The word list is cached first (it rarely changes).
const CACHE = "lexicon-v4";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.json", "words.json",
  "icon.svg", "icon-192.png", "icon-512.png", "THIRD_PARTY_NOTICES.txt"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    if (url.pathname.endsWith("words.json")) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
    }
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
