import Foundation

/*
 * Клиент сигнального сервера PeerJS (тот же облачный 0.peerjs.com, что и у веб-версии).
 * Протокол PeerJS 1.5: WebSocket wss://host:port/path/peerjs?key=…&id=…&token=…&version=…,
 * сервер шлёт {type:"OPEN"}, клиент раз в 5 с шлёт {type:"HEARTBEAT"},
 * сообщения OFFER / ANSWER / CANDIDATE / LEAVE / EXPIRE ходят как {type, payload, dst|src}.
 */

protocol PeerSignalingDelegate: AnyObject {
    func signalingDidOpen(_ signaling: PeerSignaling)
    func signaling(_ signaling: PeerSignaling, didCloseWith error: String?, idTaken: Bool)
    func signaling(_ signaling: PeerSignaling, didReceive type: String, from src: String?, payload: [String: Any]?)
}

final class PeerSignaling: NSObject, URLSessionWebSocketDelegate {
    struct Server {
        var host = "0.peerjs.com"
        var port = 443
        var path = "/"
        var key = "peerjs"
        var secure = true
    }

    static let protocolVersion = "1.5.4"

    let server: Server
    let peerId: String
    weak var delegate: PeerSignalingDelegate?

    private(set) var isOpen = false
    private(set) var isConnecting = false
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var heartbeat: Timer?
    private var generation = 0

    init(peerId: String, server: Server = Server()) {
        self.peerId = peerId
        self.server = server
        super.init()
    }

    func connect() {
        teardown()
        generation += 1
        let gen = generation

        var comps = URLComponents()
        comps.scheme = server.secure ? "wss" : "ws"
        comps.host = server.host
        comps.port = server.port
        let base = server.path.hasSuffix("/") ? server.path : server.path + "/"
        comps.path = base + "peerjs"
        comps.queryItems = [
            URLQueryItem(name: "key", value: server.key),
            URLQueryItem(name: "id", value: peerId),
            URLQueryItem(name: "token", value: RandomID.make(16)),
            URLQueryItem(name: "version", value: Self.protocolVersion)
        ]
        guard let url = comps.url else { return }

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        isConnecting = true
        task.resume()
        receive(gen)

        heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.sendRaw(["type": "HEARTBEAT"])
        }
    }

    func disconnect() {
        generation += 1
        teardown()
    }

    func send(type: String, dst: String, payload: [String: Any]) {
        sendRaw(["type": type, "dst": dst, "payload": payload])
    }

    // MARK: - Internal

    private func teardown() {
        heartbeat?.invalidate()
        heartbeat = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isOpen = false
        isConnecting = false
    }

    private func sendRaw(_ object: [String: Any]) {
        guard let task = task,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func receive(_ gen: Int) {
        task?.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, gen == self.generation else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text): self.handle(Data(text.utf8))
                    case .data(let data): self.handle(data)
                    @unknown default: break
                    }
                    self.receive(gen)
                case .failure(let error):
                    self.fail(error.localizedDescription, idTaken: false)
                }
            }
        }
    }

    private func handle(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        let src = object["src"] as? String
        let payload = object["payload"] as? [String: Any]
        switch type {
        case "OPEN":
            isOpen = true
            isConnecting = false
            delegate?.signalingDidOpen(self)
        case "ID-TAKEN":
            fail("ID занят", idTaken: true)
        case "ERROR", "INVALID-KEY":
            fail((payload?["msg"] as? String) ?? type, idTaken: false)
        default:
            delegate?.signaling(self, didReceive: type, from: src, payload: payload)
        }
    }

    private func fail(_ reason: String?, idTaken: Bool) {
        let wasActive = task != nil
        generation += 1
        teardown()
        if wasActive { delegate?.signaling(self, didCloseWith: reason, idTaken: idTaken) }
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        fail("сервер закрыл соединение", idTaken: false)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        fail(error?.localizedDescription ?? "соединение завершено", idTaken: false)
    }
}

enum RandomID {
    static func make(_ length: Int, alphabet: String = "abcdefghijklmnopqrstuvwxyz0123456789") -> String {
        let chars = Array(alphabet)
        return String((0..<length).map { _ in chars[Int.random(in: 0..<chars.count)] })
    }
}
