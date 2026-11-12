import Foundation
import Combine

@MainActor final class ConnectionStore: ObservableObject {
    @Published private(set) var snapshot: FlashifySnapshot?
    @Published private(set) var connected = false
    @Published private(set) var reconnecting = false
    @Published private(set) var role = "viewer"
    @Published private(set) var busy = false
    @Published private(set) var pending: Set<String> = []
    @Published var error: String?
    @Published private(set) var setupRequired = false
    private let transport: ControllerTransport
    private let sleep: (Double) async throws -> Void
    private var base: URL?
    private var token: String?
    private var loop: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var generation = UUID()
    private var welcomed = false
    private var deadlines: [String: Date] = [:]
    var canControl: Bool { connected && role == "operator" }

    init(transport: ControllerTransport? = nil, sleep: @escaping (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) {
        self.transport = transport ?? NetworkTransport(); self.sleep = sleep
    }
    func inspect(address: String) async {
        disconnect(); let current = generation; busy = true; defer { if current == generation { busy = false } }
        do {
            let url = try ServerAddress.parse(address)
            let data = try await transport.request(base: url, path: "api/health", method: "GET", token: nil, body: nil)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard current == generation else { return }
            base = url; setupRequired = json?["setupRequired"] as? Bool ?? false
        } catch { if current == generation { self.error = error.localizedDescription } }
    }
    func signIn(address: String, pin: String, setupToken: String = "") async {
        disconnect(); let current = generation; busy = true; defer { if current == generation { busy = false } }
        do {
            let url = try ServerAddress.parse(address)
            let health = try await transport.request(base: url, path: "api/health", method: "GET", token: nil, body: nil)
            let status = try JSONSerialization.jsonObject(with: health) as? [String: Any]
            guard current == generation else { return }
            setupRequired = status?["setupRequired"] as? Bool ?? false
            var body: [String: Any] = ["pin": pin]
            if setupRequired { body["bootstrapToken"] = setupToken }
            let data = try await transport.request(base: url, path: setupRequired ? "api/auth/setup" : "api/auth/login", method: "POST", token: nil, body: body)
            let auth = try JSONDecoder().decode(AuthSession.self, from: data)
            guard current == generation else { return }
            base = url; token = auth.token; setupRequired = false; start()
        } catch { if current == generation { self.error = error.localizedDescription } }
    }
    func disconnect() {
        generation = UUID(); loop?.cancel(); heartbeat?.cancel(); loop = nil; heartbeat = nil
        transport.close(); connected = false; reconnecting = false; welcomed = false
        snapshot = nil; token = nil; busy = false; role = "viewer"; pending.removeAll(); deadlines.removeAll(); error = nil
    }
    private func start() {
        guard let base, let token else { return }
        let current = generation
        loop = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled && self.generation == current {
                do {
                    self.transport.open(ServerAddress.websocket(base))
                    try await self.transport.send(["type": "hello", "token": token, "protocolVersion": 1])
                    self.beginHeartbeat(generation: current)
                    while !Task.isCancelled && self.generation == current {
                        let data = try await self.transport.receive()
                        guard self.generation == current else { return }
                        try self.handle(data)
                        if self.connected { attempt = 0 }
                    }
                } catch {
                    guard !Task.isCancelled && self.generation == current else { return }
                    self.connected = false; self.welcomed = false; self.role = "viewer"; self.reconnecting = true
                    self.error = error.localizedDescription; self.pending.removeAll(); self.deadlines.removeAll()
                    self.heartbeat?.cancel(); self.transport.close()
                    if (error as? APIError)?.code == "UNAUTHORIZED" {
                        self.token = nil; self.reconnecting = false; return
                    }
                    do { try await self.sleep(ReconnectPolicy.delay(attempt: attempt)) } catch { return }
                    attempt += 1
                }
            }
        }
    }
    private func beginHeartbeat(generation current: UUID) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            guard let self else { return }
            let started = Date()
            while !Task.isCancelled && self.generation == current {
                do {
                    try await self.sleep(5)
                    guard !Task.isCancelled && self.generation == current else { return }
                    if (!self.connected && Date().timeIntervalSince(started) > 15) || self.deadlines.values.contains(where: { $0 < Date() }) {
                        self.error = "Controller response timed out. Reconnecting…"; self.connected = false; self.transport.close(); return
                    }
                    let id = UUID().uuidString
                    self.deadlines[id] = Date().addingTimeInterval(15)
                    try await self.transport.send(["type": self.role == "operator" ? "heartbeat" : "ping", "id": id])
                } catch { self.transport.close(); return }
            }
        }
    }
    func handle(_ data: Data) throws {
        let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
        switch envelope.type {
        case "welcome":
            guard envelope.protocolVersion == 1 else { throw APIError(message: "The controller uses an incompatible protocol.") }
            welcomed = true; role = envelope.role ?? "viewer"
        case "state":
            guard welcomed, let state = envelope.snapshot else { throw APIError(message: "Controller sent state before authentication.") }
            if let previous = snapshot, connected, state.revision < previous.revision { return }
            if reconnecting { error = nil }
            snapshot = state; connected = true; reconnecting = false
        case "ack":
            let rejectionCode = envelope.error?.code ?? envelope.code
            if envelope.ok == false && (!welcomed || rejectionCode == "UNAUTHORIZED") {
                throw APIError(message: envelope.error?.message ?? envelope.message ?? "Authentication failed.", code: rejectionCode)
            }
            guard let id = envelope.id, deadlines.removeValue(forKey: id) != nil else { return }
            pending.remove(id)
            if envelope.ok != true {
                error = envelope.error?.message ?? envelope.message ?? "The controller rejected the command."
                if ["LEASE_REQUIRED", "LEASE_HELD", "UNAUTHORIZED"].contains(envelope.error?.code ?? envelope.code ?? "") { role = "viewer" }
            }
        case "pong": if let id = envelope.id { deadlines.removeValue(forKey: id) }
        case "error": throw APIError(message: envelope.error?.message ?? envelope.message ?? "Authentication failed.", code: envelope.error?.code ?? envelope.code)
        default: break
        }
    }
    func acquireControl() async {
        guard connected, let base, let token else { return }
        let current = generation
        do {
            let data = try await transport.request(base: base, path: "api/lease/acquire", method: "POST", token: token, body: [:])
            let response = try JSONDecoder().decode(LeaseResponse.self, from: data)
            guard current == generation, connected else { return }
            role = response.role
        } catch { if current == generation { self.error = error.localizedDescription } }
    }
    func send(type: String, body: [String: Any] = [:]) {
        guard connected && (canControl || type == "blackout.set") else { error = "Connect and acquire operator control first."; return }
        let id = UUID().uuidString; let current = generation
        var payload = body; payload["type"] = type; payload["id"] = id
        pending.insert(id); deadlines[id] = Date().addingTimeInterval(15)
        Task {
            do { try await transport.send(payload) }
            catch { guard current == generation else { return }; pending.remove(id); deadlines.removeValue(forKey: id); self.error = error.localizedDescription }
        }
    }
}

struct AuthSession: Decodable { let token: String }
struct LeaseResponse: Decodable { let role: String }
struct RemoteError: Decodable { let code: String?; let message: String? }
struct ServerEnvelope: Decodable {
    let type: String; let protocolVersion: Int?; let role: String?; let snapshot: FlashifySnapshot?
    let id: String?; let ok: Bool?; let error: RemoteError?; let code: String?; let message: String?
}
