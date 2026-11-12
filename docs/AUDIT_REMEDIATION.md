# Repository audit remediation

The original audit correctly identified that the initial UI was a mockup and the server was not sending output. Earlier README and conversation claims of feature completeness were too broad.

Local repair validation: 50 Node tests passed, including 10 server integration tests and a 24-hour fake-clock rehearsal; 18 browser tests passed across Chromium, desktop WebKit and mobile WebKit; 10 native XCTest cases passed. A live Swift client exercised login, snapshots, operator ownership, fixture commands, cue playback and blackout against the real server. Type checks, production build, iOS simulator/device compilation and the production dependency audit passed. CI runs are configured but are not claimed as completed remote runs.

The repair focuses on executable behavior:

| Finding | Verification boundary |
| --- | --- |
| Invalid E1.31 packets | Independent packet decoder and actual localhost UDP receiver check root/framing/DMP headers, sequence, start code, 512 slots and shutdown packets |
| No output from host | Server timer calls the selected output driver on every tick; diagnostics reads driver status |
| Unauthenticated commands | Local setup token, hashed PIN, bounded sessions, authenticated WS hello, exclusive expiring control lease; authenticated observers retain blackout |
| Unsafe static serving | Exact asset allowlist; source, dependencies, dotfiles and data are never served |
| Fake success and duplicate UI state | Clients render controller configuration and snapshots; commands remain pending until acknowledgement |
| Broken scene/cue behavior | Real scene CRUD, normalized fades, cue scene transitions, boundary errors, interruption and STOP freeze tests |
| Unsafe engine mapping | Single-universe enforcement, profile validation, emitter master/blackout, safe range clamp, scene scope and virtual dimmer regression tests |
| Bad retry handling | Bounded exact command outcome cache, scoped by authenticated session at the server |
| Lost configuration | Atomic validated files, backup recovery, corruption quarantine and safe-dark recovery |
| Fragile wizard | Versioned persisted drafts, server validation, bounded target-only tests, human observations, stale evidence rejection and atomic commit |
| Phone localhost and fake connection | Manual host entry, Bonjour discovery, local network permissions, authenticated handshake, reconnect and native tests |
| Narrow testing | Engine regressions, randomized wizard/virtual-room oracles, UDP tests, HTTP/WS integration, browser workflows, native XCTest and CI |

The fixture simulator decodes actual channel bytes using a virtual light's independently configured address, mode, color order, power and cable state. It does not infer physical success from an acknowledgement.

Music consumes explicit audio feature input. No physical server microphone or audio hardware pipeline has been verified. The automated accelerated rehearsal advances a fake clock through 24 hours; it is not an eight-hour real-time hardware soak.

Physical fixture response, electrical framing at a DMX connector, node data-loss behavior, physical iPhone discovery on the deployment WLAN, eight-hour soak and beginner usability sessions require equipment and observation. Their acceptance record is [HARDWARE_ACCEPTANCE.md](HARDWARE_ACCEPTANCE.md). No automated result should be used to mark those checks passed.
