# ODIN Notch

Native SwiftUI/AppKit macOS notch companion app.

## Phase 1 Scope

- Native AppKit `NSPanel`
- Runtime notch geometry through `NSScreen`
- SwiftUI compact pulse orb
- SwiftUI expanded black tray
- Hover expand
- Mouse-out collapse
- Outside-click collapse
- Settings placeholder
- Mock local content only

## Explicit Non-Goals

- No Electron
- No WKWebView
- No backend
- No OAuth
- No Spotify API
- No Google API
- No Slack/Gmail/Withings integrations
- No copied GPL source from other notch apps

## Run in development

```bash
swift run
```

## Build app bundle

```bash
scripts/build-app.sh
open "build/ODIN Notch.app"
```
