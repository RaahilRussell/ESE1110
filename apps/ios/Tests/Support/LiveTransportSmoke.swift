import Foundation

@main struct LiveTransportSmoke {
    @MainActor static func wait(_ description: String, until predicate: () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw APIError(message: "Timed out: \(description)")
    }
    @MainActor static func main() async throws {
        let base = try ServerAddress.parse(CommandLine.arguments[1])
        let store = ConnectionStore()
        defer { store.disconnect() }
        await store.signIn(address: base.absoluteString, pin: "192837")
        try await wait("authenticated welcome and real snapshot") { store.connected }
        guard let state = store.snapshot, state.controller.roomName == "iOS Contract Room",
              state.config.scenes.first?.name == "Server captured scene",
              state.config.cues.first?.id == "contract-cue", !store.canControl else {
            throw APIError(message: "The real server snapshot did not match its seeded configuration.")
        }
        await store.acquireControl()
        guard store.canControl else { throw APIError(message: "Lease acquisition failed: \(store.error ?? "unknown")") }
        store.send(type: "fixture.set", body: ["fixtureId": "contract-fixture", "values": ["dimmer": 0.65], "fadeMs": 0, "takeover": false])
        try await wait("fixture command ack and authoritative state") { store.pending.isEmpty && store.snapshot?.fixtures["contract-fixture"]?["dimmer"] == 0.65 }
        store.send(type: "show.go")
        try await wait("show cue ack and authoritative index") { store.pending.isEmpty && store.snapshot?.show.currentCueId == "contract-cue" }
        store.send(type: "blackout.set", body: ["on": true])
        try await wait("blackout ack and authoritative state") { store.pending.isEmpty && store.snapshot?.blackout == true }
        guard store.error == nil else { throw APIError(message: store.error!) }
        print("Live Swift transport passed: login, authenticated hello, configuration snapshot, lease, fixture ack/state, real cue, blackout.")
    }
}
