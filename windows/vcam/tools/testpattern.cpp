// Пишет в общую память камеры движущуюся тестовую картинку (для проверки драйвера без приложения).
// glazok-testpattern.exe [номер камеры 0..4] [ширина] [высота] [секунд] [поворот 0/90/180/270]
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include "../shared.h"

int wmain(int argc, wchar_t** argv) {
    const int index = argc > 1 ? _wtoi(argv[1]) : 0;
    const int w = argc > 2 ? _wtoi(argv[2]) : 1080;
    const int h = argc > 3 ? _wtoi(argv[3]) : 1920;
    const int seconds = argc > 4 ? _wtoi(argv[4]) : 30;
    wchar_t name[64];
    GlzMapName(index, name, 64);
    HANDLE map = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, GLZ_MAP_BYTES, name);
    if (!map) { printf("CreateFileMapping failed %lu\n", GetLastError()); return 1; }
    BYTE* base = (BYTE*)MapViewOfFile(map, FILE_MAP_ALL_ACCESS, 0, 0, GLZ_MAP_BYTES);
    if (!base) { printf("MapViewOfFile failed %lu\n", GetLastError()); return 1; }
    GlzHeader* hdr = (GlzHeader*)base;
    hdr->magic = GLZ_MAGIC;
    hdr->version = GLZ_VERSION;
    hdr->writerPid = GetCurrentProcessId();
    hdr->rotation = argc > 5 ? _wtoi(argv[5]) : 0;
    printf("writing %dx%d to %ls for %d s\n", w, h, name, seconds);

    const DWORD end = GetTickCount() + seconds * 1000;
    for (int n = 0; GetTickCount() < end; n++) {
        const uint32_t back = (hdr->front & 1u) ^ 1u;
        BYTE* px = base + GLZ_HEADER_BYTES + (size_t)back * GLZ_FRAME_BYTES;
        const int bar = (n * 8) % w;
        for (int y = 0; y < h; y++) {
            BYTE* row = px + (size_t)y * w * 4;
            for (int x = 0; x < w; x++) {
                BYTE* p = row + x * 4;
                const int band = x * 7 / w;   // цветные полосы
                static const BYTE c[7][3] = { {255,255,255},{0,255,255},{255,255,0},{0,255,0},{255,0,255},{0,0,255},{255,0,0} };
                p[0] = c[band][0]; p[1] = c[band][1]; p[2] = c[band][2]; p[3] = 255;
                if (y < h / 6 && x < w / 6) { p[0] = 0; p[1] = 0; p[2] = 255; }   // красный угол — видно поворот
                if (abs(x - bar) < 12 || y < 8 || y >= h - 8 || x < 8 || x >= w - 8) { p[0] = p[1] = p[2] = 0; }
            }
        }
        hdr->width = w; hdr->height = h; hdr->format = GLZ_FMT_BGRA;
        MemoryBarrier();
        hdr->front = back;
        InterlockedIncrement((volatile LONG*)&hdr->seq);
        InterlockedIncrement((volatile LONG*)&hdr->heartbeat);
        Sleep(33);
    }
    UnmapViewOfFile(base);
    CloseHandle(map);
    return 0;
}
