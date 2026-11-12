# Flashify iOS client

`Flashify.xcodeproj` is the iOS 17 SwiftUI client for the same local server and protocol used by the web dashboard. Open the project in Xcode and run the `Flashify` scheme. The deployment target, bundle identifier, and local-network permissions are already configured.

- `NSLocalNetworkUsageDescription`: Flashify finds the local lighting controller.
- `NSBonjourServices`: `_flashify._tcp`.

The client is intentionally thin: it renders snapshots, sends intent commands, keeps blackout available, and resynchronizes from the server after reconnecting.
