"use strict";

/*
 * Общие настройки Glazok. Подключается во всех страницах перед основным скриптом.
 *
 * ВАЖНО ПРО TURN: в этом файле НЕТ логинов и паролей TURN — репозиторий публичный.
 * Данные TURN запрашиваются при запуске страницы одним из двух способов (см. TURN ниже):
 *   1) через свой прокси (Cloudflare Worker из папки worker/) — секретный ключ хранится
 *      только в настройках Worker, наружу выдаются временные логин/пароль;
 *   2) напрямую из Metered по apiKey учётных данных (Metered считает его безопасным
 *      для фронтенда, но он даёт доступ к вашей квоте трафика).
 * Если не настроено ничего — работает только STUN: связь внутри одной Wi-Fi сети есть,
 * а между разными сетями (мобильный интернет ↔ Wi-Fi) может не соединиться.
 */
window.GLAZOK = {
  TURN: {
    /* Обычно ничего вписывать сюда не нужно: откройте монитор → «Настройки TURN»,
       введите имя приложения и apiKey — они сохранятся в браузере и сами
       передадутся на телефоны через QR-код. В репозиторий ключи не попадают.

       Способ 1 (надёжнее): адрес вашего Worker, например
       "https://glazok-turn.your-name.workers.dev/turn" */
    endpoint: "",

    /* Способ 2: имя приложения Metered (до ".metered.live") и apiKey УЧЁТНЫХ ДАННЫХ
       (Dashboard → TURN Server → credential → apiKey). Это не secretKey! */
    meteredApp: "",
    meteredApiKey: "",

    /* Сколько минут держать полученные данные в sessionStorage */
    cacheMinutes: 20,
    timeoutMs: 6000
  },

  /* Запасной вариант без TURN */
  ICE_FALLBACK: [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "stun:stun.l.google.com:19302" }
  ],

  /* Заполняются в initIce() */
  ICE_SERVERS: null,
  iceSource: "none",       // "endpoint" | "metered" | "cache" | "stun-only"
  iceError: "",

  /* Свой PeerServer (надёжнее публичного облака). Пример:
     { host: "peer.example.com", port: 443, path: "/", secure: true }
     null — использовать облачный сервер PeerJS. */
  PEER_SERVER: null,

  /* Битрейт, с которым монитор пересылает видео на «Чистый вывод» (OBS), бит/с */
  VIEWER_BITRATE: 15000000,

  /* ?relay=1 в адресе страницы — принудительно гнать всё через TURN (проверка «разные сети») */
  forceRelay: /[?&]relay=1\b/.test(location.search),

  /* ---------- ICE / TURN ---------- */

  _icePromise: null,

  /* ---------- Сохранённые настройки TURN (localStorage браузера) ---------- */

  _turnKey: "glazok_turn",

  /* Итоговые настройки: сохранённые в браузере важнее значений из этого файла */
  turnConfig() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(this._turnKey) || "{}") || {}; } catch {}
    return {
      endpoint: stored.endpoint || this.TURN.endpoint || "",
      app: stored.app || this.TURN.meteredApp || "",
      apiKey: stored.apiKey || this.TURN.meteredApiKey || ""
    };
  },

  /* Принимает "glazok-live", "glazok-live.metered.live" или полный https://-адрес */
  cleanApp(value) {
    let v = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.metered\.live$/, "");
    return /^[a-z0-9][a-z0-9-]{1,62}$/.test(v) ? v : "";
  },

  cleanKey(value) {
    const v = String(value || "").trim();
    return /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : "";
  },

  setTurn({ app, apiKey, endpoint }) {
    const data = { app: this.cleanApp(app), apiKey: this.cleanKey(apiKey), endpoint: String(endpoint || "").trim() };
    if (data.endpoint && !/^https:\/\//i.test(data.endpoint)) data.endpoint = "";
    try { localStorage.setItem(this._turnKey, JSON.stringify(data)); } catch {}
    this.resetIce();
    return data;
  },

  clearTurn() {
    try { localStorage.removeItem(this._turnKey); } catch {}
    this.resetIce();
  },

  resetIce() {
    try { sessionStorage.removeItem("glazok_ice_v2"); } catch {}
    this._icePromise = null;
    this.ICE_SERVERS = null;
    this.iceSource = "none";
    this.iceError = "";
  },

  /* Строка для параметра ?t= в ссылках (QR, Clean Output): телефон подхватит настройки сам */
  turnShare() {
    const c = this.turnConfig();
    return c.app && c.apiKey ? c.app + ":" + c.apiKey : "";
  },

  hasTurnConfig() {
    const c = this.turnConfig();
    return !!(c.endpoint || (c.app && c.apiKey));
  },

  /* Вызывать и ждать ПЕРЕД созданием Peer. Повторные вызовы возвращают тот же результат. */
  initIce() {
    if (this._icePromise) return this._icePromise;
    this._icePromise = this._loadIce();
    return this._icePromise;
  },

  async _loadIce() {
    const cfg = this.TURN;
    const conf = this.turnConfig();
    const cacheKey = "glazok_ice_v2";
    const sig = conf.endpoint + "|" + conf.app + "|" + conf.apiKey;
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      if (cached && cached.sig === sig && cached.expires > Date.now() && Array.isArray(cached.servers) && cached.servers.length) {
        this.ICE_SERVERS = cached.servers;
        this.iceSource = "cache";
        return this.ICE_SERVERS;
      }
    } catch {}

    let url = "";
    let source = "";
    if (conf.endpoint) { url = conf.endpoint; source = "endpoint"; }
    else if (conf.app && conf.apiKey) {
      url = "https://" + conf.app + ".metered.live/api/v1/turn/credentials?apiKey=" + encodeURIComponent(conf.apiKey);
      source = "metered";
    }

    if (!url) {
      this.ICE_SERVERS = this.ICE_FALLBACK;
      this.iceSource = "stun-only";
      this.iceError = "TURN не настроен";
      return this.ICE_SERVERS;
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 6000);
      const response = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (response.status === 401 || response.status === 403) throw new Error("ключ не принят (HTTP " + response.status + ")");
      if (response.status === 404) throw new Error("приложение не найдено — проверьте имя (HTTP 404)");
      if (!response.ok) throw new Error("HTTP " + response.status);
      let data = await response.json();
      if (data && !Array.isArray(data) && Array.isArray(data.iceServers)) data = data.iceServers;
      if (!Array.isArray(data) || !data.length) throw new Error("пустой ответ");
      const hasTurn = data.some(s => [].concat(s.urls || []).some(u => /^turns?:/i.test(u)));
      if (!hasTurn) throw new Error("в ответе нет TURN-серверов");
      this.ICE_SERVERS = data;
      this.iceSource = source;
      this.iceError = "";
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({
          sig,
          servers: data,
          expires: Date.now() + (cfg.cacheMinutes || 20) * 60000
        }));
      } catch {}
    } catch (error) {
      console.warn("TURN: не удалось получить данные:", error);
      this.ICE_SERVERS = this.ICE_FALLBACK;
      this.iceSource = "stun-only";
      this.iceError = "TURN недоступен: " + (error && error.message ? error.message : error);
    }
    return this.ICE_SERVERS;
  },

  peerOptions() {
    const config = {
      iceServers: this.ICE_SERVERS || this.ICE_FALLBACK,
      sdpSemantics: "unified-plan",
      iceCandidatePoolSize: 2
    };
    if (this.forceRelay) config.iceTransportPolicy = "relay";
    const options = { config };
    if (this.PEER_SERVER) Object.assign(options, this.PEER_SERVER);
    return options;
  },

  /*
   * Проверка TURN: собираем ICE-кандидаты и смотрим, появились ли relay-кандидаты.
   * relay > 0  → TURN работает (логин/пароль приняты), видео пройдёт между любыми сетями.
   * relay = 0  → TURN недоступен или ключи недействительны.
   */
  async testTurn(timeoutMs) {
    await this.initIce();
    const result = { source: this.iceSource, host: 0, srflx: 0, relay: 0, error: this.iceError || "", ms: 0 };
    const started = performance.now();
    let pc = null;
    try {
      pc = new RTCPeerConnection({ iceServers: this.ICE_SERVERS });
      pc.createDataChannel("probe");
      await new Promise(async resolve => {
        const done = () => resolve();
        const timer = setTimeout(done, timeoutMs || 7000);
        pc.onicecandidate = e => {
          if (!e.candidate) { clearTimeout(timer); done(); return; }
          const m = / typ (host|srflx|relay|prflx) /.exec(e.candidate.candidate);
          if (m && result[m[1]] !== undefined) result[m[1]]++;
          if (result.relay > 0) { clearTimeout(timer); done(); }
        };
        try { await pc.setLocalDescription(await pc.createOffer()); } catch (error) { result.error = String(error); done(); }
      });
    } catch (error) {
      result.error = String(error && error.message || error);
    } finally {
      if (pc) try { pc.close(); } catch {}
    }
    result.ms = Math.round(performance.now() - started);
    return result;
  },

  /* Как реально идёт видео: "host" (локальная сеть), "srflx" (напрямую через интернет), "relay" (через TURN) */
  async routeType(pc) {
    try {
      const reports = await pc.getStats();
      let pairId = null;
      reports.forEach(r => { if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      let pair = pairId ? reports.get(pairId) : null;
      if (!pair) reports.forEach(r => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r; });
      if (!pair) return null;
      const local = reports.get(pair.localCandidateId);
      const remote = reports.get(pair.remoteCandidateId);
      const types = [local && local.candidateType, remote && remote.candidateType];
      if (types.includes("relay")) return "relay";
      if (types.includes("srflx") || types.includes("prflx")) return "srflx";
      return "host";
    } catch { return null; }
  },

  routeLabel(type) {
    return { host: "Wi‑Fi / локальная сеть", srflx: "напрямую через интернет", relay: "через TURN" }[type] || "—";
  },

  /* ---------- Устройство ---------- */

  /* Постоянный ID телефона: переживает обновление страницы, поэтому монитор не плодит дубликаты. */
  deviceId() {
    try {
      let id = localStorage.getItem("glazok_device_id");
      if (!id || !/^[a-z0-9]{10,}$/.test(id)) {
        id = this.randomId(12);
        localStorage.setItem("glazok_device_id", id);
      }
      return id;
    } catch {
      return this.randomId(12);
    }
  },

  /*
   * Модель телефона. Браузеры почти не отдают её сами:
   *  • Chrome/Edge на Android — через userAgentData.getHighEntropyValues("model");
   *  • iPhone/Safari и Firefox — модель недоступна (Apple и Mozilla это скрывают).
   * Поэтому пользователь может ввести название вручную (поле на экране камеры),
   * а на мониторе его можно переименовать кнопкой ✎.
   */
  async detectModel() {
    let model = "";
    try {
      const uad = navigator.userAgentData;
      if (uad && uad.getHighEntropyValues) {
        const high = await uad.getHighEntropyValues(["model"]);
        model = String(high.model || "").trim();
      }
    } catch {}
    const ua = navigator.userAgent || "";
    if (!model || model.length < 2) {
      const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(ua);
      const guess = m ? m[1].trim() : "";
      model = guess.length >= 2 && !/^(K|Android|Linux)$/i.test(guess) ? guess : "";
    }
    if (!model) {
      if (/iPhone/.test(ua)) model = "iPhone";
      else if (/iPad/.test(ua)) model = "iPad";
      else if (/Android/.test(ua)) model = "Android-телефон";
    }
    return model;
  },

  randomId(length, alphabet) {
    alphabet = alphabet || "abcdefghijklmnopqrstuvwxyz0123456789";
    const values = new Uint32Array(length);
    crypto.getRandomValues(values);
    return Array.from(values, n => alphabet[n % alphabet.length]).join("");
  },

  /* Ждём, пока у звонка появится RTCPeerConnection */
  whenPc(call, callback) {
    let tries = 0;
    const timer = setInterval(() => {
      const pc = call.peerConnection;
      if (pc) { clearInterval(timer); callback(pc); }
      else if (++tries > 50) clearInterval(timer);
    }, 100);
  },

  /* Небольшой буфер на приёме: меньше микрофризов при нестабильной сети */
  tuneReceivers(pc) {
    try {
      pc.getReceivers().forEach(r => { if ("jitterBufferTarget" in r) r.jitterBufferTarget = 150; });
    } catch {}
  },

  /*
   * Повышает битрейт через SDP (Chrome/Edge/OBS). Мин./старт/макс. в кбит/с.
   * Применяется той стороной, которая ПРИНИМАЕТ видео: именно её SDP читает отправитель.
   */
  sdpHighBitrate(maxKbps, startKbps, minKbps) {
    return sdp => {
      try {
        const lines = sdp.split("\r\n");
        const out = [];
        let video = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("m=")) video = line.startsWith("m=video");
          if (video && line.startsWith("b=")) { out.push("b=AS:" + maxKbps); continue; }
          if (video && line.startsWith("a=fmtp:") && !/apt=/.test(line)) {
            out.push(line + ";x-google-min-bitrate=" + minKbps + ";x-google-start-bitrate=" + startKbps + ";x-google-max-bitrate=" + maxKbps);
            continue;
          }
          out.push(line);
          if (video && line.startsWith("c=") && !(lines[i + 1] || "").startsWith("b=")) out.push("b=AS:" + maxKbps);
        }
        return out.join("\r\n");
      } catch { return sdp; }
    };
  },

  /*
   * Высокий битрейт без снижения разрешения. setParameters сразу после создания звонка
   * бросает ошибку (параметры ещё не согласованы), поэтому пробуем, пока не получится.
   */
  boostCall(call, bitrate) {
    this.whenPc(call, pc => {
      let attempts = 0;
      const apply = async () => {
        attempts++;
        let done = false;
        for (const sender of pc.getSenders()) {
          if (!sender.track || sender.track.kind !== "video") continue;
          try {
            const p = sender.getParameters();
            if (!p.encodings || !p.encodings.length) throw new Error("not negotiated yet");
            p.encodings[0].maxBitrate = bitrate;
            p.encodings[0].maxFramerate = 60;
            p.encodings[0].scaleResolutionDownBy = 1;
            p.degradationPreference = "maintain-resolution";
            await sender.setParameters(p);
            done = true;
          } catch {}
        }
        if (!done && attempts < 30 && pc.connectionState !== "closed") setTimeout(apply, 500);
      };
      apply();
      pc.addEventListener("connectionstatechange", () => { if (pc.connectionState === "connected") { attempts = 0; apply(); } });
    });
  }
};

/* Телефон/Clean Output открыты по ссылке с монитора: ?t=приложение:apiKey → сохраняем и убираем из адреса */
(function adoptTurnFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const t = params.get("t");
    if (!t) return;
    const i = t.indexOf(":");
    if (i > 0) GLAZOK.setTurn({ app: t.slice(0, i), apiKey: t.slice(i + 1), endpoint: "" });
    params.delete("t");
    const query = params.toString();
    history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
  } catch {}
})();
