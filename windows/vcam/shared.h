// Общая память между приложением Glazok Studio (пишет кадры) и виртуальной камерой (читает).
// Тот же формат описан в windows/app/vcam.js — менять оба места вместе.
#pragma once
#include <stdint.h>

#define GLZ_MAGIC        0x4B5A4C47u   // "GLZK"
#define GLZ_VERSION      1u
#define GLZ_MAX_W        3840u
#define GLZ_MAX_H        2160u
#define GLZ_FRAME_BYTES  (GLZ_MAX_W * GLZ_MAX_H * 4u)
#define GLZ_HEADER_BYTES 64u
#define GLZ_MAP_BYTES    (GLZ_HEADER_BYTES + 2u * GLZ_FRAME_BYTES)
#define GLZ_CAMERAS      5               // 0 = Program, 1..4 = Cam 1..4

#define GLZ_FMT_BGRA 0u
#define GLZ_FMT_RGBA 1u

// Кадр хранится сверху вниз, без отступов: stride = width * 4.
// Без свежих кадров, но с живым heartbeat камера показывает чёрный кадр (приложение открыто, эфира нет);
// без heartbeat — заставку «нет сигнала».
// Писатель кладёт кадр в буфер (front ^ 1), затем пишет width/height/format, меняет front и увеличивает seq.
#pragma pack(push, 4)
struct GlzHeader {
    uint32_t magic;
    uint32_t version;
    uint32_t width;
    uint32_t height;
    uint32_t format;
    volatile uint32_t front;   // 0 или 1 — буфер с последним целым кадром
    volatile uint32_t seq;     // растёт на 1 с каждым кадром
    uint32_t writerPid;
    uint32_t rotation;          // 0/90/180/270 — повернуть кадр по часовой при выводе
    volatile uint32_t heartbeat; // приложение увеличивает каждые ~0,5 с, пока запущено
    uint32_t reserved[6];
};
#pragma pack(pop)

static_assert(sizeof(GlzHeader) <= GLZ_HEADER_BYTES, "header too big");

// Имя объекта общей памяти: GlazokVCam_0 ... GlazokVCam_4 (в пространстве имён сеанса пользователя)
inline void GlzMapName(int index, wchar_t* out, size_t cch) {
    swprintf_s(out, cch, L"GlazokVCam_%d", index);
}
