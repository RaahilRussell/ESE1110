# Flashify iOS client

`FlashifyApp.swift` is the iOS 17 SwiftUI client for the same local server and protocol used by the web dashboard. Add the file to a new iOS App target in Xcode, set the deployment target to iOS 17, and add these Info.plist keys:

- `NSLocalNetworkUsageDescription`: Flashify finds the local lighting controller.
- `NSBonjourServices`: `_flashify._tcp`.

The client is intentionally thin: it renders snapshots, sends intent commands, keeps blackout available, and resynchronizes from the server after reconnecting.
