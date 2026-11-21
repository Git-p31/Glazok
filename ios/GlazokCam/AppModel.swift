import AVFoundation
import SwiftUI
import UIKit
import WebRTC

/*
 * Логика телефона-камеры — повторяет index.html веб-версии, чтобы монитор не заметил разницы:
 *  1. Телефон подключается к монитору только каналом управления и ждёт.
 *  2. Видеозвонок создаётся по команде "go-live" и закрывается по "go-idle".
 *  3. Clean Output получает видео прямо с телефона (viewer-add / viewer-remove).
 * Плюс то, чего нет в браузере iPhone: фокус по точке и ручная камера.
 */
final class AppModel: NSObject, ObservableObject, PeerSignalingDelegate {
    enum Screen { case connect, camera }
    enum StatusKind { case ok, live, warning, bad, idle }

    // MARK: - Состояние для интерфейса

    @Published var screen: Screen = .connect
    @Published var statusText = "ПОДКЛЮЧЕНИЕ"
    @Published var statusKind: StatusKind = .warning
    @Published var standby = false
    @Published var qualityText = "—"
    @Published var iceNote = ""
    @Published var toast: String?
    @Published var busy = false

    @Published var focusSet = false
    @Published var focusMarker: CGPoint?          // точка на превью (для рамки)
    @Published var focusMarkerID = 0

    @Published var zoomValue: Double = 1
    @Published var zoomRange: ClosedRange<Double> = 1...1
    @Published var torchOn = false
    @Published var lenses: [CameraController.Lens] = []
    @Published var currentLens: AVCaptureDevice.DeviceType = .builtInWideAngleCamera

    @Published var manualOn = false
    @Published var manualCaps: [String: [String: Any]] = [:]
    @Published var manualVals: [String: Double] = [:]
    @Published var showManual = false

    // Настройки подключения (запоминаются)
    @Published var code = ""
    @Published var deviceName = UserDefaults.standard.string(forKey: "deviceName") ?? ""
    @Published var resolution = UserDefaults.standard.object(forKey: "resolution") as? Int ?? 1080
    @Published var fps = UserDefaults.standard.object(forKey: "fps") as? Int ?? 30
    @Published var audioOn = UserDefaults.standard.bool(forKey: "audio")

    // MARK: - WebRTC

    private let factory: RTCPeerConnectionFactory
    private let videoSource: RTCVideoSource
    private let videoTrack: RTCVideoTrack
    private var audioTrack: RTCAudioTrack?
    let camera: CameraController
    weak var previewLayer: AVCaptureVideoPreviewLayer?

    private var signaling: PeerSignaling?
    private var iceServers: [RTCIceServer] = IceConfig.fallback
    private var links: [String: PeerLink] = [:]      // по connectionId
    private var ctrl: PeerLink?
    private var call: PeerLink?
    private var viewerIds = Set<String>()
    private var viewerCalls: [String: PeerLink] = [:]

    private var room = ""
    private var token: String?
    private var wantLive = false
    private var denied = false
    private var stopping = true
    private var retry = 0
    private var linkTimer: Timer?
    private var statusTimer: Timer?
    private var redialWork: DispatchWorkItem?
    private var ctrlStartedAt = Date.distantPast
    private var manualLockTimer: Timer?

    private let cid: String = {
        if let id = UserDefaults.standard.string(forKey: "cid"), id.count >= 10 { return id }
        let id = RandomID.make(12)
        UserDefaults.standard.set(id, forKey: "cid")
        return id
    }()

    let model = DeviceModel.name

    override init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                           decoderFactory: RTCDefaultVideoDecoderFactory())
        videoSource = factory.videoSource()
        videoTrack = factory.videoTrack(with: videoSource, trackId: "glazok-video")
        camera = CameraController(source: videoSource)
        super.init()
        loadManual()
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(self, selector: #selector(batteryChanged),
                                               name: UIDevice.batteryLevelDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(batteryChanged),
                                               name: UIDevice.batteryStateDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - Подключение

    /// Разбирает QR монитора: ссылка с ?room=…&k=…&t=app:key, либо просто код комнаты.
    func applyScan(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let comps = URLComponents(string: value), let items = comps.queryItems,
           let room = items.first(where: { $0.name == "room" })?.value, Self.isCode(room) {
            code = room.uppercased()
            token = items.first(where: { $0.name == "k" })?.value
            if let t = items.first(where: { $0.name == "t" })?.value, let i = t.firstIndex(of: ":") {
                UserDefaults.standard.set(String(t[..<i]), forKey: "turnApp")
                UserDefaults.standard.set(String(t[t.index(after: i)...]), forKey: "turnKey")
            }
            return true
        }
        if Self.isCode(value) { code = value.uppercased(); token = nil; return true }
        return false
    }

    static func isCode(_ s: String) -> Bool {
        s.count == 6 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    func codeEditedManually() { token = nil }

    func connect() {
        guard Self.isCode(code) else { show("Код должен содержать 6 символов"); return }
        guard !busy else { return }
        busy = true
        let defaults = UserDefaults.standard
        defaults.set(deviceName, forKey: "deviceName")
        defaults.set(resolution, forKey: "resolution")
        defaults.set(fps, forKey: "fps")
        defaults.set(audioOn, forKey: "audio")

        room = code.lowercased()
        stopping = false
        denied = false
        wantLive = false
        retry = 0

        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                guard granted else {
                    self.busy = false
                    self.show("Нет доступа к камере — разрешите его в Настройках → Glazok")
                    return
                }
                self.startCamera(position: .back, lens: .builtInWideAngleCamera) { ok in
                    guard ok else { self.busy = false; return }
                    self.screen = .camera
                    UIApplication.shared.isIdleTimerDisabled = true
                    self.setStatus("ПОДКЛЮЧЕНИЕ К МОНИТОРУ", .warning)
                    Task { @MainActor in
                        if self.audioOn { await self.openAudio() }
                        let app = defaults.string(forKey: "turnApp") ?? ""
                        let key = defaults.string(forKey: "turnKey") ?? ""
                        let ice = await IceConfig.load(app: app, apiKey: key)
                        self.iceServers = ice.servers
                        self.iceNote = ice.note
                        self.busy = false
                        guard !self.stopping else { return }
                        self.startSignaling()
                        self.linkTimer?.invalidate()
                        self.linkTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.ensureLink() }
                    }
                }
            }
        }
    }

    func stop() {
        sendCtrl(["type": "bye"])
        stopping = true
        wantLive = false
        redialWork?.cancel()
        linkTimer?.invalidate(); linkTimer = nil
        statusTimer?.invalidate(); statusTimer = nil
        manualLockTimer?.invalidate(); manualLockTimer = nil
        closeAllLinks()
        signaling?.delegate = nil
        signaling?.disconnect()
        signaling = nil
        if torchOn { camera.setTorch(false); torchOn = false }
        camera.stop()
        audioTrack = nil
        focusSet = false
        focusMarker = nil
        standby = false
        showManual = false
        qualityText = "—"
        UIApplication.shared.isIdleTimerDisabled = false
        screen = .connect
        setStatus("ПОДКЛЮЧЕНИЕ", .warning)
    }

    private func startSignaling() {
        signaling?.delegate = nil
        signaling?.disconnect()
        let s = PeerSignaling(peerId: "glz-ios-" + RandomID.make(10))
        s.delegate = self
        signaling = s
        s.connect()
    }

    private func closeAllLinks() {
        let all = Array(links.values)
        links.removeAll()
        ctrl = nil
        call = nil
        viewerCalls.removeAll()
        all.forEach { $0.close() }
    }

    /// Проверяет всё по кругу: сервер → канал управления → (если велено) видеозвонок.
    private func ensureLink() {
        guard !stopping, !denied else { return }
        guard let s = signaling else { startSignaling(); return }
        if !s.isOpen {
            if !s.isConnecting { s.connect() }
            return
        }
        if ctrl == nil || !(ctrl?.isOpen ?? false) {
            if ctrl == nil || Date().timeIntervalSince(ctrlStartedAt) > 8 { openControl() }
            return
        }
        if wantLive, call == nil || (!(call?.isOpen ?? false) && Date().timeIntervalSince(call!.createdAt) > 20) {
            makeCall()
        }
    }

    private func scheduleRedial() {
        guard !stopping, !denied else { return }
        redialWork?.cancel()
        retry += 1
        let work = DispatchWorkItem { [weak self] in self?.ensureLink() }
        redialWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(min(retry, 5)), execute: work)
    }

    private var monitorId: String { "glz-" + room }

    private func makeLink(_ kind: PeerLink.Kind, to remote: String, tracks: [RTCMediaStreamTrack]) -> PeerLink? {
        guard let s = signaling else { return nil }
        guard let link = PeerLink(kind: kind, remoteId: remote, factory: factory,
                                  config: IceConfig.configuration(iceServers), signaling: s, tracks: tracks) else { return nil }
        links[link.connectionId] = link
        return link
    }

    private func forget(_ link: PeerLink) {
        links.removeValue(forKey: link.connectionId)
    }

    // MARK: - Канал управления

    private func openControl() {
        if let old = ctrl { ctrl = nil; old.close() }
        guard let link = makeLink(.data, to: monitorId, tracks: []) else { return }
        ctrl = link
        ctrlStartedAt = Date()
        link.onOpen = { [weak self, weak link] in
            guard let self = self, let link = link, self.ctrl === link else { return }
            self.retry = 0
            self.sendStatus(); self.sendCaps(); self.sendManual(); self.sendFocus()
            self.statusTimer?.invalidate()
            self.statusTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.sendStatus() }
            if self.wantLive, !(self.call?.isOpen ?? false) { self.makeCall() } else { self.showStandby() }
        }
        link.onMessage = { [weak self, weak link] message in
            guard let self = self, let link = link, self.ctrl === link else { return }
            self.handleCtrl(message)
        }
        link.onClose = { [weak self, weak link] in
            guard let self = self, let link = link else { return }
            self.forget(link)
            guard self.ctrl === link else { return }
            self.ctrl = nil
            self.statusTimer?.invalidate()
            if self.stopping || self.denied { return }
            if !self.wantLive { self.setStatus("ПОДКЛЮЧЕНИЕ К МОНИТОРУ", .warning) }
            self.scheduleRedial()
        }
        var md: [String: Any] = ["role": "camera", "cid": cid, "model": model, "name": deviceName]
        if let token = token { md["token"] = token }
        link.start(metadata: md)
    }

    private func sendCtrl(_ message: [String: Any]) {
        ctrl?.send(message)
    }

    private func handleCtrl(_ data: [String: Any]) {
        guard let type = data["type"] as? String else { return }
        switch type {
        case "zoom":
            if let v = (data["value"] as? NSNumber)?.doubleValue { setZoom(v) }
        case "go-live":
            wantLive = true
            standby = false
            viewerIds.forEach { callViewer($0) }
            if !(call?.isOpen ?? false) { makeCall() }
        case "viewer-add":
            if let id = data["viewerId"] as? String { viewerIds.insert(id); if wantLive { callViewer(id) } }
        case "viewer-remove":
            if let id = data["viewerId"] as? String { viewerIds.remove(id); closeViewerCall(id) }
        case "go-idle":
            wantLive = false
            redialWork?.cancel()
            Array(viewerCalls.keys).forEach(closeViewerCall)
            closeCall()
            showStandby()
            sendStatus()
        case "manual-set":
            if let on = data["on"] as? Bool { setManual(on) }
            if let id = data["id"] as? String, let v = (data["value"] as? NSNumber)?.doubleValue, v.isFinite { setManualValue(id, v) }
        case "focus":
            if data["reset"] as? Bool == true { resetFocus() }
            else if let x = (data["x"] as? NSNumber)?.doubleValue, let y = (data["y"] as? NSNumber)?.doubleValue {
                let p = camera.devicePoint(fromFrame: CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y))))
                focus(devicePoint: p, layerPoint: previewLayer?.layerPointConverted(fromCaptureDevicePoint: p))
            }
        case "need-caps":
            sendFocus(); sendManual(); sendCaps(); sendStatus()
        case "denied":
            denied = true
            wantLive = false
            closeCall()
            setStatus("МОНИТОР ОТКЛОНИЛ ПОДКЛЮЧЕНИЕ", .bad)
            show("Монитор отклонил подключение")
        default:
            break
        }
    }

    private func sendStatus() {
        let dev = UIDevice.current
        var msg: [String: Any] = [
            "type": "status", "cid": cid, "model": model, "name": deviceName,
            "charging": dev.batteryState == .charging || dev.batteryState == .full,
            "hasBattery": dev.batteryLevel >= 0, "direct": true, "live": wantLive
        ]
        msg["battery"] = dev.batteryLevel >= 0 ? Int((dev.batteryLevel * 100).rounded()) : NSNull()
        sendCtrl(msg)
    }

    private func sendCaps() {
        let r = camera.zoomRange
        if r.upperBound > r.lowerBound {
            sendCtrl(["type": "caps", "zoom": ["min": r.lowerBound, "max": r.upperBound, "step": 0.1, "value": camera.zoom]])
        } else {
            sendCtrl(["type": "caps", "zoom": NSNull()])
        }
    }

    private func sendFocus() {
        let p = lastFocusDevicePoint.map { camera.framePoint(fromDevice: $0) } ?? CGPoint(x: 0.5, y: 0.5)
        sendCtrl(["type": "focus-state", "supported": camera.focusPointSupported, "set": focusSet, "x": p.x, "y": p.y])
    }

    private var manualSendWork: DispatchWorkItem?
    private func sendManual() {
        manualSendWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            let current = self.camera.currentValues()
            var vals: [String: Double] = [:]
            for id in self.manualCaps.keys { if let v = self.manualVals[id] ?? current[id] { vals[id] = v } }
            self.sendCtrl(["type": "manual", "on": self.manualOn, "caps": self.manualCaps, "vals": vals])
        }
        manualSendWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
    }

    private func showStandby() {
        guard !stopping else { return }
        standby = !wantLive
        if !wantLive { setStatus("ОЖИДАНИЕ", .idle) }
    }

    @objc private func batteryChanged() { sendStatus() }

    @objc private func becameActive() {
        guard !stopping, screen == .camera else { return }
        retry = 0
        ensureLink()
    }

    // MARK: - Видеозвонки

    private var outTracks: [RTCMediaStreamTrack] {
        var tracks: [RTCMediaStreamTrack] = [videoTrack]
        if let a = audioTrack { tracks.append(a) }
        return tracks
    }

    private func makeCall() {
        guard wantLive, !stopping, signaling?.isOpen == true else { return }
        closeCall()
        guard let link = makeLink(.media, to: monitorId, tracks: outTracks) else { scheduleRedial(); return }
        call = link
        setStatus("ЗАПУСК ЭФИРА…", .warning)
        link.onOpen = { [weak self, weak link] in
            guard let self = self, let link = link, self.call === link else { return }
            self.retry = 0
            link.applyEncoding(maxBitrate: self.bitrate, maxFramerate: self.fps)
            self.setStatus("В ЭФИРЕ", .live)
            self.standby = false
            self.updateQuality()
            self.sendStatus()
        }
        link.onUnstable = { [weak self, weak link] in
            guard let self = self, let link = link, self.call === link else { return }
            self.setStatus("СВЯЗЬ НЕСТАБИЛЬНА", .warning)
        }
        link.onClose = { [weak self, weak link] in
            guard let self = self, let link = link else { return }
            self.forget(link)
            guard self.call === link else { return }
            self.call = nil
            if self.stopping || !self.wantLive { return }
            self.setStatus("ПЕРЕПОДКЛЮЧЕНИЕ…", .warning)
            self.scheduleRedial()
        }
        var md: [String: Any] = ["cid": cid]
        if let token = token { md["token"] = token }
        link.start(metadata: md)
    }

    private func closeCall() {
        guard let c = call else { return }
        call = nil
        c.close()
    }

    private func callViewer(_ viewerId: String) {
        guard wantLive, signaling?.isOpen == true else { return }
        closeViewerCall(viewerId)
        guard let link = makeLink(.media, to: viewerId, tracks: outTracks) else { return }
        viewerCalls[viewerId] = link
        link.onOpen = { [weak link] in link?.applyEncoding(maxBitrate: 15_000_000, maxFramerate: 60) }
        link.onClose = { [weak self, weak link] in
            guard let self = self, let link = link else { return }
            self.forget(link)
            if self.viewerCalls[viewerId] === link { self.viewerCalls.removeValue(forKey: viewerId) }
        }
        link.start(metadata: nil)
    }

    private func closeViewerCall(_ viewerId: String) {
        guard let link = viewerCalls.removeValue(forKey: viewerId) else { return }
        link.close()
    }

    private var bitrate: Int {
        switch (resolution, fps >= 60) {
        case (2160, true): return 35_000_000
        case (2160, false): return 25_000_000
        case (1440, _): return fps >= 60 ? 18_000_000 : 13_000_000
        case (1080, true): return 10_000_000
        case (1080, false): return 7_000_000
        case (720, true): return 4_500_000
        default: return 2_800_000
        }
    }

    private func updateQuality() {
        guard let dev = camera.device else { qualityText = "—"; return }
        let d = CMVideoFormatDescriptionGetDimensions(dev.activeFormat.formatDescription)
        qualityText = "\(d.width)×\(d.height) • \(camera.targetFps) FPS"
    }

    private func openAudio() async {
        let granted = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { c.resume(returning: $0) }
        }
        guard granted else { show("Микрофон недоступен — трансляция без звука"); return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        audioTrack = factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "glazok-audio")
    }

    // MARK: - PeerSignalingDelegate

    func signalingDidOpen(_ s: PeerSignaling) {
        guard s === signaling, !stopping else { return }
        ensureLink()
    }

    func signaling(_ s: PeerSignaling, didCloseWith error: String?, idTaken: Bool) {
        guard s === signaling, !stopping else { return }
        closeAllLinks()
        setStatus("ПЕРЕПОДКЛЮЧЕНИЕ…", .warning)
        if idTaken { signaling = nil }          // ensureLink создаст новый ID
        scheduleRedial()
    }

    func signaling(_ s: PeerSignaling, didReceive type: String, from src: String?, payload: [String: Any]?) {
        guard s === signaling else { return }
        switch type {
        case "ANSWER", "CANDIDATE":
            guard let payload = payload, let id = payload["connectionId"] as? String, let link = links[id] else { return }
            link.handle(type: type, payload: payload)
        case "EXPIRE", "LEAVE":
            guard let src = src else { return }
            links.values.filter { $0.remoteId == src && (type == "LEAVE" || !$0.isOpen) }.forEach { $0.close() }
            if src == monitorId {
                if type == "EXPIRE" { setStatus("ЖДЁМ МОНИТОР", .warning) }
                scheduleRedial()
            } else {
                viewerIds.remove(src)
            }
        default:
            break   // входящие OFFER телефону не нужны
        }
    }

    // MARK: - Камера: запуск, объективы

    private func startCamera(position: AVCaptureDevice.Position, lens: AVCaptureDevice.DeviceType, done: @escaping (Bool) -> Void) {
        camera.targetHeight = resolution
        camera.targetFps = fps
        camera.start(position: position, lens: lens) { error in
            if let error = error {
                self.show("Не удалось запустить камеру: \(error.localizedDescription)")
                done(false)
                return
            }
            self.afterCameraStart()
            done(true)
        }
    }

    private func afterCameraStart() {
        lenses = CameraController.lenses(for: camera.position)
        currentLens = camera.lens
        zoomRange = camera.zoomRange
        zoomValue = camera.zoom
        torchOn = false
        manualCaps = camera.manualCaps()
        updateQuality()
        applyManual()
        if focusSet, let p = lastFocusDevicePoint, !(manualOn && manualVals["fo"] != nil) { camera.focus(at: p) }
        sendCaps(); sendManual(); sendFocus()
    }

    func switchLens(_ lens: AVCaptureDevice.DeviceType) {
        guard lens != currentLens, !busy else { return }
        busy = true
        camera.stop {
            self.startCamera(position: .back, lens: lens) { _ in self.busy = false }
        }
    }

    func flipCamera() {
        guard !busy else { return }
        busy = true
        let next: AVCaptureDevice.Position = camera.position == .back ? .front : .back
        camera.stop {
            self.startCamera(position: next, lens: .builtInWideAngleCamera) { ok in
                if ok { self.busy = false; return }
                self.startCamera(position: next == .back ? .front : .back, lens: .builtInWideAngleCamera) { _ in self.busy = false }
            }
        }
    }

    func toggleTorch() {
        guard camera.hasTorch else { show("Вспышка недоступна"); return }
        let next = !torchOn
        if camera.setTorch(next) { torchOn = next } else { show("Вспышка недоступна") }
    }

    func setZoom(_ value: Double) {
        camera.setZoom(value)
        zoomValue = camera.zoom
        sendCtrl(["type": "zoom-value", "value": zoomValue])
    }

    // MARK: - Фокус по точке

    private var lastFocusDevicePoint: CGPoint?

    /// devicePoint — координаты камеры (0..1); layerPoint — где показать рамку на превью.
    func focus(devicePoint: CGPoint, layerPoint: CGPoint?) {
        guard camera.focusPointSupported else { show("Эта камера не поддерживает фокус по точке"); return }
        if manualVals["fo"] != nil {            // ручная дистанция уступает автофокусу по точке
            manualVals["fo"] = nil
            saveManual()
        }
        camera.focus(at: devicePoint)
        lastFocusDevicePoint = devicePoint
        focusSet = true
        if let lp = layerPoint { focusMarker = lp; focusMarkerID += 1 }
        sendManual()
        sendFocus()
    }

    func resetFocus() {
        focusSet = false
        lastFocusDevicePoint = nil
        if manualOn, let fo = manualVals["fo"] { camera.setLensPosition(Float(fo)) } else { camera.resetFocus() }
        sendFocus()
    }

    // MARK: - Ручной режим

    private func loadManual() {
        guard let data = UserDefaults.standard.data(forKey: "manual"),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        manualOn = obj["on"] as? Bool ?? false
        manualVals = (obj["vals"] as? [String: Double]) ?? [:]
    }

    private func saveManual() {
        let obj: [String: Any] = ["on": manualOn, "vals": manualVals]
        if let data = try? JSONSerialization.data(withJSONObject: obj) { UserDefaults.standard.set(data, forKey: "manual") }
    }

    func setManual(_ on: Bool) {
        if on {   // стартуем с того, что выбрала автоматика
            let cur = camera.currentValues()
            for id in ["wb", "iso", "sh"] where manualVals[id] == nil && manualCaps[id] != nil { manualVals[id] = cur[id] }
        }
        manualOn = on
        saveManual()
        applyManual()
        sendManual()
    }

    func setManualValue(_ id: String, _ value: Double) {
        var v = value
        if let c = manualCaps[id], let lo = (c["min"] as? NSNumber)?.doubleValue, let hi = (c["max"] as? NSNumber)?.doubleValue {
            v = min(hi, max(lo, v))
        }
        manualVals[id] = v
        if id == "fo", focusSet { focusSet = false; lastFocusDevicePoint = nil; sendFocus() }
        saveManual()
        if !manualOn { setManual(true); return }
        applyManual(only: id)
        sendManual()
    }

    func applyManual(only id: String? = nil) {
        guard camera.device != nil else { return }
        manualLockTimer?.invalidate(); manualLockTimer = nil
        guard manualOn else {
            camera.setAutoExposureAndWB()
            if !focusSet { camera.setAutoFocus() }
            return
        }
        if id == nil || id == "wb", let k = manualVals["wb"] { camera.setWhiteBalance(kelvin: k) }
        if id == nil || id == "iso" || id == "sh", manualVals["iso"] != nil || manualVals["sh"] != nil {
            camera.setExposure(iso: manualVals["iso"], shutterUnits: manualVals["sh"])
        }
        if id == nil || id == "ev", let ev = manualVals["ev"] { camera.setExposureBias(ev) }
        if id == nil || id == "fo", let fo = manualVals["fo"], !focusSet { camera.setLensPosition(Float(fo)) }
    }

    func resetManualValue(_ id: String) {
        manualVals[id] = nil
        saveManual()
        if id == "fo" { camera.setAutoFocus() }
        if id == "ev" { camera.setExposureBias(0) }
        applyManual()
        sendManual()
    }

    // MARK: - Вспомогательное

    func setStatus(_ text: String, _ kind: StatusKind) {
        statusText = text
        statusKind = kind
    }

    func show(_ message: String) {
        toast = message
        let current = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            if self?.toast == current { self?.toast = nil }
        }
    }
}

enum DeviceModel {
    static let name: String = {
        var info = utsname()
        uname(&info)
        let id = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let names: [String: String] = [
            "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2)",
            "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
            "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
            "iPhone14,6": "iPhone SE (3)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
            "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
            "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
            "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,5": "iPhone 16e"
        ]
        return names[id] ?? (id.hasPrefix("iPhone") ? "iPhone (\(id))" : (id.isEmpty ? "iPhone" : id))
    }()
}
