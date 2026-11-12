# Flashify

Flashify is a local lighting-control interface for the ESE 1110 Detkin Lab installation.

This repository contains the first browser client for the P0 product specification. It is intentionally dependency-free so it can be served from a controller asset partition or opened directly during bench testing.

## Run locally

Open `index.html` in a current browser, or serve this folder with any static file server. The UI includes a deterministic simulator state for scenes, groups, show cues, blackout, patch validation, and controller diagnostics.

## Product boundary

The web client owns presentation and operator intent only. In the production installation, the simulator actions map to the shared v1 REST/WebSocket protocol and the ESP32-S3 controller owns timing, state, validation, persistence, and DMX output.
