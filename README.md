# Flashify

Flashify is a local lighting-control interface for the ESE 1110 Detkin Lab installation.

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

The iOS client source is in `apps/ios/FlashifyApp.swift`; add it to an iOS 17 SwiftUI target and set the local-network Bonjour keys described in `apps/ios/README.md`.
