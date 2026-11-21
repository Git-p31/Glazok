"use strict";
// Запись кадров в общую память виртуальной камеры. Формат — windows/vcam/shared.h (менять вместе).
const koffi = require("koffi");

const MAGIC = 0x4b5a4c47;
const VERSION = 1;
const MAX_W = 3840;
const MAX_H = 2160;
const FRAME_BYTES = MAX_W * MAX_H * 4;
const HEADER_BYTES = 64;
const MAP_BYTES = HEADER_BYTES + 2 * FRAME_BYTES;
const FMT_BGRA = 0;
const FMT_RGBA = 1;

// смещения полей GlzHeader (uint32)
const H = { magic: 0, version: 4, width: 8, height: 12, format: 16, front: 20, seq: 24, writerPid: 28, rotation: 32, heartbeat: 36 };

const kernel32 = koffi.load("kernel32.dll");
const INVALID_HANDLE_VALUE = -1;
const PAGE_READWRITE = 0x04;
const FILE_MAP_ALL_ACCESS = 0xf001f;
const CreateFileMappingW = kernel32.func("__stdcall", "CreateFileMappingW", "intptr_t", ["intptr_t", "void *", "uint32_t", "uint32_t", "uint32_t", "str16"]);
const MapViewOfFile = kernel32.func("__stdcall", "MapViewOfFile", "uintptr_t", ["intptr_t", "uint32_t", "uint32_t", "uint32_t", "size_t"]);
const UnmapViewOfFile = kernel32.func("__stdcall", "UnmapViewOfFile", "int", ["uintptr_t"]);
const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int", ["intptr_t"]);
const RtlMoveMemory = kernel32.func("__stdcall", "RtlMoveMemory", "void", ["uintptr_t", "void *", "size_t"]);
const GetLastError = kernel32.func("__stdcall", "GetLastError", "uint32_t", []);

class VCamWriter {
  constructor(index) {
    this.index = index;
    this.handle = CreateFileMappingW(INVALID_HANDLE_VALUE, null, PAGE_READWRITE, 0, MAP_BYTES, "GlazokVCam_" + index);
    if (!this.handle) throw new Error("CreateFileMapping failed: " + GetLastError());
    this.base = Number(MapViewOfFile(this.handle, FILE_MAP_ALL_ACCESS, 0, 0, MAP_BYTES));
    if (!this.base) throw new Error("MapViewOfFile failed: " + GetLastError());
    this.front = 0;
    this.seq = 0;
    this.beat = 0;
    this.u32 = new Uint32Array(1);
    this.put(H.magic, MAGIC);
    this.put(H.version, VERSION);
    this.put(H.writerPid, process.pid);
    this.put(H.front, 0);
    this.timer = setInterval(() => this.heartbeat(), 500);
    this.heartbeat();
  }

  put(offset, value) {
    this.u32[0] = value >>> 0;
    RtlMoveMemory(this.base + offset, this.u32, 4);
  }

  heartbeat() {
    this.beat = (this.beat + 1) >>> 0 || 1;
    this.put(H.heartbeat, this.beat);
  }

  /** Кадр сверху вниз, без отступов. pixels — Uint8Array длиной width*height*4. */
  write(pixels, width, height, format = FMT_BGRA, rotation = 0) {
    if (width < 1 || height < 1 || width > MAX_W || height > MAX_H) return false;
    const len = width * height * 4;
    if (pixels.byteLength < len) return false;
    const back = this.front ^ 1;
    RtlMoveMemory(this.base + HEADER_BYTES + back * FRAME_BYTES, pixels, len);
    this.put(H.width, width);
    this.put(H.height, height);
    this.put(H.format, format);
    this.put(H.rotation, rotation);
    this.put(H.front, back);
    this.front = back;
    this.seq = (this.seq + 1) >>> 0 || 1;
    this.put(H.seq, this.seq);
    return true;
  }

  close() {
    clearInterval(this.timer);
    if (this.base) UnmapViewOfFile(this.base);
    if (this.handle) CloseHandle(this.handle);
    this.base = 0;
    this.handle = 0;
  }
}

module.exports = { VCamWriter, FMT_BGRA, FMT_RGBA, MAX_W, MAX_H };
