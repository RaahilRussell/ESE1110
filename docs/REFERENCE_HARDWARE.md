# Hardware reference notes

The linked `frkatona/ESP32_DMX` project was used as a hardware reference, not as an application architecture dependency.

Useful details carried forward for a future `esp32-node` output driver:

- UART2 is used for the DMX transmitter, with a configurable TX pin and a DE/RE direction-enable pin.
- DMX framing is 250000 baud, 8 data bits, no parity, 2 stop bits (8N2).
- A DMX frame begins with a break and mark-after-break, followed by start code `0x00` and up to 512 channel slots.
- The reference sends a complete universe and exposes a simple local control surface; Flashify improves this boundary by keeping named scenes, safety validation, persistence, and client protocol in the engine.
- The reference also demonstrates Art-Net-compatible UDP output and a captive-portal-style local setup path.

Flashify v2 keeps the engine hardware-agnostic. The simulator and sACN driver are the P0 output boundary; an ESP32 sACN-to-DMX node can be added later without changing the web app, iOS app, or engine.
