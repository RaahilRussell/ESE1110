# Flashify

Flashify is a hardware-agnostic local DMX lighting-control platform for iPhone and web. It is designed to make professional lighting control approachable without exposing DMX complexity to beginners.

The browser client provides Looks, Design, Show, Diagnostics, and a draft-first Setup wizard. The TypeScript engine owns normalized lighting state, fades, blackout priority, command idempotency, 512-byte frame synthesis, and wizard validation. Music accepts explicit audio feature input; server microphone capture is not implemented and is not presented as a working web feature.

## Run locally

Install dependencies and start the local simulator server:

```sh
npm install
npm run build
npm start
```

Then open `http://localhost:4173`. The first run prints a local setup token in the server console. Enter that token and a new PIN in the web app, sign in, then take operator control. The web app requires the running controller; opening HTML directly does not operate lights.

By default the server listens only on loopback. To connect an iPhone on the same trusted LAN, start it with `HOST=0.0.0.0 npm start` and use the host computer's LAN address with port 4173. Bonjour discovery is advertised when listening on the LAN. The app must never use the iPhone's localhost address to reach a separate controller.

Run `npm test` for deterministic engine, wizard, authentication, persistence and real UDP driver tests; `npm run typecheck` checks the shared contract; `npm run test:web` runs browser workflows. Test fixture addresses and scene values come from the controller configuration.

For the audit repair details and verification boundaries, see [audit remediation](docs/AUDIT_REMEDIATION.md).

## Product boundary

The web and iOS clients send intent and render authoritative controller snapshots. The server sends one 512-slot frame every tick through the selected simulator or sACN driver. Simulator status means that an in-memory frame was generated. sACN status reports UDP submission; it cannot prove that a physical node or fixture received the packet.

Only universe 1 is supported. Profiles, patch, scenes, cues and setup drafts are stored with atomic writes and a last-good backup in `data/` (override with `FLASHIFY_DATA_DIR`). Setup PINs are hashed; sessions and operator leases protect control. Keep the controller on a trusted local network; HTTP does not encrypt credentials.

The simulator does not replace physical acceptance. See [hardware acceptance](docs/HARDWARE_ACCEPTANCE.md) for the uncompleted real-fixture, physical-iPhone and eight-hour soak checks. No physical installation has been verified by the automated suite.

The iOS app is now a complete Xcode project at `apps/ios/Flashify.xcodeproj`. Open it in Xcode and run the `Flashify` scheme on an iOS 17+ simulator or device. The local-network and Bonjour permissions are already included in `apps/ios/Flashify/Info.plist`. Build verification:

```sh
cd apps/ios
xcodebuild -project Flashify.xcodeproj -scheme Flashify -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```
