"use strict";

/* Если config.js не подключён в view.html (или не загрузился) — догружаем сам. */
(function boot() {
  const statusEl = document.getElementById("status");
  const fail = text => {
    statusEl.style.display = "block";
    statusEl.classList.remove("hidden");
    statusEl.textContent = text;
  };
  if (window.GLAZOK) return main();
  const script = document.createElement("script");
  script.src = "./config.js?v=" + Date.now();
  script.onload = () => (window.GLAZOK ? main() : fail("Ошибка: config.js повреждён"));
  script.onerror = () => fail("Не найден config.js — загрузите его в репозиторий рядом с view.html");
  document.head.appendChild(script);
})();

function main() {

const video = document.getElementById("video");
const statusEl = document.getElementById("status");

const params = new URLSearchParams(window.location.search);
const room = (params.get("room") || "").toLowerCase();
const token = params.get("k") || "";
const wantAudio = params.get("audio") === "1";
const debug = params.get("debug") === "1";

if (params.get("fit") === "cover") video.style.objectFit = "cover";

let peer = null;
let conn = null;
let viewerId = null;
let retryTimer = null;
let hasStream = false;
let currentCall = null;

function show(text) {
  statusEl.style.display = "block";
  statusEl.classList.remove("hidden");
  statusEl.textContent = text;
}

function hide() {
  statusEl.style.display = "none";
}

function scheduleConnect(delay = 3000) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectToMonitor, delay);
}

/* Цифровое увеличение, заданное на мониторе (если у камеры нет оптического зума).
   x и y передаются долями размера окна, поэтому одинаково работают при любом разрешении. */
function applyViewTransform(t) {
  const scale = Math.min(4, Math.max(1, Number(t.scale) || 1));
  const x = (Number(t.x) || 0) * window.innerWidth;
  const y = (Number(t.y) || 0) * window.innerHeight;
  video.style.transformOrigin = "center";
  video.style.transform = scale === 1 && !x && !y ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
}

function connectToMonitor() {
  if (!peer || peer.destroyed || peer.disconnected) return;
  if (conn) { try { conn.close(); } catch {} }

  conn = peer.connect("glz-" + room, { reliable: true, metadata: { role: "viewer" } });
  const current = conn;

  current.on("open", () => {
    current.send({ type: "clean-view", viewerId, token });
    if (!hasStream) show("Ожидание видеосигнала...");
  });
  current.on("data", data => {
    if (!data) return;
    if (data.type === "denied") show("Неверная ссылка: нет ключа доступа");
    else if (data.type === "view-transform") applyViewTransform(data);
  });
  current.on("close", () => { if (conn === current) scheduleConnect(); });
  current.on("error", () => { if (conn === current) scheduleConnect(); });
}

function startPeer() {
  viewerId = "glz-view-" + GLAZOK.randomId(8);
  peer = new Peer(viewerId, GLAZOK.peerOptions());
  const p = peer;

  p.on("open", () => {
    show("Подключение к монитору...");
    connectToMonitor();
  });

  p.on("call", call => {
    /* Новый звонок заменяет старый (переключение камеры). Закрытие старого уже не гасит картинку. */
    const previous = currentCall;
    currentCall = call;
    if (previous) { try { previous.close(); } catch {} }
    call.answer(undefined, { sdpTransform: GLAZOK.sdpHighBitrate(20000, 8000, 2000) });

    call.on("stream", stream => {
      if (currentCall !== call) return;
      GLAZOK.tuneReceivers(call.peerConnection);
      video.srcObject = stream;
      video.muted = !wantAudio;
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
      hasStream = true;
      hide();
      if (debug) startDebug(call);
    });

    call.on("close", () => {
      if (currentCall !== call) return;
      currentCall = null;
      hasStream = false;
      show("Трансляция завершена");
      video.srcObject = null;
    });
  });

  p.on("disconnected", () => {
    if (peer !== p) return;
    setTimeout(() => {
      if (peer === p && !p.destroyed && p.disconnected) {
        try { p.reconnect(); } catch { restartPeer(); }
      }
    }, 1000);
  });

  p.on("error", err => {
    if (peer !== p) return;
    console.error("Peer error:", err);
    if (err.type === "peer-unavailable") {
      show("Ожидание монитора...");
      scheduleConnect();
    } else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
      show("Нет связи, переподключение...");
      setTimeout(() => {
        if (peer !== p) return;
        if (p.destroyed) restartPeer();
        else { try { p.reconnect(); } catch { restartPeer(); } }
      }, 3000);
    } else {
      show("Ошибка соединения");
    }
  });
}

function restartPeer() {
  if (peer) { const old = peer; peer = null; try { old.destroy(); } catch {} }
  startPeer();
}

/* ?debug=1 — показывает, что реально приходит: разрешение, fps, битрейт, причина ограничения */
function startDebug(call) {
  let box = document.getElementById("debug");
  if (!box) {
    box = document.createElement("div");
    box.id = "debug";
    box.style.cssText = "position:fixed;left:8px;top:8px;z-index:20;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.7);color:#0f0;font:12px monospace;white-space:pre;pointer-events:none";
    document.body.appendChild(box);
  }
  let prev = null;
  const timer = setInterval(async () => {
    const pc = call.peerConnection;
    if (!pc || pc.connectionState === "closed") { clearInterval(timer); return; }
    const reports = await pc.getStats();
    reports.forEach(r => {
      if (r.type === "inbound-rtp" && r.kind === "video") {
        const kbps = prev ? Math.round((r.bytesReceived - prev.b) * 8 / ((r.timestamp - prev.t) / 1000) / 1000) : 0;
        prev = { b: r.bytesReceived, t: r.timestamp };
        box.textContent = `${r.frameWidth}×${r.frameHeight} @ ${Math.round(r.framesPerSecond || 0)} fps\n${kbps} кбит/с`
          + `\nпотери: ${r.packetsLost || 0}  кадров потеряно: ${r.framesDropped || 0}`;
      }
    });
  }, 1000);
}

/* Двойной клик — полный экран. Первый клик включает звук, если он запрошен (?audio=1). */
document.addEventListener("dblclick", () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});
if (wantAudio) {
  const unmute = () => { video.muted = false; video.play().catch(() => {}); };
  document.addEventListener("pointerdown", unmute, { once: true });
  document.addEventListener("keydown", unmute, { once: true });
}

if (!room) {
  show("Не указан код комнаты");
} else {
  show("Подключение к монитору...");
  GLAZOK.initIce().then(startPeer);   // сначала получаем данные TURN, потом создаём Peer
}

window.addEventListener("beforeunload", () => {
  if (peer) try { peer.destroy(); } catch {}
});
}
