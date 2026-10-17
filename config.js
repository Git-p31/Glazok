"use strict";

/*
 * Общие настройки Glazok. Подключается во всех страницах перед основным скриптом.
 */
window.GLAZOK = {
  /* ВАЖНО: ключи TURN лежат в публичном репозитории. Перевыпустите их в панели Metered
     и по возможности выдавайте временные ключи с сервера. */
  ICE_SERVERS: [
    { urls: "stun:stun.relay.metered.ca:80" },
    { urls: "turn:standard.relay.metered.ca:80", username: "35162de63b0eb72fbb27f4e3", credential: "ZbW2aJl3WmRUyOss" },
    { urls: "turn:standard.relay.metered.ca:80?transport=tcp", username: "35162de63b0eb72fbb27f4e3", credential: "ZbW2aJl3WmRUyOss" },
    { urls: "turn:standard.relay.metered.ca:443", username: "35162de63b0eb72fbb27f4e3", credential: "ZbW2aJl3WmRUyOss" },
    { urls: "turns:standard.relay.metered.ca:443?transport=tcp", username: "35162de63b0eb72fbb27f4e3", credential: "ZbW2aJl3WmRUyOss" }
  ],

  /* Свой PeerServer (надёжнее публичного облака). Пример:
     { host: "peer.example.com", port: 443, path: "/", secure: true }
     null — использовать облачный сервер PeerJS. */
  PEER_SERVER: null,

  /* Битрейт, с которым монитор пересылает видео на «Чистый вывод» (OBS), бит/с */
  VIEWER_BITRATE: 15000000,

  peerOptions() {
    const options = { config: { iceServers: this.ICE_SERVERS, sdpSemantics: "unified-plan" } };
    if (this.PEER_SERVER) Object.assign(options, this.PEER_SERVER);
    return options;
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
