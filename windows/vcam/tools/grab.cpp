// Проверка камер так, как их видят OBS и vMix (DirectShow):
//   glazok-grab.exe              — список камер в системе
//   glazok-grab.exe "Glazok Program" out.bmp — снять один кадр в файл
#include <windows.h>
#include <dshow.h>
#include <stdio.h>
#include <initguid.h>

DEFINE_GUID(CLSID_SampleGrabberX, 0xC1F400A0, 0x3F08, 0x11d3, 0x9F, 0x0B, 0x00, 0x60, 0x08, 0x03, 0x9E, 0x37);
DEFINE_GUID(CLSID_NullRendererX, 0xC1F400A4, 0x3F08, 0x11d3, 0x9F, 0x0B, 0x00, 0x60, 0x08, 0x03, 0x9E, 0x37);
DEFINE_GUID(IID_ISampleGrabberX, 0x6B652FFF, 0x11FE, 0x4fce, 0x92, 0xAD, 0x02, 0x66, 0xB5, 0xD7, 0xC7, 0x8F);

struct ISampleGrabberCBX : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE SampleCB(double, IMediaSample*) = 0;
    virtual HRESULT STDMETHODCALLTYPE BufferCB(double, BYTE*, long) = 0;
};
struct ISampleGrabberX : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE SetOneShot(BOOL) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetMediaType(const AM_MEDIA_TYPE*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetConnectedMediaType(AM_MEDIA_TYPE*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetBufferSamples(BOOL) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentBuffer(long*, long*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentSample(IMediaSample**) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetCallback(ISampleGrabberCBX*, long) = 0;
};

#define CHECK(x) do { HRESULT _hr = (x); if (FAILED(_hr)) { printf("%s failed: 0x%08lx\n", #x, _hr); return 1; } } while (0)

static IBaseFilter* FindCamera(const wchar_t* wanted, bool list) {
    ICreateDevEnum* de = nullptr;
    IEnumMoniker* em = nullptr;
    IBaseFilter* found = nullptr;
    if (FAILED(CoCreateInstance(CLSID_SystemDeviceEnum, NULL, CLSCTX_INPROC_SERVER, IID_ICreateDevEnum, (void**)&de))) return nullptr;
    if (de->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &em, 0) == S_OK) {
        IMoniker* m = nullptr;
        while (!found && em->Next(1, &m, NULL) == S_OK) {
            IPropertyBag* bag = nullptr;
            if (SUCCEEDED(m->BindToStorage(0, 0, IID_IPropertyBag, (void**)&bag))) {
                VARIANT v; VariantInit(&v);
                if (SUCCEEDED(bag->Read(L"FriendlyName", &v, 0))) {
                    if (list) printf("  %ls\n", v.bstrVal);
                    if (wanted && wcscmp(v.bstrVal, wanted) == 0) m->BindToObject(0, 0, IID_IBaseFilter, (void**)&found);
                }
                VariantClear(&v);
                bag->Release();
            }
            m->Release();
        }
        em->Release();
    }
    de->Release();
    return found;
}

int wmain(int argc, wchar_t** argv) {
    CoInitialize(NULL);
    if (argc < 3) {
        printf("Video capture devices:\n");
        FindCamera(nullptr, true);
        return 0;
    }
    IBaseFilter* cam = FindCamera(argv[1], false);
    if (!cam) { printf("camera not found: %ls\n", argv[1]); return 2; }

    IGraphBuilder* graph = nullptr;
    ICaptureGraphBuilder2* cgb = nullptr;
    IBaseFilter* grabF = nullptr;
    IBaseFilter* nullR = nullptr;
    ISampleGrabberX* grab = nullptr;
    IMediaControl* mc = nullptr;
    CHECK(CoCreateInstance(CLSID_FilterGraph, NULL, CLSCTX_INPROC_SERVER, IID_IGraphBuilder, (void**)&graph));
    CHECK(CoCreateInstance(CLSID_CaptureGraphBuilder2, NULL, CLSCTX_INPROC_SERVER, IID_ICaptureGraphBuilder2, (void**)&cgb));
    CHECK(cgb->SetFiltergraph(graph));
    CHECK(CoCreateInstance(CLSID_SampleGrabberX, NULL, CLSCTX_INPROC_SERVER, IID_IBaseFilter, (void**)&grabF));
    CHECK(CoCreateInstance(CLSID_NullRendererX, NULL, CLSCTX_INPROC_SERVER, IID_IBaseFilter, (void**)&nullR));
    CHECK(grabF->QueryInterface(IID_ISampleGrabberX, (void**)&grab));
    AM_MEDIA_TYPE mt = {};
    mt.majortype = MEDIATYPE_Video;
    mt.subtype = MEDIASUBTYPE_RGB32;
    CHECK(grab->SetMediaType(&mt));
    CHECK(grab->SetBufferSamples(TRUE));
    CHECK(graph->AddFilter(cam, L"cam"));
    CHECK(graph->AddFilter(grabF, L"grab"));
    CHECK(graph->AddFilter(nullR, L"null"));
    CHECK(cgb->RenderStream(&PIN_CATEGORY_CAPTURE, &MEDIATYPE_Video, cam, grabF, nullR));
    CHECK(graph->QueryInterface(IID_IMediaControl, (void**)&mc));
    CHECK(mc->Run());
    Sleep(2500);

    AM_MEDIA_TYPE cmt = {};
    CHECK(grab->GetConnectedMediaType(&cmt));
    const VIDEOINFOHEADER* vih = (const VIDEOINFOHEADER*)cmt.pbFormat;
    long size = 0;
    CHECK(grab->GetCurrentBuffer(&size, NULL));
    BYTE* buf = (BYTE*)malloc(size);
    CHECK(grab->GetCurrentBuffer(&size, (long*)buf));
    mc->Stop();
    printf("got frame %ldx%ld, %ld bytes, %.1f fps\n", vih->bmiHeader.biWidth, vih->bmiHeader.biHeight, size,
           vih->AvgTimePerFrame ? 1e7 / vih->AvgTimePerFrame : 0.0);

    BITMAPFILEHEADER fh = {};
    fh.bfType = 0x4D42;
    fh.bfOffBits = sizeof(fh) + sizeof(BITMAPINFOHEADER);
    fh.bfSize = fh.bfOffBits + size;
    FILE* f = nullptr;
    if (_wfopen_s(&f, argv[2], L"wb") || !f) { printf("cannot write %ls\n", argv[2]); return 1; }
    fwrite(&fh, sizeof(fh), 1, f);
    fwrite(&vih->bmiHeader, sizeof(BITMAPINFOHEADER), 1, f);
    fwrite(buf, 1, size, f);
    fclose(f);
    printf("saved %ls\n", argv[2]);
    return 0;
}
