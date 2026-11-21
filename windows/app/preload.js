"use strict";
// Работает рядом со страницей монитора (изолированно от её скриптов).
// Видео эфира (#video) идёт в камеру «Glazok Program», видео телефонов с назначенной камерой
// (<video data-glazok-slot="N">) — в «Glazok Cam N».
const { contextBridge } = require("electron");
const { VCamWriter, FMT_BGRA, FMT_RGBA, MAX_W, MAX_H } = require("./vcam");

const SLOTS = 4;   // Cam 1..4; 0 — Program
contextBridge.exposeInMainWorld("glazokStudio", { slots: SLOTS, version: "1.0.0" });

class Output {
  constructor(index) {
    this.index = index;
    this.name = index === 0 ? "Program" : "Cam " + index;
    this.selector = index === 0 ? "#video" : `video[data-glazok-slot="${index}"]`;
    this.pump = null;               // { id, track, reader, stopped }
    this.buffer = new Uint8Array(0);
    this.useCopyTo = true;
    this.canvas = null;
    this.ctx = null;
    this.frames = 0;
    this.lastFrames = 0;
    this.info = "";
    try { this.writer = new VCamWriter(index); }
    catch (error) { this.writer = null; console.error("[Glazok Studio] камера " + this.name + " недоступна:", error); }
  }

  async send(frame) {
    const rect = frame.visibleRect || { width: frame.displayWidth, height: frame.displayHeight };
    const w = rect.width, h = rect.height;
    if (!w || !h || w > MAX_W || h > MAX_H) return;
    const rotation = Number(frame.rotation) || 0;
    if (this.useCopyTo) {
      try {
        if (this.buffer.byteLength < w * h * 4) this.buffer = new Uint8Array(w * h * 4);
        await frame.copyTo(this.buffer, { format: "BGRA" });
        this.writer.write(this.buffer, w, h, FMT_BGRA, rotation);
        this.info = rotation === 90 || rotation === 270 ? h + "×" + w : w + "×" + h;
        return;
      } catch (error) {
        console.warn("[Glazok Studio] copyTo BGRA недоступен, перехожу на canvas:", error);
        this.useCopyTo = false;
      }
    }
    // запасной путь: canvas (поворот применяет сам)
    const dw = frame.displayWidth, dh = frame.displayHeight;
    if (!this.canvas || this.canvas.width !== dw || this.canvas.height !== dh) {
      this.canvas = new OffscreenCanvas(dw, dh);
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    this.ctx.drawImage(frame, 0, 0, dw, dh);
    const data = this.ctx.getImageData(0, 0, dw, dh).data;
    this.writer.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), dw, dh, FMT_RGBA, 0);
    this.info = dw + "×" + dh;
  }

  stop() {
    if (!this.pump) return;
    const p = this.pump;
    this.pump = null;
    p.stopped = true;
    try { p.reader.cancel(); } catch {}
    try { p.track.stop(); } catch {}
  }

  async start(sourceTrack) {
    const track = sourceTrack.clone();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const p = { id: sourceTrack.id, track, reader, stopped: false };
    this.pump = p;
    while (!p.stopped) {
      let result;
      try { result = await reader.read(); } catch { break; }
      if (result.done) break;
      const frame = result.value;
      try {
        if (!p.stopped) { await this.send(frame); this.frames++; }
      } catch (error) {
        console.error("[Glazok Studio] кадр " + this.name + " не передан:", error);
      } finally {
        frame.close();
      }
    }
    if (this.pump === p) this.pump = null;
  }

  watch() {
    if (!this.writer) return;
    const video = document.querySelector(this.selector);
    const stream = video && video.srcObject;
    const track = stream && typeof stream.getVideoTracks === "function" ? stream.getVideoTracks()[0] : null;
    const liveId = track && track.readyState === "live" ? track.id : null;
    if (liveId && this.pump && this.pump.id === liveId) return;
    if (!liveId && !this.pump) return;
    this.stop();
    if (liveId) this.start(track);
  }

  fps() {
    const fps = (this.frames - this.lastFrames) / 2;
    this.lastFrames = this.frames;
    return this.pump ? fps : 0;
  }

  close() {
    this.stop();
    if (this.writer) this.writer.close();
  }
}

const outputs = Array.from({ length: SLOTS + 1 }, (_, i) => new Output(i));

// плашка в углу: что сейчас уходит в OBS/vMix
let badge = null;
function updateBadge() {
  if (!document.body) return;
  if (!badge) {
    badge = document.createElement("div");
    badge.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 10px;border-radius:8px;" +
      "background:rgba(0,0,0,.72);color:#e8ecf4;font:12px/1.45 'Segoe UI',sans-serif;pointer-events:none;white-space:pre";
    document.body.appendChild(badge);
  }
  const lines = [];
  outputs.forEach(o => {
    const fps = o.fps();
    if (!o.writer) { if (o.index === 0) lines.push("Камера Glazok Program недоступна"); return; }
    if (fps > 0) lines.push("● Glazok " + o.name + ": " + o.info + ", " + Math.round(fps) + " к/с");
    else if (o.index === 0) lines.push("○ Glazok Program: нет эфира");
  });
  badge.textContent = lines.join("\n");
  badge.style.color = lines.some(l => l.startsWith("●")) ? "#7ee2a0" : "#e8ecf4";
}

setInterval(() => outputs.forEach(o => o.watch()), 300);
setInterval(updateBadge, 2000);
window.addEventListener("beforeunload", () => outputs.forEach(o => o.close()));
