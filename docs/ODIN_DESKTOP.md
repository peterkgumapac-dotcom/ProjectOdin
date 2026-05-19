# ODIN Desktop Companion

ODIN Desktop is the local Mac shell for the existing ODIN web dashboard. It keeps the React app as the main surface, but moves the voice entry point into Electron so macOS microphone permission and Chromium audio behave more predictably than the in-app browser.

## Run Locally

```bash
npm run desktop:dev
```

The launcher will reuse `http://127.0.0.1:5173` if Vite is already running. If it is not running, the launcher starts Vite first, then opens the ODIN desktop window at `/dashboard`.

## Package a Development App

```bash
npm run desktop:pack
open "$HOME/Applications/ODIN-dev/ODIN.app"
```

`desktop:pack` builds the React app, creates the bundled Electron app, copies it outside the synced Documents workspace, and ad-hoc signs it for local smoke testing. It uses the packaged `dist` files directly, so it does not need Vite to be running.

By default the dev app lands at `$HOME/Applications/ODIN-dev/ODIN.app`. Override that with `ODIN_DESKTOP_APP_DIR=/path/to/folder npm run desktop:pack`.

## Signed Distribution

```bash
npm run desktop:dist
```

`desktop:dist` uses Electron Builder's macOS signing flow when a Developer ID Application certificate is available in Keychain. The app has hardened runtime enabled, microphone usage copy in `Info.plist`, and macOS entitlements in `electron/entitlements.mac.plist`.

If the certificate is not installed, `desktop:dist` fails early instead of producing a fake trusted build. You can pin a specific certificate with `CSC_NAME="Developer ID Application: Your Name (TEAMID)" npm run desktop:dist`.

## Voice Behavior

- Electron asks macOS for microphone permission through the ODIN menu and the voice startup path.
- Local media permission is allowed only for ODIN local URLs.
- The React app can detect desktop mode through `window.odinDesktop`.
- Packaged OAuth and magic-link redirects use the `odin://open/...` app route.
- The Eye still starts voice; the dashboard remains the same source of truth.

## Troubleshooting

If ODIN still cannot hear you:

1. Open macOS `System Settings`.
2. Go to `Privacy & Security` → `Microphone`.
3. Allow `ODIN` or `Electron`.
4. Restart `npm run desktop:dev`.

This is still the v1 desktop companion. Background wake word detection, auto-launch, updater plumbing, and notarized distribution should come after the packaged app smoke path is stable.
