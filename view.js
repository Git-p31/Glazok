"use strict";

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

function connectToMonitor() {
  if (!peer || peer.destroyed || peer.disconnected) return;
  if (conn) { try { conn.close(); } catch {} }

  conn = peer.connect("glz-" + room, { reliable: true });
  const current = conn;

  current.on("open", () => {
    current.send({ type: "clean-view", viewerId, token });
    if (!hasStream) show("Ожидание видеосигнала...");
  });
  current.on("data", data => {
    if (data && data.type === "denied") show("Неверная ссылка: нет ключа доступа");
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
    call.answer(undefined, { sdpTransform: GLAZOK.sdpHighBitrate(20000, 8000, 2000) });

    call.on("stream", stream => {
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
  startPeer();
}

window.addEventListener("beforeunload", () => {
  if (peer) try { peer.destroy(); } catch {}
});
