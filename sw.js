"use strict";

const CACHE_NAME = "glazok-pwa-v1";

const APP_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg"
];


self.addEventListener("install", event => {

  event.waitUntil(

    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())

  );

});


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


self.addEventListener("fetch", event => {

  if (event.request.method !== "GET") {
    return;
  }


  const url =
    new URL(event.request.url);


  /*
   * Для нашего приложения:
   * Cache First
   */

  if (url.origin === location.origin) {

    event.respondWith(

      caches
        .match(event.request)
        .then(cached => {

          if (cached) {
            return cached;
          }


          return fetch(event.request)
            .then(response => {

              if (
                response &&
                response.status === 200
              ) {

                const copy =
                  response.clone();

                caches
                  .open(CACHE_NAME)
                  .then(cache => {

                    cache.put(
                      event.request,
                      copy
                    );

                  });

              }

              return response;

            });

        })
        .catch(() =>
          caches.match("./index.html")
        )

    );

    return;
  }


  /*
   * CDN:
   * Network First.
   *
   * Если CDN доступен —
   * используем свежую версию.
   *
   * Если нет —
   * используем ранее сохранённую.
   */

  event.respondWith(

    fetch(event.request)
      .then(response => {

        if (
          response &&
          response.status === 200
        ) {

          const copy =
            response.clone();

          caches
            .open(CACHE_NAME)
            .then(cache => {

              cache.put(
                event.request,
                copy
              );

            });

        }

        return response;

      })
      .catch(() =>
        caches.match(event.request)
      )

  );

});