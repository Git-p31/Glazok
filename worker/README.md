# TURN-прокси для Glazok

1. Metered → Dashboard → **Developers**: скопируйте *Metered Domain* и **Secret Key**.
2. В `wrangler.toml` впишите `METERED_APP` и `ALLOWED_ORIGINS`.
3. Деплой:
   ```
   cd worker
   npx wrangler login
   npx wrangler secret put METERED_SECRET_KEY    # вставьте Secret Key
   npx wrangler deploy
   ```
4. Скопируйте адрес Worker в `config.js` → `TURN.endpoint`
   (например `https://glazok-turn.ИМЯ.workers.dev/`).
5. **Отзовите старые ключи**: Metered → TURN Server → удалите учётные данные,
   которые раньше лежали в `config.js` — они были в публичном репозитории и в его истории Git.
6. Проверка: откройте монитор и нажмите «Проверить TURN».
