/*
 * Glazok TURN proxy (Cloudflare Worker).
 *
 * Зачем: секретный ключ Metered нельзя класть в публичный репозиторий. Worker хранит его
 * в своих секретах, сам создаёт ВРЕМЕННЫЙ TURN-доступ и отдаёт сайту готовый список iceServers.
 *
 * Настройки (wrangler.toml / панель Cloudflare):
 *   METERED_APP         — имя приложения Metered (до ".metered.live")
 *   METERED_SECRET_KEY  — SECRET (wrangler secret put METERED_SECRET_KEY), Dashboard → Developers
 *   ALLOWED_ORIGINS     — через запятую, например "https://user.github.io,http://localhost:8080"
 *   CRED_TTL_SECONDS    — (необязательно) срок жизни учётных данных, по умолчанию 6 часов
 *
 * Ограничение: проверка Origin защищает от чужих САЙТОВ в браузере, но не от скриптов,
 * которые подделывают заголовок. Для полной защиты добавьте Rate Limiting в Cloudflare.
 */

const CACHE_SECONDS = 20 * 60; // общий список на 20 минут: не создаём новый доступ на каждый запрос

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);

    const cors = {
      "Access-Control-Allow-Origin": originOk ? origin : "null",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);
    if (!originOk) return json({ error: "origin not allowed" }, 403, cors);
    if (!env.METERED_APP || !env.METERED_SECRET_KEY) return json({ error: "worker is not configured" }, 500, cors);

    const cache = caches.default;
    const cacheKey = new Request("https://glazok-turn.internal/ice-servers");
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" } });

    try {
      const base = `https://${env.METERED_APP}.metered.live/api/v1/turn`;
      const ttl = Number(env.CRED_TTL_SECONDS) || 6 * 3600;

      // 1. Создаём временный доступ (секретный ключ остаётся только здесь)
      const created = await fetch(`${base}/credential?secretKey=${encodeURIComponent(env.METERED_SECRET_KEY)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryInSeconds: ttl, label: "glazok-" + Date.now() })
      });
      if (!created.ok) throw new Error("create credential: HTTP " + created.status);
      const { apiKey } = await created.json();
      if (!apiKey) throw new Error("create credential: no apiKey");

      // 2. Получаем актуальный список серверов для этого доступа
      const list = await fetch(`${base}/credentials?apiKey=${encodeURIComponent(apiKey)}`);
      if (!list.ok) throw new Error("get credentials: HTTP " + list.status);
      const iceServers = await list.json();
      if (!Array.isArray(iceServers) || !iceServers.length) throw new Error("empty ice list");

      const body = JSON.stringify(iceServers);
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` }
      })));
      return new Response(body, { status: 200, headers: { ...cors, "Content-Type": "application/json", "X-Cache": "MISS" } });
    } catch (error) {
      return json({ error: String(error.message || error) }, 502, cors);
    }
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
