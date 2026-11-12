import Foundation

@MainActor protocol ControllerTransport: AnyObject {
    func request(base: URL, path: String, method: String, token: String?, body: [String: Any]?) async throws -> Data
    func open(_ url: URL)
    func send(_ payload: [String: Any]) async throws
    func receive() async throws -> Data
    func close()
}

@MainActor final class NetworkTransport: ControllerTransport {
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
    }
    func request(base: URL, path: String, method: String, token: String?, body: [String: Any]?) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError(message: "No controller response.") }
        guard (200..<300).contains(response.statusCode) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let error = json?["error"] as? [String: Any]
            throw APIError(message: error?["message"] as? String ?? json?["message"] as? String ?? "Controller rejected the request (\(response.statusCode)).", code: error?["code"] as? String ?? json?["code"] as? String)
        }
        return data
    }
    func open(_ url: URL) { close(); socket = session.webSocketTask(with: url); socket?.resume() }
    func send(_ payload: [String: Any]) async throws {
        guard let socket else { throw APIError(message: "Controller is disconnected.") }
        let data = try JSONSerialization.data(withJSONObject: payload)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
    func receive() async throws -> Data {
        guard let socket else { throw APIError(message: "Controller is disconnected.") }
        switch try await socket.receive() {
        case .string(let text): return Data(text.utf8)
        case .data(let data): return data
        @unknown default: throw APIError(message: "Unsupported controller response.")
        }
    }
    func close() { socket?.cancel(with: .goingAway, reason: nil); socket = nil }
}
