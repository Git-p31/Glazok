import Foundation
import WebRTC

/*
 * Серверы ICE — так же, как config.js веб-версии:
 * настройки TURN (имя приложения Metered + apiKey) приходят из QR-кода монитора (?t=app:key),
 * временные логин/пароль запрашиваются у Metered. Без TURN — только STUN (работает в одной Wi‑Fi сети).
 */
enum IceConfig {
    static let fallback: [RTCIceServer] = [
        RTCIceServer(urlStrings: ["stun:stun.relay.metered.ca:80"]),
        RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])
    ]

    struct Result {
        let servers: [RTCIceServer]
        let note: String
    }

    static func load(app: String, apiKey: String) async -> Result {
        guard !app.isEmpty, !apiKey.isEmpty,
              var comps = URLComponents(string: "https://\(app).metered.live/api/v1/turn/credentials") else {
            return Result(servers: fallback, note: "TURN не настроен — только локальная сеть")
        }
        comps.queryItems = [URLQueryItem(name: "apiKey", value: apiKey)]
        guard let url = comps.url else { return Result(servers: fallback, note: "TURN: неверные настройки") }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        request.httpMethod = "GET"
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                return Result(servers: fallback, note: "TURN недоступен (HTTP \(http.statusCode))")
            }
            var list: [[String: Any]] = []
            let json = try JSONSerialization.jsonObject(with: data)
            if let array = json as? [[String: Any]] { list = array }
            else if let object = json as? [String: Any], let array = object["iceServers"] as? [[String: Any]] { list = array }

            let servers: [RTCIceServer] = list.compactMap { item in
                let urls: [String]
                if let single = item["urls"] as? String { urls = [single] }
                else if let many = item["urls"] as? [String] { urls = many }
                else { return nil }
                return RTCIceServer(urlStrings: urls, username: item["username"] as? String, credential: item["credential"] as? String)
            }
            let hasTurn = servers.contains { $0.urlStrings.contains { $0.hasPrefix("turn") } }
            if servers.isEmpty || !hasTurn { return Result(servers: fallback, note: "TURN: пустой ответ") }
            return Result(servers: servers, note: "TURN подключён")
        } catch {
            return Result(servers: fallback, note: "TURN недоступен: \(error.localizedDescription)")
        }
    }

    static func configuration(_ servers: [RTCIceServer]) -> RTCConfiguration {
        let config = RTCConfiguration()
        config.iceServers = servers
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        config.iceCandidatePoolSize = 2
        return config
    }
}
