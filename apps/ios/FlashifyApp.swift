import SwiftUI

@main struct FlashifyApp: App {
    @StateObject private var store = ConnectionStore()
    var body: some Scene { WindowGroup { RootView().environmentObject(store) } }
}
struct RootView: View {
    @EnvironmentObject var store: ConnectionStore
    @State private var connectionSheet = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Circle().fill(store.connected ? .green : .orange).frame(width: 8, height: 8)
                Text(store.connected ? (store.snapshot?.controller.roomName ?? "Controller") : store.reconnecting ? "Reconnecting…" : "Disconnected").font(.caption)
                Spacer()
                Button("Connection") { connectionSheet = true }
            }.padding()
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal).accessibilityIdentifier("connectionError") }
            if store.connected && store.role != "operator" {
                Button("Acquire operator control") { Task { await store.acquireControl() } }.buttonStyle(.bordered).padding(8)
            }
            if !store.pending.isEmpty { Text("Waiting for controller acknowledgement…").font(.caption).foregroundStyle(.secondary) }
            TabView {
                HomeView().tabItem { Label("Home", systemImage: "house") }
                DesignView().tabItem { Label("Design", systemImage: "lightbulb") }
                ShowView().tabItem { Label("Show", systemImage: "play.rectangle") }
                MusicView().tabItem { Label("Music", systemImage: "waveform") }
            }
            Button {
                if let state = store.snapshot { store.send(type: "blackout.set", body: ["on": !state.blackout]) }
            } label: {
                Label(store.snapshot?.blackout == true ? "Release blackout" : "Blackout", systemImage: "xmark.octagon.fill").frame(maxWidth: .infinity).padding(.vertical, 10)
            }.buttonStyle(.borderedProminent).tint(.red).disabled(!store.connected).padding(.horizontal)
        }
        .sheet(isPresented: $connectionSheet) { ConnectionView() }
        .onAppear { if !store.connected { connectionSheet = true } }
    }
}
struct ConnectionView: View {
    @EnvironmentObject var store: ConnectionStore
    @StateObject private var discovery = ControllerDiscovery()
    @AppStorage("controllerAddress") private var address = ""
    @State private var pin = ""
    @State private var setupToken = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Controller") {
                    TextField("http://192.168.1.20:4173", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Check controller") { Task { await store.inspect(address: address) } }.disabled(store.busy)
                    ForEach(discovery.controllers) { controller in
                        Button(controller.name) { address = controller.address; Task { await store.inspect(address: address) } }
                    }
                    if let error = discovery.error { Text(error).font(.caption) }
                }
                Section(store.setupRequired ? "First connection" : "Sign in") {
                    SecureField("Controller PIN", text: $pin).keyboardType(.numberPad)
                    if store.setupRequired {
                        SecureField("Setup token from controller console", text: $setupToken)
                        Text("Choose a PIN and enter the setup token displayed on the controller.").font(.caption)
                    }
                    Button(store.setupRequired ? "Set up and connect" : "Sign in and connect") {
                        Task { await store.signIn(address: address, pin: pin, setupToken: setupToken); pin = ""; setupToken = "" }
                    }.disabled(store.busy || address.isEmpty || pin.isEmpty || (store.setupRequired && setupToken.isEmpty))
                }
                if let error = store.error { Section { Text(error).foregroundStyle(.red) } }
                if store.connected { Section { Text("Connected as \(store.role)"); Button("Disconnect") { store.disconnect() } } }
            }
            .navigationTitle("Connection")
            .toolbar { Button("Done") { dismiss() } }
            .onChange(of: store.connected) { _, connected in if connected { dismiss() } }
            .task { discovery.start() }
            .onDisappear { discovery.stop() }
        }
    }
}
struct HomeView: View {
    @EnvironmentObject var store: ConnectionStore
    @State private var fade = 3
    var body: some View {
        NavigationStack {
            List {
                if let state = store.snapshot {
                    Section("Grand master · \(Int(state.master * 100))%") {
                        LevelControl(value: state.master) { store.send(type: "master.set", body: ["value": $0]) }.disabled(!store.canControl)
                    }
                    Section("Scenes") {
                        Picker("Fade", selection: $fade) { Text("Instant").tag(0); Text("1 sec").tag(1); Text("3 sec").tag(3); Text("5 sec").tag(5) }
                        ForEach(state.config.scenes) { scene in
                            Button {
                                store.send(type: "scene.activate", body: ["sceneId": scene.id, "fadeMs": fade * 1000, "groupIds": [], "takeover": false])
                            } label: { HStack { Text(scene.name); Spacer(); if state.activeSceneId == scene.id { Image(systemName: "checkmark") } } }.disabled(!store.canControl)
                        }
                        if state.config.scenes.isEmpty { Text("No scenes configured.") }
                    }
                } else { Text("Connect to a controller to see its scenes.").foregroundStyle(.secondary) }
            }.navigationTitle("Home")
        }
    }
}
// The slider is an edit draft; reported output changes only on authoritative snapshots.
struct LevelControl: View {
    let value: Double
    let commit: (Double) -> Void
    @State private var draft: Double = 0
    @State private var editing = false
    var body: some View {
        Slider(value: $draft, in: 0...1, onEditingChanged: { active in
            editing = active
            if !active { commit(draft) }
        })
        .onAppear { draft = value }
        .onChange(of: value) { _, newValue in if !editing { draft = newValue } }
    }
}
struct DesignView: View {
    @EnvironmentObject var store: ConnectionStore
    @State private var name = ""
    @State private var selectedGroup = ""
    @State private var groupDimmer = 0.5
    var body: some View {
        NavigationStack {
            List {
                if let state = store.snapshot {
                    Section("Groups") {
                        let groups = Array(Set(state.config.fixtures.flatMap(\.groupIds))).sorted()
                        if groups.isEmpty { Text("No groups configured.") }
                        else {
                            Picker("Group", selection: $selectedGroup) {
                                Text("Choose group").tag("")
                                ForEach(groups, id: \.self) { Text($0).tag($0) }
                            }
                            Slider(value: $groupDimmer, in: 0...1)
                            Button("Apply group dimmer") { store.send(type: "group.set", body: ["groupId": selectedGroup, "values": ["dimmer": groupDimmer], "fadeMs": 0, "takeover": false]) }.disabled(!store.canControl || selectedGroup.isEmpty || !state.config.fixtures.filter { $0.enabled && $0.groupIds.contains(selectedGroup) }.allSatisfy { state.config.attributes(for: $0).contains("dimmer") })
                        }
                    }
                    ForEach(state.config.fixtures) { fixture in
                        Section("\(fixture.name) · address \(fixture.address)") {
                            if !fixture.enabled { Text("Disabled in controller configuration") }
                            ForEach(state.config.attributes(for: fixture), id: \.self) { attribute in
                                VStack(alignment: .leading) {
                                    Text("\(attribute.capitalized) · \(Int((state.fixtures[fixture.id]?[attribute] ?? 0) * 100))%")
                                    LevelControl(value: state.fixtures[fixture.id]?[attribute] ?? 0) { value in
                                        store.send(type: "fixture.set", body: ["fixtureId": fixture.id, "values": [attribute: value], "fadeMs": 0, "takeover": false])
                                    }
                                }.disabled(!store.canControl || !fixture.enabled)
                            }
                            Button("Identify") { store.send(type: "fixture.identify", body: ["fixtureId": fixture.id, "durationMs": 1000]) }.disabled(!store.canControl || !fixture.enabled)
                        }
                    }
                    Section("Save current output") {
                        TextField("Scene name", text: $name)
                        Button("Save as scene") { store.send(type: "scene.save", body: ["sceneId": UUID().uuidString, "name": name.trimmingCharacters(in: .whitespacesAndNewlines), "clearOthers": true]) }.disabled(!store.canControl || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80)
                    }
                } else { Text("Connect to see patched fixtures.") }
            }.navigationTitle("Design")
        }
    }
}
struct ShowView: View {
    @EnvironmentObject var store: ConnectionStore
    var body: some View {
        NavigationStack {
            List {
                if let state = store.snapshot {
                    Section("Playback · \(state.show.phase)") {
                        ForEach(Array(state.config.cues.enumerated()), id: \.element.id) { index, cue in
                            HStack { Text(cue.name); Spacer(); if state.show.currentCueIndex == index { Image(systemName: "play.fill") }; Text("\(Double(cue.fadeMs) / 1000, specifier: "%.1f") sec").foregroundStyle(.secondary) }
                        }
                        if state.config.cues.isEmpty { Text("No cues configured.") }
                    }
                    Section {
                        HStack {
                            Button("Back") { store.send(type: "show.back") }
                            Spacer()
                            Button("GO") { store.send(type: "show.go") }.font(.title.bold())
                            Spacer()
                            Button("Stop") { store.send(type: "show.stop") }
                        }.disabled(!store.canControl || state.config.cues.isEmpty)
                    }
                } else { Text("Connect to see the controller’s cues.") }
            }.navigationTitle("Show")
        }
    }
}
struct MusicView: View {
    @EnvironmentObject var store: ConnectionStore
    var body: some View {
        NavigationStack {
            Form {
                if let state = store.snapshot {
                    LabeledContent("Status", value: state.music.running ? "Running" : "Stopped")
                    LabeledContent("Source", value: state.music.source ?? "Unknown")
                    if state.music.stale == true { Text("Audio input is stale.").foregroundStyle(.orange) }
                    LabeledContent("Input level", value: "\(Int(state.music.rms * 100))%")
                    ProgressView(value: state.music.rms)
                    LabeledContent("Bass", value: "\(Int(state.music.bass * 100))%")
                    Button(state.music.running ? "Stop music" : "Start music") { store.send(type: state.music.running ? "music.stop" : "music.start") }.disabled(!store.canControl)
                } else { Text("Connect to see audio status.") }
            }.navigationTitle("Music")
        }
    }
}
