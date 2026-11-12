import XCTest
@testable import Flashify

@MainActor final class FakeTransport: ControllerTransport {
    var requests: [(String, String?, [String: Any]?)] = []
    var sent: [[String: Any]] = []
    var closed = false
    var opened: URL?
    var openCount = 0
    var incoming: [Result<Data, Error>] = []
    var requestHandler: ((String) async throws -> Data)?
    var setupRequired = false
    var response = Data(#"{"token":"secret"}"#.utf8)
    var receiver: CheckedContinuation<Data, Error>?
    func request(base: URL, path: String, method: String, token: String?, body: [String: Any]?) async throws -> Data {
        requests.append((path, token, body)); if let requestHandler { return try await requestHandler(path) }; if path == "api/health" { return Data("{\"setupRequired\":\(setupRequired)}".utf8) }; return response
    }
    func open(_ url: URL) { openCount += 1; opened = url; closed = false }
    func send(_ payload: [String: Any]) async throws { sent.append(payload) }
    func receive() async throws -> Data { if !incoming.isEmpty { return try incoming.removeFirst().get() }; return try await withCheckedThrowingContinuation { receiver = $0 } }
    func close() { closed = true; receiver?.resume(throwing: CancellationError()); receiver = nil }
}
@MainActor final class ConnectionTests: XCTestCase {
    let state = #"{"type":"state","snapshot":{"revision":3,"mode":"manual","blackout":false,"master":0.7,"activeSceneId":"custom","music":{"running":false,"rms":0,"bass":0,"onset":false},"show":{"currentCueIndex":0,"phase":"idle"},"fixtures":{"f1":{"dimmer":0.4}},"controller":{"roomName":"Real Room","driver":"simulator","tickHz":40},"config":{"profiles":[],"fixtures":[],"scenes":[{"id":"custom","name":"Custom scene","values":{}}],"cues":[{"id":"c1","name":"Actual cue","sceneId":"custom","fadeMs":250}]}}}"#
    func testAddressesAndBackoff() throws {
        XCTAssertEqual(try ServerAddress.parse(" 192.168.1.20:4173 ").absoluteString, "http://192.168.1.20:4173")
        XCTAssertEqual(ServerAddress.websocket(try ServerAddress.parse("https://controller.local:443")).absoluteString, "wss://controller.local:443/ws")
        for invalid in ["", "ftp://host", "http://user:pass@host", "host/path", "host?token=x", "http://host:0"] { XCTAssertThrowsError(try ServerAddress.parse(invalid)) }
        XCTAssertEqual(ReconnectPolicy.delay(attempt: 0, jitter: 1), 1)
        XCTAssertEqual(ReconnectPolicy.delay(attempt: 10, jitter: 1), 30)
    }
    func testNoInventedStateAndWelcomeGatesConnection() throws {
        let store = ConnectionStore(transport: FakeTransport())
        XCTAssertNil(store.snapshot); XCTAssertFalse(store.connected); XCTAssertFalse(store.canControl)
        XCTAssertThrowsError(try store.handle(Data(state.utf8)))
        try store.handle(Data(#"{"type":"welcome","protocolVersion":1,"role":"viewer"}"#.utf8))
        XCTAssertFalse(store.connected)
        try store.handle(Data(state.utf8))
        XCTAssertTrue(store.connected); XCTAssertFalse(store.canControl)
        XCTAssertEqual(store.snapshot?.config.scenes.first?.name, "Custom scene")
        XCTAssertEqual(store.snapshot?.config.cues.first?.name, "Actual cue")
        XCTAssertEqual(store.snapshot?.master, 0.7)
        store.disconnect(); XCTAssertNil(store.snapshot)
    }
    func testConfigurationAliasAndRejectMissingConfig() throws {
        let store = ConnectionStore(transport: FakeTransport())
        try store.handle(Data(#"{"type":"welcome","protocolVersion":1,"role":"operator"}"#.utf8))
        try store.handle(Data(state.replacingOccurrences(of: "\"config\":", with: "\"configuration\":").utf8))
        XCTAssertTrue(store.canControl)
        let invalid = #"{"type":"state","snapshot":{"revision":1}}"#
        XCTAssertThrowsError(try store.handle(Data(invalid.utf8)))
    }
    func testSignInHelloAndAcknowledgedCommand() async throws {
        let transport = FakeTransport(); let store = ConnectionStore(transport: transport)
        await store.signIn(address: "controller.local:4173", pin: "135790")
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(transport.requests.first { $0.0 == "api/auth/login" }?.0, "api/auth/login")
        XCTAssertEqual(transport.requests.first { $0.0 == "api/auth/login" }?.2?["pin"] as? String, "135790")
        XCTAssertEqual(transport.sent.first?["type"] as? String, "hello")
        XCTAssertEqual(transport.sent.first?["token"] as? String, "secret")
        XCTAssertFalse(store.connected)
        try store.handle(Data(#"{"type":"welcome","protocolVersion":1,"role":"operator"}"#.utf8))
        try store.handle(Data(state.utf8))
        store.send(type: "master.set", body: ["value": 0.2])
        for _ in 0..<10 { await Task.yield() }
        let command = try XCTUnwrap(transport.sent.last)
        let id = try XCTUnwrap(command["id"] as? String)
        XCTAssertEqual(command["type"] as? String, "master.set")
        XCTAssertEqual(store.snapshot?.master, 0.7)
        XCTAssertTrue(store.pending.contains(id))
        try store.handle(Data("{\"type\":\"ack\",\"id\":\"\(id)\",\"ok\":false,\"error\":{\"code\":\"LEASE_REQUIRED\",\"message\":\"Lease lost\"}}".utf8))
        XCTAssertTrue(store.pending.isEmpty); XCTAssertEqual(store.error, "Lease lost"); XCTAssertFalse(store.canControl)
        store.disconnect()
    }
    func testSetupUsesBootstrapTokenAndViewerCannotSend() async throws {
        let transport = FakeTransport(); let store = ConnectionStore(transport: transport)
        transport.setupRequired = true
        await store.inspect(address: "controller.local:4173")
        XCTAssertTrue(store.setupRequired)
        transport.response = Data(#"{"token":"secret"}"#.utf8)
        await store.signIn(address: "controller.local:4173", pin: "135790", setupToken: "local-token")
        XCTAssertEqual(transport.requests.last?.0, "api/auth/setup")
        XCTAssertEqual(transport.requests.last?.2?["bootstrapToken"] as? String, "local-token")
        store.send(type: "show.go"); XCTAssertTrue(store.pending.isEmpty)
        store.disconnect()
    }
    func testReconnectReauthenticatesAndAcceptsFreshAuthoritativeRevision() async throws {
        let transport = FakeTransport()
        let welcome = Data(#"{"type":"welcome","protocolVersion":1,"role":"operator"}"#.utf8)
        let fresh = state.replacingOccurrences(of: "\"revision\":3", with: "\"revision\":1")
        transport.incoming = [.success(welcome), .success(Data(state.utf8)), .failure(APIError(message: "Network lost")), .success(welcome), .success(Data(fresh.utf8))]
        var delays: [Double] = []
        let store = ConnectionStore(transport: transport, sleep: { seconds in
            if seconds == 5 { try await Task.sleep(for: .seconds(3600)); return }
            delays.append(seconds)
        })
        await store.signIn(address: "controller.local:4173", pin: "135790")
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(transport.openCount, 2)
        XCTAssertEqual(transport.sent.filter { $0["type"] as? String == "hello" }.count, 2)
        XCTAssertEqual(delays.count, 1)
        XCTAssertTrue((0.8...1.2).contains(try XCTUnwrap(delays.first)))
        XCTAssertTrue(store.connected); XCTAssertFalse(store.reconnecting)
        XCTAssertEqual(store.snapshot?.revision, 1); XCTAssertNil(store.error)
        store.disconnect()
    }
    func testExpiredSessionStopsReconnecting() async throws {
        let transport = FakeTransport()
        transport.incoming = [.success(Data(#"{"type":"ack","ok":false,"error":{"code":"UNAUTHORIZED","message":"Sign in again"}}"#.utf8))]
        let store = ConnectionStore(transport: transport)
        await store.signIn(address: "controller.local:4173", pin: "135790")
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(store.connected); XCTAssertFalse(store.reconnecting)
        XCTAssertEqual(store.error, "Sign in again"); XCTAssertEqual(transport.openCount, 1)
        store.disconnect()
    }
    func testLateLoginCannotReconnectAfterDisconnect() async throws {
        let transport = FakeTransport()
        var login: CheckedContinuation<Data, Error>?
        transport.requestHandler = { path in
            if path == "api/health" { return Data(#"{"setupRequired":false}"#.utf8) }
            return try await withCheckedThrowingContinuation { login = $0 }
        }
        let store = ConnectionStore(transport: transport)
        let task = Task { await store.signIn(address: "controller.local:4173", pin: "135790") }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertNotNil(login)
        store.disconnect()
        login?.resume(returning: Data(#"{"token":"late-secret"}"#.utf8))
        await task.value
        XCTAssertFalse(store.connected); XCTAssertNil(transport.opened); XCTAssertFalse(store.busy)
    }

    func testActualServerSnapshotFixtureUsesConfigurationAndRealCues() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "server-state", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(json["configuration"]); XCTAssertNil(json["config"])
        let state = try JSONDecoder().decode(FlashifySnapshot.self, from: data)
        XCTAssertEqual(state.controller.roomName, "iOS Contract Room")
        XCTAssertEqual(state.config.scenes.first?.name, "Server captured scene")
        XCTAssertEqual(state.config.cues.first?.sceneId, state.config.scenes.first?.id)
        let fixture = try XCTUnwrap(state.config.fixtures.first)
        XCTAssertEqual(fixture.name, "Contract light")
        XCTAssertEqual(state.config.attributes(for: fixture), ["dimmer"])
        XCTAssertEqual(state.fixtures[fixture.id]?["dimmer"], 0.35)
        let envelope = try JSONSerialization.data(withJSONObject: ["type": "state", "snapshot": json])
        let store = ConnectionStore(transport: FakeTransport())
        try store.handle(Data(#"{"type":"welcome","protocolVersion":1,"role":"viewer"}"#.utf8))
        try store.handle(envelope)
        XCTAssertTrue(store.connected)
        XCTAssertEqual(store.snapshot, state)
    }
    func testAuthenticatedViewerCanSendEmergencyBlackout() async throws {
        let transport = FakeTransport(); let store = ConnectionStore(transport: transport)
        try store.handle(Data(#"{"type":"welcome","protocolVersion":1,"role":"viewer"}"#.utf8))
        try store.handle(Data(state.utf8))
        store.send(type: "master.set", body: ["value": 1])
        XCTAssertTrue(store.pending.isEmpty)
        store.send(type: "blackout.set", body: ["on": true])
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(transport.sent.last?["type"] as? String, "blackout.set")
        XCTAssertFalse(store.snapshot?.blackout ?? true)
        store.disconnect()
    }

}
