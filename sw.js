"use strict";

const CACHE_NAME = "glazok-pwa-v2";

// Локальные файлы для предварительного кеширования
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
];

// Установка: заносим статику в кэш
self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Активация: чистим старые версии кэша
self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
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

// Перехват сетевых запросов
self.addEventListener("fetch", event => {
  // Игнорируем всё, кроме GET
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  /*
   * 1. Локальные ресурсы приложения
   * Стратегия: Cache First, fallback на Network
   */
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;

        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        });
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  /*
   * 2. Внешние CDN (PeerJS, QRCode, Google Fonts)
   * Стратегия: Network First, fallback на Cache
   */
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Проверяем на 200 или 0 (opaque отклики от сторонних CDN)
        if (response && (response.status === 200 || response.type === "opaque")) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});