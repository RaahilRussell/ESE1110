# Flashify

Flashify is a hardware-agnostic local DMX lighting-control platform for iPhone and web. It is designed to make professional lighting control approachable without exposing DMX complexity to beginners.

This repository contains the simulator-first P0/P1 foundation for the v2 product specification. The browser client includes Home, Design, Show, Music/Pulse, Diagnostics, and a draft-first Setup wizard. The TypeScript engine owns normalized lighting state, fades, blackout priority, command idempotency, 512-byte frame synthesis, and wizard validation.

## Run locally

Install dependencies and start the local simulator server:

```sh
npm install
npm start
```

Then open `http://localhost:4173`. Opening `index.html` directly still works as a static UI fallback. Run `npm test` for engine and wizard tests, and `npm run typecheck` for the strict contract check.

## Product boundary

The web and iOS clients own presentation and operator intent only. The local server exposes the shared v1 REST/WebSocket contract and the simulator driver owns the 512-byte output frame. The ESP32 reference informed the future node boundary—UART2, 250k 8N2, break/MAB timing, and full-universe frames—without coupling the engine to a board.

The iOS app is now a complete Xcode project at `apps/ios/Flashify.xcodeproj`. Open it in Xcode and run the `Flashify` scheme on an iOS 17+ simulator or device. The local-network and Bonjour permissions are already included in `apps/ios/Flashify/Info.plist`. Build verification:

```sh
cd apps/ios
xcodebuild -project Flashify.xcodeproj -scheme Flashify -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```
