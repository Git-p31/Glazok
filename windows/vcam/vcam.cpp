// Glazok Virtual Camera — источник DirectShow.
// Регистрирует камеры «Glazok Program» и «Glazok Cam 1…4». Кадры берёт из общей памяти (shared.h),
// которую заполняет приложение Glazok Studio. Без сигнала показывает заставку.
#include <streams.h>
#include <initguid.h>
#include <dvdmedia.h>
#include <stdio.h>
#include <math.h>
#include <vector>
#include "shared.h"

// объявлены в baseclasses/dllsetup.cpp
STDAPI AMovieSetupRegisterServer(CLSID, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR);
STDAPI AMovieSetupUnregisterServer(CLSID);

// {6B3D3F10-9C1E-4D7A-8A54-2F1B0C7E4A00} … 04
DEFINE_GUID(CLSID_GlazokCam0, 0x6b3d3f10, 0x9c1e, 0x4d7a, 0x8a, 0x54, 0x2f, 0x1b, 0x0c, 0x7e, 0x4a, 0x00);
DEFINE_GUID(CLSID_GlazokCam1, 0x6b3d3f10, 0x9c1e, 0x4d7a, 0x8a, 0x54, 0x2f, 0x1b, 0x0c, 0x7e, 0x4a, 0x01);
DEFINE_GUID(CLSID_GlazokCam2, 0x6b3d3f10, 0x9c1e, 0x4d7a, 0x8a, 0x54, 0x2f, 0x1b, 0x0c, 0x7e, 0x4a, 0x02);
DEFINE_GUID(CLSID_GlazokCam3, 0x6b3d3f10, 0x9c1e, 0x4d7a, 0x8a, 0x54, 0x2f, 0x1b, 0x0c, 0x7e, 0x4a, 0x03);
DEFINE_GUID(CLSID_GlazokCam4, 0x6b3d3f10, 0x9c1e, 0x4d7a, 0x8a, 0x54, 0x2f, 0x1b, 0x0c, 0x7e, 0x4a, 0x04);

static const GUID* const kClsids[GLZ_CAMERAS] = {
    &CLSID_GlazokCam0, &CLSID_GlazokCam1, &CLSID_GlazokCam2, &CLSID_GlazokCam3, &CLSID_GlazokCam4,
};
static const wchar_t* const kNames[GLZ_CAMERAS] = {
    L"Glazok Program", L"Glazok Cam 1", L"Glazok Cam 2", L"Glazok Cam 3", L"Glazok Cam 4",
};

struct Mode { int w, h; };
static const Mode kModes[] = { {1920, 1080}, {1280, 720}, {3840, 2160} };
static const int kModeCount = sizeof(kModes) / sizeof(kModes[0]);
static const REFERENCE_TIME kDefaultFrame = UNITS / 30;
static const REFERENCE_TIME kMinFrame = UNITS / 60;
static const REFERENCE_TIME kMaxFrame = UNITS / 5;

// ---------------------------------------------------------------- чтение кадров из общей памяти
class FrameReader {
public:
    explicit FrameReader(int index) : m_index(index) {}
    ~FrameReader() { Close(); }

    enum Result { NoApp, Idle, Frame };

    // Рисует последний кадр в dst (BGRA, вписан с полями).
    // Idle — приложение открыто, но кадров нет (dst залит чёрным); NoApp — приложения нет.
    Result Render(BYTE* dst, int dw, int dh, bool bottomUp) {
        if (!m_hdr && !Open()) return NoApp;
        if (m_hdr->magic != GLZ_MAGIC || m_hdr->version != GLZ_VERSION) return NoApp;

        const DWORD now = GetTickCount();
        const uint32_t seq = m_hdr->seq, beat = m_hdr->heartbeat;
        if (seq != m_lastSeq) { m_lastSeq = seq; m_lastChange = now; }
        if (beat != m_lastBeat) { m_lastBeat = beat; m_lastBeatChange = now; }
        const bool appAlive = beat != 0 && now - m_lastBeatChange < 3000;
        const bool fresh = seq != 0 && now - m_lastChange < 2000;

        // Кадр сначала копируем к себе: если за время копирования писатель успел записать два новых кадра,
        // наш буфер мог быть перезаписан — копируем заново (иначе на картинке «разрыв»).
        uint32_t sw = 0, sh = 0, fmt = 0, rot = 0;
        bool copied = false;
        if (fresh) {
            for (int attempt = 0; attempt < 3 && !copied; attempt++) {
                const uint32_t seqBefore = m_hdr->seq;
                MemoryBarrier();
                sw = m_hdr->width; sh = m_hdr->height; fmt = m_hdr->format; rot = m_hdr->rotation;
                const uint32_t front = m_hdr->front & 1u;
                if (sw == 0 || sh == 0 || sw > GLZ_MAX_W || sh > GLZ_MAX_H) break;
                const size_t bytes = (size_t)sw * sh * 4;
                if (m_copy.size() < bytes) m_copy.resize(bytes);
                memcpy(m_copy.data(), m_base + GLZ_HEADER_BYTES + (size_t)front * GLZ_FRAME_BYTES, bytes);
                MemoryBarrier();
                copied = m_hdr->seq - seqBefore < 2;
            }
        }
        if (!copied) {
            if (!appAlive) return NoApp;
            memset(dst, 0, (size_t)dw * dh * 4);
            for (size_t i = 3; i < (size_t)dw * dh * 4; i += 4) dst[i] = 255;
            return Idle;
        }
        const BYTE* src = m_copy.data();
        if (rot == 90 || rot == 180 || rot == 270) ScaleRotated(src, (int)sw, (int)sh, (int)rot, fmt == GLZ_FMT_RGBA, dst, dw, dh, bottomUp);
        else Scale(src, (int)sw, (int)sh, fmt == GLZ_FMT_RGBA, dst, dw, dh, bottomUp);
        return Frame;
    }

private:
    bool Open() {
        const DWORD now = GetTickCount();
        if (m_lastTry && now - m_lastTry < 1000) return false;
        m_lastTry = now;
        wchar_t name[64];
        GlzMapName(m_index, name, 64);
        m_map = OpenFileMappingW(FILE_MAP_READ, FALSE, name);
        if (!m_map) return false;
        m_base = (BYTE*)MapViewOfFile(m_map, FILE_MAP_READ, 0, 0, GLZ_MAP_BYTES);
        if (!m_base) { CloseHandle(m_map); m_map = nullptr; return false; }
        m_hdr = (const GlzHeader*)m_base;
        return true;
    }
    void Close() {
        if (m_base) UnmapViewOfFile(m_base);
        if (m_map) CloseHandle(m_map);
        m_base = nullptr; m_map = nullptr; m_hdr = nullptr;
    }

    // Вписывает кадр в выходной размер с сохранением пропорций (поля чёрные), билинейно.
    void Scale(const BYTE* src, int sw, int sh, bool rgba, BYTE* dst, int dw, int dh, bool bottomUp) {
        double k = (double)dw / sw < (double)dh / sh ? (double)dw / sw : (double)dh / sh;
        int ow = (int)(sw * k + 0.5), oh = (int)(sh * k + 0.5);
        if (ow > dw) ow = dw;
        if (oh > dh) oh = dh;
        if (ow < 1) ow = 1;
        if (oh < 1) oh = 1;
        const int ox = (dw - ow) / 2, oy = (dh - oh) / 2;
        const size_t dstride = (size_t)dw * 4, sstride = (size_t)sw * 4;

        if (m_cacheKey[0] != sw || m_cacheKey[1] != sh || m_cacheKey[2] != ow || m_cacheKey[3] != oh) {
            m_cacheKey[0] = sw; m_cacheKey[1] = sh; m_cacheKey[2] = ow; m_cacheKey[3] = oh;
            m_x0.resize(ow); m_xw.resize(ow);
            for (int x = 0; x < ow; x++) {
                double fx = (x + 0.5) * sw / ow - 0.5;
                if (fx < 0) fx = 0;
                int ix = (int)fx;
                if (ix >= sw - 1) { ix = sw - 1; fx = ix; }
                m_x0[x] = ix;
                m_xw[x] = (int)((fx - ix) * 256);
            }
        }

        for (int y = 0; y < dh; y++) {
            BYTE* row = dst + (size_t)(bottomUp ? dh - 1 - y : y) * dstride;
            if (y < oy || y >= oy + oh) { memset(row, 0, dstride); continue; }
            if (ox > 0) memset(row, 0, (size_t)ox * 4);
            if (ox + ow < dw) memset(row + (size_t)(ox + ow) * 4, 0, (size_t)(dw - ox - ow) * 4);
            BYTE* d = row + (size_t)ox * 4;
            const int ty = y - oy;

            if (ow == sw && oh == sh) {   // размер совпадает — просто копия
                const BYTE* s = src + (size_t)ty * sstride;
                if (!rgba) memcpy(d, s, sstride);
                else for (int x = 0; x < ow; x++, s += 4, d += 4) { d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255; }
                continue;
            }

            double fy = (ty + 0.5) * sh / oh - 0.5;
            if (fy < 0) fy = 0;
            int iy = (int)fy;
            if (iy >= sh - 1) { iy = sh - 1; fy = iy; }
            const int wy = (int)((fy - iy) * 256);
            const BYTE* r0 = src + (size_t)iy * sstride;
            const BYTE* r1 = iy + 1 < sh ? r0 + sstride : r0;
            const int bi = rgba ? 2 : 0, ri = rgba ? 0 : 2;
            for (int x = 0; x < ow; x++, d += 4) {
                const int ix = m_x0[x], wx = m_xw[x];
                const int ix1 = ix + 1 < sw ? ix + 1 : ix;
                const BYTE* a = r0 + ix * 4; const BYTE* b = r0 + ix1 * 4;
                const BYTE* c = r1 + ix * 4; const BYTE* e = r1 + ix1 * 4;
                for (int ch = 0; ch < 3; ch++) {
                    const int si = ch == 0 ? bi : ch == 1 ? 1 : ri;
                    const int top = a[si] * (256 - wx) + b[si] * wx;
                    const int bot = c[si] * (256 - wx) + e[si] * wx;
                    d[ch] = (BYTE)((top * (256 - wy) + bot * wy) >> 16);
                }
                d[3] = 255;
            }
        }
    }

    // То же, но кадр сначала поворачивается на rot° по часовой (телефон прислал кадр с пометкой поворота).
    void ScaleRotated(const BYTE* src, int sw, int sh, int rot, bool rgba, BYTE* dst, int dw, int dh, bool bottomUp) {
        const int rw = rot == 180 ? sw : sh, rh = rot == 180 ? sh : sw;   // размер после поворота
        double k = (double)dw / rw < (double)dh / rh ? (double)dw / rw : (double)dh / rh;
        int ow = (int)(rw * k + 0.5), oh = (int)(rh * k + 0.5);
        if (ow > dw) ow = dw;
        if (oh > dh) oh = dh;
        if (ow < 1) ow = 1;
        if (oh < 1) oh = 1;
        const int ox = (dw - ow) / 2, oy = (dh - oh) / 2;
        const size_t dstride = (size_t)dw * 4, sstride = (size_t)sw * 4;
        const int bi = rgba ? 2 : 0, ri = rgba ? 0 : 2;
        const int idx[3] = { bi, 1, ri };

        for (int y = 0; y < dh; y++) {
            BYTE* row = dst + (size_t)(bottomUp ? dh - 1 - y : y) * dstride;
            if (y < oy || y >= oy + oh) { memset(row, 0, dstride); continue; }
            if (ox > 0) memset(row, 0, (size_t)ox * 4);
            if (ox + ow < dw) memset(row + (size_t)(ox + ow) * 4, 0, (size_t)(dw - ox - ow) * 4);
            BYTE* d = row + (size_t)ox * 4;
            const double v = (y - oy + 0.5) * rh / oh - 0.5;   // координата в повёрнутом кадре
            for (int x = 0; x < ow; x++, d += 4) {
                const double u = (x + 0.5) * rw / ow - 0.5;
                double fx, fy;   // координата в исходном кадре
                if (rot == 90)       { fx = v;               fy = sh - 1 - u; }
                else if (rot == 180) { fx = sw - 1 - u;      fy = sh - 1 - v; }
                else                 { fx = sw - 1 - v;      fy = u; }
                if (fx < 0) fx = 0; if (fy < 0) fy = 0;
                if (fx > sw - 1) fx = sw - 1; if (fy > sh - 1) fy = sh - 1;
                const int ix = (int)fx, iy = (int)fy;
                const int ix1 = ix + 1 < sw ? ix + 1 : ix, iy1 = iy + 1 < sh ? iy + 1 : iy;
                const int wx = (int)((fx - ix) * 256), wy = (int)((fy - iy) * 256);
                const BYTE* a = src + (size_t)iy * sstride + ix * 4;
                const BYTE* b = src + (size_t)iy * sstride + ix1 * 4;
                const BYTE* c = src + (size_t)iy1 * sstride + ix * 4;
                const BYTE* e = src + (size_t)iy1 * sstride + ix1 * 4;
                for (int ch = 0; ch < 3; ch++) {
                    const int si = idx[ch];
                    const int top = a[si] * (256 - wx) + b[si] * wx;
                    const int bot = c[si] * (256 - wx) + e[si] * wx;
                    d[ch] = (BYTE)((top * (256 - wy) + bot * wy) >> 16);
                }
                d[3] = 255;
            }
        }
    }

    int m_index;
    std::vector<BYTE> m_copy;
    uint32_t m_lastBeat = 0;
    DWORD m_lastBeatChange = 0;
    HANDLE m_map = nullptr;
    BYTE* m_base = nullptr;
    const GlzHeader* m_hdr = nullptr;
    DWORD m_lastTry = 0;
    uint32_t m_lastSeq = 0;
    DWORD m_lastChange = 0;
    int m_cacheKey[4] = { 0, 0, 0, 0 };
    std::vector<int> m_x0, m_xw;
};

// ---------------------------------------------------------------- заставка «нет сигнала»
class Placeholder {
public:
    void Render(int index, BYTE* dst, int w, int h, bool bottomUp) {
        if (w != m_w || h != m_h || m_pixels.empty()) Build(index, w, h);
        const size_t stride = (size_t)w * 4;
        for (int y = 0; y < h; y++)
            memcpy(dst + (size_t)(bottomUp ? h - 1 - y : y) * stride, m_pixels.data() + (size_t)y * stride, stride);
    }
private:
    void Build(int index, int w, int h) {
        m_w = w; m_h = h;
        m_pixels.assign((size_t)w * h * 4, 0);
        BITMAPINFO bi = {};
        bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;   // сверху вниз
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        void* bits = nullptr;
        HDC dc = CreateCompatibleDC(nullptr);
        HBITMAP bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
        if (!dc || !bmp || !bits) { if (bmp) DeleteObject(bmp); if (dc) DeleteDC(dc); return; }
        HGDIOBJ oldBmp = SelectObject(dc, bmp);

        RECT all = { 0, 0, w, h };
        HBRUSH bg = CreateSolidBrush(RGB(17, 19, 24));
        FillRect(dc, &all, bg);
        DeleteObject(bg);
        SetBkMode(dc, TRANSPARENT);

        HFONT big = CreateFontW(-h / 14, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        HFONT smallFont = CreateFontW(-h / 30, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
        HGDIOBJ oldFont = SelectObject(dc, big);
        SetTextColor(dc, RGB(235, 238, 245));
        RECT r1 = { 0, h / 2 - h / 10, w, h / 2 };
        DrawTextW(dc, kNames[index], -1, &r1, DT_CENTER | DT_BOTTOM | DT_SINGLELINE);
        SelectObject(dc, smallFont);
        SetTextColor(dc, RGB(140, 146, 160));
        RECT r2 = { 0, h / 2 + h / 40, w, h / 2 + h / 8 };
        DrawTextW(dc, L"Нет сигнала — откройте Glazok Studio", -1, &r2, DT_CENTER | DT_TOP | DT_SINGLELINE);
        SelectObject(dc, oldFont);
        DeleteObject(big);
        DeleteObject(smallFont);

        GdiFlush();
        memcpy(m_pixels.data(), bits, m_pixels.size());
        for (size_t i = 3; i < m_pixels.size(); i += 4) m_pixels[i] = 255;
        SelectObject(dc, oldBmp);
        DeleteObject(bmp);
        DeleteDC(dc);
    }
    int m_w = 0, m_h = 0;
    std::vector<BYTE> m_pixels;
};

// ---------------------------------------------------------------- пин
static void FillMediaType(CMediaType* pmt, int w, int h, REFERENCE_TIME frame) {
    VIDEOINFOHEADER* vih = (VIDEOINFOHEADER*)pmt->AllocFormatBuffer(sizeof(VIDEOINFOHEADER));
    ZeroMemory(vih, sizeof(VIDEOINFOHEADER));
    vih->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    vih->bmiHeader.biWidth = w;
    vih->bmiHeader.biHeight = h;
    vih->bmiHeader.biPlanes = 1;
    vih->bmiHeader.biBitCount = 32;
    vih->bmiHeader.biCompression = BI_RGB;
    vih->bmiHeader.biSizeImage = (DWORD)w * h * 4;
    vih->AvgTimePerFrame = frame;
    vih->dwBitRate = (DWORD)((double)vih->bmiHeader.biSizeImage * 8 * UNITS / frame);
    SetRectEmpty(&vih->rcSource);
    SetRectEmpty(&vih->rcTarget);
    pmt->SetType(&MEDIATYPE_Video);
    pmt->SetSubtype(&MEDIASUBTYPE_RGB32);
    pmt->SetFormatType(&FORMAT_VideoInfo);
    pmt->SetTemporalCompression(FALSE);
    pmt->SetSampleSize(vih->bmiHeader.biSizeImage);
}

class GlazokStream : public CSourceStream, public IAMStreamConfig, public IKsPropertySet {
public:
    GlazokStream(HRESULT* phr, CSource* filter, int index)
        : CSourceStream(NAME("Glazok Stream"), phr, filter, L"Capture"), m_index(index), m_reader(index) {
        GetMediaType(0, &m_mt);
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override { return GetOwner()->QueryInterface(riid, ppv); }
    STDMETHODIMP_(ULONG) AddRef() override { return GetOwner()->AddRef(); }
    STDMETHODIMP_(ULONG) Release() override { return GetOwner()->Release(); }
    STDMETHODIMP NonDelegatingQueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IAMStreamConfig) return GetInterface((IAMStreamConfig*)this, ppv);
        if (riid == IID_IKsPropertySet) return GetInterface((IKsPropertySet*)this, ppv);
        return CSourceStream::NonDelegatingQueryInterface(riid, ppv);
    }

    STDMETHODIMP Notify(IBaseFilter*, Quality) override { return E_NOTIMPL; }

    // ---- форматы
    HRESULT GetMediaType(int pos, CMediaType* pmt) override {
        if (pos < 0) return E_INVALIDARG;
        if (pos >= kModeCount) return VFW_S_NO_MORE_ITEMS;
        if (pos == 0 && m_formatSet) { *pmt = m_mt; return S_OK; }   // формат, выбранный программой через SetFormat
        FillMediaType(pmt, kModes[pos].w, kModes[pos].h, kDefaultFrame);
        return S_OK;
    }
    HRESULT CheckMediaType(const CMediaType* pmt) override {
        if (!pmt || *pmt->Type() != MEDIATYPE_Video || *pmt->Subtype() != MEDIASUBTYPE_RGB32) return E_INVALIDARG;
        if (*pmt->FormatType() != FORMAT_VideoInfo || !pmt->Format() || pmt->FormatLength() < sizeof(VIDEOINFOHEADER))
            return E_INVALIDARG;
        const VIDEOINFOHEADER* vih = (const VIDEOINFOHEADER*)pmt->Format();
        const int w = vih->bmiHeader.biWidth, h = abs(vih->bmiHeader.biHeight);
        if (vih->bmiHeader.biBitCount != 32) return E_INVALIDARG;
        for (int i = 0; i < kModeCount; i++)
            if (kModes[i].w == w && kModes[i].h == h) return S_OK;
        return E_INVALIDARG;
    }
    HRESULT DecideBufferSize(IMemAllocator* alloc, ALLOCATOR_PROPERTIES* req) override {
        CAutoLock lock(m_pFilter->pStateLock());
        const VIDEOINFOHEADER* vih = (const VIDEOINFOHEADER*)m_mt.Format();
        req->cBuffers = req->cBuffers < 2 ? 2 : req->cBuffers;
        req->cbBuffer = vih->bmiHeader.biSizeImage;
        if (req->cbAlign < 1) req->cbAlign = 1;
        ALLOCATOR_PROPERTIES actual;
        HRESULT hr = alloc->SetProperties(req, &actual);
        if (FAILED(hr)) return hr;
        return actual.cbBuffer < req->cbBuffer ? E_FAIL : S_OK;
    }

    // ---- поток кадров
    HRESULT OnThreadCreate() override {
        m_frameNo = 0;
        QueryPerformanceFrequency(&m_freq);
        QueryPerformanceCounter(&m_start);
        return S_OK;
    }
    HRESULT FillBuffer(IMediaSample* sample) override {
        const VIDEOINFOHEADER* vih = (const VIDEOINFOHEADER*)m_mt.Format();
        const int w = vih->bmiHeader.biWidth, h = abs(vih->bmiHeader.biHeight);
        const bool bottomUp = vih->bmiHeader.biHeight > 0;
        REFERENCE_TIME frame = vih->AvgTimePerFrame;
        if (frame < kMinFrame || frame > kMaxFrame) frame = kDefaultFrame;

        // темп: кадр каждые frame (100 нс) по реальным часам
        const LONGLONG due = m_start.QuadPart + (LONGLONG)((double)m_freq.QuadPart * (m_frameNo * frame) / UNITS);
        for (;;) {
            LARGE_INTEGER now; QueryPerformanceCounter(&now);
            const LONGLONG left = due - now.QuadPart;
            if (left <= 0) {
                if (-left > m_freq.QuadPart / 2) QueryPerformanceCounter(&m_start), m_frameNo = 0;  // отстали — сброс
                break;
            }
            const DWORD ms = (DWORD)(left * 1000 / m_freq.QuadPart);
            Sleep(ms > 1 ? ms - 1 : 0);
        }

        BYTE* dst = nullptr;
        HRESULT hr = sample->GetPointer(&dst);
        if (FAILED(hr)) return hr;
        const long need = (long)w * h * 4;
        if (sample->GetSize() < need) return E_FAIL;
        if (m_reader.Render(dst, w, h, bottomUp) == FrameReader::NoApp) m_placeholder.Render(m_index, dst, w, h, bottomUp);

        REFERENCE_TIME start = m_frameNo * frame, stop = start + frame;
        CRefTime streamTime;
        if (m_pFilter->StreamTime(streamTime) == S_OK) { start = streamTime; stop = start + frame; }
        sample->SetTime(&start, &stop);
        sample->SetActualDataLength(need);
        sample->SetSyncPoint(TRUE);
        sample->SetDiscontinuity(m_frameNo == 0);
        m_frameNo++;
        return S_OK;
    }

    // ---- IAMStreamConfig
    STDMETHODIMP SetFormat(AM_MEDIA_TYPE* pmt) override {
        if (!pmt) return E_POINTER;
        CMediaType mt(*pmt);
        if (FAILED(CheckMediaType(&mt))) return VFW_E_INVALIDMEDIATYPE;
        VIDEOINFOHEADER* vih = (VIDEOINFOHEADER*)mt.Format();
        if (vih->AvgTimePerFrame < kMinFrame || vih->AvgTimePerFrame > kMaxFrame) vih->AvgTimePerFrame = kDefaultFrame;
        vih->bmiHeader.biSizeImage = (DWORD)vih->bmiHeader.biWidth * abs(vih->bmiHeader.biHeight) * 4;
        mt.SetSampleSize(vih->bmiHeader.biSizeImage);
        {
            CAutoLock lock(m_pFilter->pStateLock());
            if (m_pFilter->IsActive()) return VFW_E_WRONG_STATE;
            m_mt = mt;
            m_formatSet = true;
        }
        IPin* peer = nullptr;
        if (SUCCEEDED(ConnectedTo(&peer)) && peer) {
            peer->Release();
            IFilterGraph* graph = m_pFilter->GetFilterGraph();
            if (graph) graph->Reconnect(this);
        }
        return S_OK;
    }
    STDMETHODIMP GetFormat(AM_MEDIA_TYPE** ppmt) override {
        if (!ppmt) return E_POINTER;
        *ppmt = CreateMediaType(&m_mt);
        return *ppmt ? S_OK : E_OUTOFMEMORY;
    }
    STDMETHODIMP GetNumberOfCapabilities(int* count, int* size) override {
        if (!count || !size) return E_POINTER;
        *count = kModeCount;
        *size = sizeof(VIDEO_STREAM_CONFIG_CAPS);
        return S_OK;
    }
    STDMETHODIMP GetStreamCaps(int index, AM_MEDIA_TYPE** ppmt, BYTE* scc) override {
        if (!ppmt || !scc) return E_POINTER;
        if (index < 0 || index >= kModeCount) return S_FALSE;
        CMediaType mt;
        FillMediaType(&mt, kModes[index].w, kModes[index].h, kDefaultFrame);
        *ppmt = CreateMediaType(&mt);
        if (!*ppmt) return E_OUTOFMEMORY;
        VIDEO_STREAM_CONFIG_CAPS* caps = (VIDEO_STREAM_CONFIG_CAPS*)scc;
        ZeroMemory(caps, sizeof(*caps));
        const SIZE sz = { kModes[index].w, kModes[index].h };
        caps->guid = FORMAT_VideoInfo;
        caps->InputSize = sz;
        caps->MinCroppingSize = sz;
        caps->MaxCroppingSize = sz;
        caps->MinOutputSize = sz;
        caps->MaxOutputSize = sz;
        caps->MinFrameInterval = kMinFrame;
        caps->MaxFrameInterval = kMaxFrame;
        const LONG bits = sz.cx * sz.cy * 32;
        caps->MinBitsPerSecond = (LONG)((double)bits * UNITS / kMaxFrame > 0x7fffffff ? 0x7fffffff : (double)bits * UNITS / kMaxFrame);
        caps->MaxBitsPerSecond = 0x7fffffff;
        return S_OK;
    }

    // ---- IKsPropertySet: категория пина — «захват»
    STDMETHODIMP Set(REFGUID, DWORD, void*, DWORD, void*, DWORD) override { return E_NOTIMPL; }
    STDMETHODIMP Get(REFGUID set, DWORD id, void*, DWORD, void* data, DWORD cb, DWORD* returned) override {
        if (set != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
        if (id != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
        if (!data && !returned) return E_POINTER;
        if (returned) *returned = sizeof(GUID);
        if (!data) return S_OK;
        if (cb < sizeof(GUID)) return E_UNEXPECTED;
        *(GUID*)data = PIN_CATEGORY_CAPTURE;
        return S_OK;
    }
    STDMETHODIMP QuerySupported(REFGUID set, DWORD id, DWORD* support) override {
        if (set != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
        if (id != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
        if (support) *support = KSPROPERTY_SUPPORT_GET;
        return S_OK;
    }

private:
    int m_index;
    bool m_formatSet = false;
    FrameReader m_reader;
    Placeholder m_placeholder;
    LONGLONG m_frameNo = 0;
    LARGE_INTEGER m_freq = {}, m_start = {};
};

// ---------------------------------------------------------------- фильтр
class GlazokSource : public CSource, public IAMFilterMiscFlags {
public:
    static CUnknown* WINAPI Create(int index, LPUNKNOWN outer, HRESULT* phr) {
        GlazokSource* f = new GlazokSource(index, outer, phr);
        if (!f && phr) *phr = E_OUTOFMEMORY;
        return f;
    }
    DECLARE_IUNKNOWN;
    STDMETHODIMP NonDelegatingQueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IAMFilterMiscFlags) return GetInterface((IAMFilterMiscFlags*)this, ppv);
        if (riid == IID_IAMStreamConfig || riid == IID_IKsPropertySet)
            return m_paStreams[0]->QueryInterface(riid, ppv);
        return CSource::NonDelegatingQueryInterface(riid, ppv);
    }
    STDMETHODIMP_(ULONG) GetMiscFlags() override { return AM_FILTER_MISC_FLAGS_IS_SOURCE; }

private:
    GlazokSource(int index, LPUNKNOWN outer, HRESULT* phr)
        : CSource(NAME("Glazok Virtual Camera"), outer, *kClsids[index]) {
        new GlazokStream(phr, this, index);   // CSource сам хранит и удаляет пин
    }
};

template <int N>
static CUnknown* WINAPI CreateCam(LPUNKNOWN outer, HRESULT* phr) { return GlazokSource::Create(N, outer, phr); }

// ---------------------------------------------------------------- регистрация
static const AMOVIESETUP_MEDIATYPE kPinTypes = { &MEDIATYPE_Video, &MEDIASUBTYPE_RGB32 };
static const AMOVIESETUP_PIN kPin = {
    (LPWSTR)L"Capture", FALSE, TRUE, FALSE, FALSE, &CLSID_NULL, NULL, 1, &kPinTypes,
};
static const AMOVIESETUP_FILTER kFilters[GLZ_CAMERAS] = {
    { &CLSID_GlazokCam0, L"Glazok Program", MERIT_DO_NOT_USE, 1, &kPin },
    { &CLSID_GlazokCam1, L"Glazok Cam 1",   MERIT_DO_NOT_USE, 1, &kPin },
    { &CLSID_GlazokCam2, L"Glazok Cam 2",   MERIT_DO_NOT_USE, 1, &kPin },
    { &CLSID_GlazokCam3, L"Glazok Cam 3",   MERIT_DO_NOT_USE, 1, &kPin },
    { &CLSID_GlazokCam4, L"Glazok Cam 4",   MERIT_DO_NOT_USE, 1, &kPin },
};

CFactoryTemplate g_Templates[GLZ_CAMERAS] = {
    { L"Glazok Program", &CLSID_GlazokCam0, CreateCam<0>, NULL, &kFilters[0] },
    { L"Glazok Cam 1",   &CLSID_GlazokCam1, CreateCam<1>, NULL, &kFilters[1] },
    { L"Glazok Cam 2",   &CLSID_GlazokCam2, CreateCam<2>, NULL, &kFilters[2] },
    { L"Glazok Cam 3",   &CLSID_GlazokCam3, CreateCam<3>, NULL, &kFilters[3] },
    { L"Glazok Cam 4",   &CLSID_GlazokCam4, CreateCam<4>, NULL, &kFilters[4] },
};
int g_cTemplates = GLZ_CAMERAS;

static HRESULT RegisterAll(BOOL reg) {
    wchar_t path[MAX_PATH];
    if (!GetModuleFileNameW(g_hInst, path, MAX_PATH)) return HRESULT_FROM_WIN32(GetLastError());
    HRESULT hr = CoInitialize(NULL);
    const bool uninit = SUCCEEDED(hr);
    IFilterMapper2* fm = NULL;
    hr = CoCreateInstance(CLSID_FilterMapper2, NULL, CLSCTX_INPROC_SERVER, IID_IFilterMapper2, (void**)&fm);
    if (SUCCEEDED(hr)) {
        for (int i = 0; i < GLZ_CAMERAS; i++) {
            if (reg) {
                hr = AMovieSetupRegisterServer(*kClsids[i], kNames[i], path, L"Both", L"InprocServer32");
                if (FAILED(hr)) break;
                REGFILTER2 rf2 = {};
                rf2.dwVersion = 1;
                rf2.dwMerit = MERIT_DO_NOT_USE;
                rf2.cPins = 1;
                rf2.rgPins = &kPin;
                hr = fm->RegisterFilter(*kClsids[i], kNames[i], NULL, &CLSID_VideoInputDeviceCategory, kNames[i], &rf2);
                if (FAILED(hr)) break;
            } else {
                fm->UnregisterFilter(&CLSID_VideoInputDeviceCategory, kNames[i], *kClsids[i]);
                AMovieSetupUnregisterServer(*kClsids[i]);
                hr = S_OK;
            }
        }
        fm->Release();
    }
    if (uninit) CoUninitialize();
    return hr;
}

STDAPI DllRegisterServer() { return RegisterAll(TRUE); }
STDAPI DllUnregisterServer() { return RegisterAll(FALSE); }

extern "C" BOOL WINAPI DllEntryPoint(HINSTANCE, ULONG, LPVOID);
BOOL APIENTRY DllMain(HANDLE module, DWORD reason, LPVOID reserved) {
    return DllEntryPoint((HINSTANCE)module, reason, reserved);
}
