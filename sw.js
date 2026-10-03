"use strict";

const CACHE_NAME = "glazok-studio-v3";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Наши файлы — сначала сеть, чтобы приложение
  // всегда получало свежую версию.
  if (url.origin === location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, copy);
            });
          }

          return response;
        })
        .catch(() => {
          return caches.match(event.request)
            .then(cached => cached || caches.match("./index.html"));
        })
    );

    return;
  }

  // Внешние ресурсы:
  // PeerJS, Google Fonts и т.д.
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;

        return fetch(event.request)
          .then(response => {
            if (
              response &&
              (response.ok || response.type === "opaque")
            ) {
              const copy = response.clone();

              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, copy);
              });
            }

            return response;
          });
      })
      .catch(() => caches.match(event.request))
  );
});