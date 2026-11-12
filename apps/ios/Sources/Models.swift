import Foundation

struct MusicState: Codable, Equatable { let running: Bool; let rms: Double; let bass: Double; let onset: Bool; var source: String?; var stale: Bool? }
struct ShowState: Codable, Equatable { let currentCueIndex: Int; let phase: String; var currentCueId: String?; var nextCueId: String? }
struct ControllerInfo: Codable, Equatable { let roomName: String; let driver: String; let tickHz: Int }
struct FlashifySnapshot: Decodable, Equatable {
    let revision: Int; let mode: String; let blackout: Bool; let master: Double
    let activeSceneId: String; let music: MusicState; let show: ShowState
    let fixtures: [String: [String: Double]]; let controller: ControllerInfo
    let config: ControllerConfig
    enum CodingKeys: String, CodingKey {
        case revision, mode, blackout, master, activeSceneId, music, show, fixtures, controller, config, configuration
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revision = try c.decode(Int.self, forKey: .revision)
        mode = try c.decode(String.self, forKey: .mode)
        blackout = try c.decode(Bool.self, forKey: .blackout)
        master = try c.decode(Double.self, forKey: .master)
        activeSceneId = try c.decode(String.self, forKey: .activeSceneId)
        music = try c.decode(MusicState.self, forKey: .music)
        show = try c.decode(ShowState.self, forKey: .show)
        fixtures = try c.decode([String: [String: Double]].self, forKey: .fixtures)
        controller = try c.decode(ControllerInfo.self, forKey: .controller)
        config = try c.decodeIfPresent(ControllerConfig.self, forKey: .config) ?? c.decode(ControllerConfig.self, forKey: .configuration)
    }
}
struct LightingScene: Codable, Identifiable, Equatable {
    let id: String; let name: String; var builtin: Bool?; let values: [String: [String: Double]]
    var clearOthers: Bool?; var revision: Int?
}
struct PatchedFixture: Codable, Identifiable, Equatable {
    let id: String; let name: String; let profileId: String; let modeId: String
    let universe: Int; let address: Int; let groupIds: [String]; let enabled: Bool
}
struct ChannelDefinition: Codable, Equatable { let attribute: String; let `default`: Double }
struct FixtureMode: Codable, Identifiable, Equatable { let id: String; let name: String; let channels: [ChannelDefinition] }
struct FixtureProfile: Codable, Identifiable, Equatable { let id: String; let model: String; let modes: [FixtureMode] }
struct ShowCue: Codable, Identifiable, Equatable { let id: String; let name: String; let sceneId: String; let fadeMs: Int }
struct ControllerConfig: Codable, Equatable {
    let profiles: [FixtureProfile]; let fixtures: [PatchedFixture]; let scenes: [LightingScene]
    let cues: [ShowCue]
    func attributes(for fixture: PatchedFixture) -> [String] {
        profiles.first { $0.id == fixture.profileId }?.modes.first { $0.id == fixture.modeId }?.channels.map(\.attribute) ?? []
    }
}
struct APIError: LocalizedError {
    let message: String
    let code: String?
    init(message: String, code: String? = nil) { self.message = message; self.code = code }
    var errorDescription: String? { message }
}

enum ServerAddress {
    static func parse(_ input: String) throws -> URL {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw APIError(message: "Enter the controller’s address.") }
        let full = text.contains("://") ? text : "http://\(text)"
        guard var parts = URLComponents(string: full), ["http", "https"].contains(parts.scheme ?? ""),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!), parts.url != nil else {
            throw APIError(message: "Use a controller address such as http://192.168.1.20:4173.")
        }
        parts.path = ""; return parts.url!
    }
    static func websocket(_ base: URL) -> URL {
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        parts.scheme = base.scheme == "https" ? "wss" : "ws"; parts.path = "/ws"
        return parts.url!
    }
}
struct ReconnectPolicy {
    static func delay(attempt: Int, jitter: Double = Double.random(in: 0.8...1.2)) -> Double {
        min(30, pow(2, Double(min(max(attempt, 0), 5))) * jitter)
    }
}
