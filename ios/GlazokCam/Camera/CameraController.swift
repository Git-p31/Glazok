import AVFoundation
import UIKit
import WebRTC

/*
 * Камера iPhone через AVFoundation — то, чего Safari сайтам не даёт:
 * фокус по точке, ручная дистанция фокуса (положение линзы), ISO, выдержка, баланс белого
 * в кельвинах, экспокоррекция, оптический зум, выбор объектива (0.5× / 1× / 3×…), фонарик.
 * Кадры идут в WebRTC через RTCCameraVideoCapturer.
 */
final class CameraController {
    struct Lens: Equatable {
        let type: AVCaptureDevice.DeviceType
        let title: String
    }

    let capturer: RTCCameraVideoCapturer
    private(set) var device: AVCaptureDevice?
    private(set) var position: AVCaptureDevice.Position = .back
    private(set) var lens: AVCaptureDevice.DeviceType = .builtInWideAngleCamera

    var targetHeight = 1080
    var targetFps = 30

    /// Последняя «настоящая» ориентация телефона (лицом вверх/вниз не считается).
    private var lastOrientation: UIDeviceOrientation = .portrait
    private var orientationObserver: NSObjectProtocol?

    init(source: RTCVideoSource) {
        capturer = RTCCameraVideoCapturer(delegate: source)
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        updateOrientation()
        orientationObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.updateOrientation()
        }
    }

    deinit {
        if let o = orientationObserver { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: - Запуск

    static func lenses(for position: AVCaptureDevice.Position) -> [Lens] {
        let all: [Lens] = [
            Lens(type: .builtInUltraWideCamera, title: "0.5×"),
            Lens(type: .builtInWideAngleCamera, title: "1×"),
            Lens(type: .builtInTelephotoCamera, title: "Теле")
        ]
        let found = AVCaptureDevice.DiscoverySession(deviceTypes: all.map { $0.type }, mediaType: .video, position: position).devices
        return all.filter { lens in found.contains { $0.deviceType == lens.type } }
    }

    func start(position: AVCaptureDevice.Position, lens: AVCaptureDevice.DeviceType, completion: @escaping (Error?) -> Void) {
        guard let dev = AVCaptureDevice.default(lens, for: .video, position: position)
                ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
            completion(NSError(domain: "Glazok", code: 1, userInfo: [NSLocalizedDescriptionKey: "Камера не найдена"]))
            return
        }
        guard let format = pickFormat(dev) else {
            completion(NSError(domain: "Glazok", code: 2, userInfo: [NSLocalizedDescriptionKey: "Нет подходящего формата видео"]))
            return
        }
        let maxFps = Int(format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 30)
        let fps = min(targetFps, maxFps)
        capturer.startCapture(with: dev, format: format, fps: fps) { error in
            DispatchQueue.main.async {
                if error == nil {
                    self.device = dev
                    self.position = position
                    self.lens = dev.deviceType
                }
                completion(error)
            }
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        capturer.stopCapture {
            DispatchQueue.main.async {
                self.device = nil
                completion?()
            }
        }
    }

    /// Формат 16:9 с короткой стороной не больше выбранной и нужной частотой кадров.
    private func pickFormat(_ dev: AVCaptureDevice) -> AVCaptureDevice.Format? {
        let formats = RTCCameraVideoCapturer.supportedFormats(for: dev)
        func info(_ f: AVCaptureDevice.Format) -> (short: Int32, wide: Bool, fps: Double) {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let fps = f.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            return (min(d.width, d.height), d.width * 9 == d.height * 16, fps)
        }
        let target = Int32(targetHeight)
        let good = formats.filter { let i = info($0); return i.wide && i.short <= target && i.fps >= Double(targetFps) }
        if let best = good.max(by: { info($0).short < info($1).short }) { return best }
        let wide = formats.filter { info($0).wide && info($0).short <= target }
        if let best = wide.max(by: { (info($0).short, info($0).fps) < (info($1).short, info($1).fps) }) { return best }
        return formats.last
    }

    // MARK: - Настройки камеры

    private func configure(_ block: (AVCaptureDevice) -> Void) {
        guard let dev = device else { return }
        do {
            try dev.lockForConfiguration()
            block(dev)
            dev.unlockForConfiguration()
        } catch {
            print("lockForConfiguration:", error)
        }
    }

    var focusPointSupported: Bool { device?.isFocusPointOfInterestSupported ?? false }

    /// Фокус (и замер экспозиции) по точке. point — в координатах камеры (0..1, сенсор в «ландшафте»).
    func focus(at point: CGPoint) {
        configure { dev in
            if dev.isFocusPointOfInterestSupported {
                dev.focusPointOfInterest = point
                if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
                else if dev.isFocusModeSupported(.autoFocus) { dev.focusMode = .autoFocus }
            }
            if dev.isExposurePointOfInterestSupported, dev.exposureMode != .custom {
                dev.exposurePointOfInterest = point
                if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            }
            dev.isSubjectAreaChangeMonitoringEnabled = false
        }
    }

    func resetFocus() {
        focus(at: CGPoint(x: 0.5, y: 0.5))
    }

    func setLensPosition(_ value: Float) {
        configure { dev in
            guard dev.isLockingFocusWithCustomLensPositionSupported else { return }
            dev.setFocusModeLocked(lensPosition: max(0, min(1, value)), completionHandler: nil)
        }
    }

    func setAutoExposureAndWB() {
        configure { dev in
            if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            if dev.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { dev.whiteBalanceMode = .continuousAutoWhiteBalance }
            dev.setExposureTargetBias(0, completionHandler: nil)
        }
    }

    func setAutoFocus() {
        configure { dev in
            if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
        }
    }

    /// ISO и выдержка вместе (так требует AVFoundation). shutterUnits — в единицах по 100 мкс, как в веб-версии.
    func setExposure(iso: Double?, shutterUnits: Double?) {
        configure { dev in
            guard dev.isExposureModeSupported(.custom) else { return }
            let format = dev.activeFormat
            let isoValue = Float(iso ?? Double(dev.iso))
            let clampedISO = max(format.minISO, min(format.maxISO, isoValue))
            var duration = AVCaptureDevice.currentExposureDuration
            if let units = shutterUnits {
                let seconds = max(format.minExposureDuration.seconds, min(Self.maxShutter(format), units * 0.0001))
                duration = CMTime(seconds: seconds, preferredTimescale: 1_000_000)
            }
            dev.setExposureModeCustom(duration: duration, iso: clampedISO, completionHandler: nil)
        }
    }

    func setExposureBias(_ ev: Double) {
        configure { dev in
            let v = max(dev.minExposureTargetBias, min(dev.maxExposureTargetBias, Float(ev)))
            dev.setExposureTargetBias(v, completionHandler: nil)
        }
    }

    func setWhiteBalance(kelvin: Double) {
        configure { dev in
            guard dev.isLockingWhiteBalanceWithCustomDeviceGainsSupported else { return }
            let tt = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(temperature: Float(kelvin), tint: 0)
            var gains = dev.deviceWhiteBalanceGains(for: tt)
            let maxGain = dev.maxWhiteBalanceGain
            gains.redGain = max(1, min(maxGain, gains.redGain))
            gains.greenGain = max(1, min(maxGain, gains.greenGain))
            gains.blueGain = max(1, min(maxGain, gains.blueGain))
            dev.setWhiteBalanceModeLocked(with: gains, completionHandler: nil)
        }
    }

    var zoomRange: ClosedRange<Double> {
        guard let dev = device else { return 1...1 }
        let lo = Double(dev.minAvailableVideoZoomFactor)
        let hi = Double(min(dev.maxAvailableVideoZoomFactor, 10))
        return lo...max(lo, hi)
    }

    var zoom: Double { Double(device?.videoZoomFactor ?? 1) }

    func setZoom(_ value: Double) {
        let range = zoomRange
        configure { dev in dev.videoZoomFactor = CGFloat(max(range.lowerBound, min(range.upperBound, value))) }
    }

    var hasTorch: Bool { device?.hasTorch ?? false }

    @discardableResult
    func setTorch(_ on: Bool) -> Bool {
        var ok = false
        configure { dev in
            guard dev.hasTorch else { return }
            if on { ok = (try? dev.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel)) != nil }
            else { dev.torchMode = .off; ok = true }
        }
        return ok
    }

    // MARK: - Возможности и текущие значения для ручного режима

    static func maxShutter(_ format: AVCaptureDevice.Format) -> Double {
        min(format.maxExposureDuration.seconds, 0.25)
    }

    /// Границы слайдеров в формате монитора: wb (K), iso, sh (единицы по 100 мкс), ev, fo (линза 0..1).
    func manualCaps() -> [String: [String: Any]] {
        guard let dev = device else { return [:] }
        let f = dev.activeFormat
        var caps: [String: [String: Any]] = [:]
        if dev.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
            caps["wb"] = ["min": 2500, "max": 9000, "step": 50]
        }
        if dev.isExposureModeSupported(.custom) {
            caps["iso"] = ["min": Double(f.minISO), "max": Double(f.maxISO), "step": 1]
            caps["sh"] = ["min": f.minExposureDuration.seconds / 0.0001, "max": Self.maxShutter(f) / 0.0001]
        }
        if dev.maxExposureTargetBias > dev.minExposureTargetBias {
            caps["ev"] = ["min": Double(dev.minExposureTargetBias), "max": Double(dev.maxExposureTargetBias), "step": 0.1]
        }
        if dev.isLockingFocusWithCustomLensPositionSupported {
            caps["fo"] = ["min": 0, "max": 1, "step": 0.01, "lens": true]
        }
        return caps
    }

    func currentValues() -> [String: Double] {
        guard let dev = device else { return [:] }
        var v: [String: Double] = [
            "iso": Double(dev.iso),
            "sh": dev.exposureDuration.seconds / 0.0001,
            "ev": Double(dev.exposureTargetBias),
            "fo": Double(dev.lensPosition)
        ]
        if dev.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
            let g = dev.deviceWhiteBalanceGains
            let tt = dev.temperatureAndTintValues(for: g)
            if tt.temperature.isFinite { v["wb"] = Double(max(2500, min(9000, tt.temperature))) }
        }
        return v
    }

    // MARK: - Координаты кадра ↔ точки камеры

    private func updateOrientation() {
        let o = UIDevice.current.orientation
        if o == .portrait || o == .portraitUpsideDown || o == .landscapeLeft || o == .landscapeRight { lastOrientation = o }
    }

    /// Поворот, который RTCCameraVideoCapturer применяет к кадру (та же логика, что внутри WebRTC).
    private var frameRotation: Int {
        let front = position == .front
        switch lastOrientation {
        case .portrait: return 90
        case .portraitUpsideDown: return 270
        case .landscapeLeft: return front ? 180 : 0
        case .landscapeRight: return front ? 0 : 180
        default: return 90
        }
    }

    /// Точка в кадре, который видит монитор (0..1, слева-сверху) → точка камеры для focusPointOfInterest.
    func devicePoint(fromFrame p: CGPoint) -> CGPoint {
        switch frameRotation {
        case 90: return CGPoint(x: p.y, y: 1 - p.x)
        case 180: return CGPoint(x: 1 - p.x, y: 1 - p.y)
        case 270: return CGPoint(x: 1 - p.y, y: p.x)
        default: return p
        }
    }

    /// Обратное преобразование: точка камеры → точка в кадре монитора.
    func framePoint(fromDevice p: CGPoint) -> CGPoint {
        switch frameRotation {
        case 90: return CGPoint(x: 1 - p.y, y: p.x)
        case 180: return CGPoint(x: 1 - p.x, y: 1 - p.y)
        case 270: return CGPoint(x: p.y, y: 1 - p.x)
        default: return p
        }
    }
}
