import Foundation
import WebRTC

/*
 * Одно соединение PeerJS, которое открывает телефон (он всегда «звонящий»):
 *  • .data  — канал управления с монитором (serialization "json": UTF-8 JSON в бинарных сообщениях);
 *  • .media — видеозвонок на монитор или прямо в Clean Output.
 * Как и PeerJS 1.5, медиазвонок тоже несёт служебный data channel: когда он закрывается,
 * обе стороны сразу понимают, что звонок завершён.
 */
final class PeerLink: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    enum Kind { case data, media }

    let kind: Kind
    let remoteId: String
    let connectionId: String
    let createdAt = Date()
    private(set) var isOpen = false
    private(set) var isClosed = false
    private(set) var videoSender: RTCRtpSender?

    var onOpen: (() -> Void)?
    var onMessage: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?
    var onUnstable: (() -> Void)?

    private let pc: RTCPeerConnection
    private var channel: RTCDataChannel?
    private weak var signaling: PeerSignaling?
    private var pendingCandidates: [RTCIceCandidate] = []
    private var remoteDescriptionSet = false

    init?(kind: Kind, remoteId: String, factory: RTCPeerConnectionFactory, config: RTCConfiguration,
          signaling: PeerSignaling, tracks: [RTCMediaStreamTrack]) {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: nil) else { return nil }
        self.kind = kind
        self.remoteId = remoteId
        self.connectionId = (kind == .data ? "dc_" : "mc_") + RandomID.make(16)
        self.pc = pc
        self.signaling = signaling
        super.init()
        pc.delegate = self

        for track in tracks {
            let sender = pc.add(track, streamIds: ["glazok"])
            if track.kind == kRTCMediaStreamTrackKindVideo { videoSender = sender }
        }
        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        channel = pc.dataChannel(forLabel: connectionId, configuration: dcConfig)
        channel?.delegate = self
    }

    // MARK: - Сигналинг

    func start(metadata: [String: Any]?) {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc.offer(for: constraints) { [weak self] sdp, _ in
            guard let self = self else { return }
            guard let sdp = sdp else { DispatchQueue.main.async { self.close() }; return }
            self.pc.setLocalDescription(sdp) { error in
                DispatchQueue.main.async {
                    guard !self.isClosed else { return }
                    if error != nil { self.close(); return }
                    var payload: [String: Any] = [
                        "sdp": ["type": "offer", "sdp": sdp.sdp],
                        "type": self.kind == .data ? "data" : "media",
                        "connectionId": self.connectionId
                    ]
                    if let metadata = metadata { payload["metadata"] = metadata }
                    if self.kind == .data {
                        payload["label"] = self.connectionId
                        payload["reliable"] = true
                        payload["serialization"] = "json"
                    }
                    self.signaling?.send(type: "OFFER", dst: self.remoteId, payload: payload)
                }
            }
        }
    }

    /// ANSWER / CANDIDATE от удалённой стороны (уже отфильтрованы по connectionId).
    func handle(type: String, payload: [String: Any]) {
        guard !isClosed else { return }
        switch type {
        case "ANSWER":
            guard let sdpObject = payload["sdp"] as? [String: Any], let sdp = sdpObject["sdp"] as? String else { return }
            pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
                DispatchQueue.main.async {
                    guard let self = self, !self.isClosed else { return }
                    if error != nil { self.close(); return }
                    self.remoteDescriptionSet = true
                    let queued = self.pendingCandidates
                    self.pendingCandidates = []
                    queued.forEach { self.pc.add($0) { _ in } }
                }
            }
        case "CANDIDATE":
            guard let c = payload["candidate"] as? [String: Any], let line = c["candidate"] as? String, !line.isEmpty else { return }
            let index = (c["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
            let candidate = RTCIceCandidate(sdp: line, sdpMLineIndex: index, sdpMid: c["sdpMid"] as? String)
            if remoteDescriptionSet { pc.add(candidate) { _ in } } else { pendingCandidates.append(candidate) }
        default:
            break
        }
    }

    // MARK: - Данные

    @discardableResult
    func send(_ object: [String: Any]) -> Bool {
        guard let channel = channel, channel.readyState == .open, kind == .data,
              let data = try? JSONSerialization.data(withJSONObject: object) else { return false }
        return channel.sendData(RTCDataBuffer(data: data, isBinary: true))
    }

    /// Битрейт и частота отправки видео. Вызывать после соединения (до него encodings пустые).
    func applyEncoding(maxBitrate: Int, maxFramerate: Int) {
        guard let sender = videoSender else { return }
        let parameters = sender.parameters
        guard let encoding = parameters.encodings.first else { return }
        encoding.maxBitrateBps = NSNumber(value: maxBitrate)
        encoding.maxFramerate = NSNumber(value: maxFramerate)
        encoding.scaleResolutionDownBy = NSNumber(value: 1)
        parameters.encodings = [encoding] + parameters.encodings.dropFirst()
        parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
        sender.parameters = parameters
    }

    func close() {
        guard !isClosed else { return }
        isClosed = true
        isOpen = false
        channel?.delegate = nil
        channel?.close()
        pc.close()
        let callback = onClose
        onClose = nil
        onOpen = nil
        onMessage = nil
        callback?()
    }

    private func markOpen() {
        guard !isOpen, !isClosed else { return }
        isOpen = true
        onOpen?()
    }

    // MARK: - RTCPeerConnectionDelegate (вызывается на потоке WebRTC — переносим на главный)

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        DispatchQueue.main.async {
            guard !self.isClosed else { return }
            var c: [String: Any] = ["candidate": candidate.sdp, "sdpMLineIndex": candidate.sdpMLineIndex]
            c["sdpMid"] = candidate.sdpMid ?? NSNull()
            self.signaling?.send(type: "CANDIDATE", dst: self.remoteId, payload: [
                "candidate": c,
                "type": self.kind == .data ? "data" : "media",
                "connectionId": self.connectionId
            ])
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        DispatchQueue.main.async {
            guard !self.isClosed else { return }
            switch newState {
            case .connected:
                if self.kind == .media { self.markOpen() }
            case .disconnected:
                self.onUnstable?()
            case .failed, .closed:
                self.close()
            default:
                break
            }
        }
    }

    // MARK: - RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        let state = dataChannel.readyState
        DispatchQueue.main.async {
            guard !self.isClosed else { return }
            if state == .open, self.kind == .data { self.markOpen() }
            if state == .closed { self.close() }
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        DispatchQueue.main.async {
            guard !self.isClosed,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            if let peerData = object["__peerData"] as? [String: Any], peerData["type"] as? String == "close" {
                self.close()
                return
            }
            self.onMessage?(object)
        }
    }
}
