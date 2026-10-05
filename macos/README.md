# Relay macOS App

`RelayApp` is an AppKit/WKWebView shell targeting macOS 13 and Apple Silicon `arm64`. The development package embeds official Node 24.21.0, whose actual deployment target is macOS 13.5; the generated app plist therefore requires 13.5+. macOS 13.0–13.4 compatibility remains unverified and requires a compatible runtime rather than a plist-only change.

SwiftPM downloads Sparkle 2.10.0 using its pinned artifact checksum. Current Command Line Tools can compile the development app without full Xcode. Production distribution still needs Developer ID, notarization, EdDSA credentials and a real HTTPS appcast. `RELAY_RELEASE=1` rejects the development packager; ad-hoc signing is never treated as release signing.

```bash
npm run macos:check
npm run macos:build
npm run macos:package
npm run macos:smoke
npm run macos:test
```

The packager caches a checksum-verified official Node archive under `.local/macos-runtime`, embeds Sparkle in `Contents/Frameworks` with relative runtime lookup and preserved symlinks, installs production dependencies from the lockfile, and copies only an explicit server-resource list including Agent Hook and PTY setup. It checks native architectures, minimum system versions, external dynamic libraries, private resource filenames and escaping links. Source data, `.env`, CLI credentials and SQLite logs are not copied. A supplied `RELAY_NODE_RUNTIME` must pass the same runtime checks.

Outputs: `dist-macos/Relay.app`, `dist-macos/Relay-arm64.dmg`. The DMG includes an Applications link; SHA-256 is printed. A staging build is checked before replacing the previous app.

Current development version: **0.1.3, build 4**. The original three-node icon lives in `Relay.svg`, `Relay.png` and `Relay.icns` under `RelayApp/Resources`; `npm run macos:icon` regenerates ten icon representations using the existing Playwright/Chrome development tools and system `iconutil`. The browser is not shipped in the app.

The web view sits below a standard draggable title bar. Control-Command-F toggles fullscreen; closing the last window terminates the app through its graceful service-stop path. Project selection uses a main-frame/origin-checked reply bridge and a window-modal NSOpenPanel. Bundle localizations and mixed framework localization make system panel controls follow the user's preferred language.

Desktop Claude catalog and launches share a bounded asynchronous login-shell environment resolver. It captures only approved Claude model/config/endpoint/authentication variables in memory. LaunchServices often retains stale variables: Finder launches use the current shell snapshot; direct launches preserve explicit environment overrides. `RELAY_CLAUDE_ENV_EXPLICIT=1` explicitly selects the latter policy, and member settings take final precedence. Refreshing the catalog reloads the shell; failures fall back safely with a visible catalog note. Shell output and credentials are never logged or bundled.

The app launches the embedded Node directly through the tsx loader, preserving ready PID identity. It uses a random loopback port and private ready file, shuts down asynchronously, and keeps user data under `~/Library/Application Support/Relay`. `RELAY_APP_DATA_DIR` selects isolated test data. Only the owning Relay service and authenticated project-console origins may navigate inside WKWebView; file URLs and unrelated local ports are rejected.

`macos:smoke` runs the packaged service from an unrelated working directory with a system-only PATH. It checks ready identity/permissions, HTTP authentication, frontend assets, an actual Chinese PTY/resize/exit, the packaged Hook against a fixture endpoint, and ready/lock/port cleanup. It does not launch model inference or prove clean-machine installation, macOS 13.5 compatibility, production updates or data import. Private evidence stays under `.local/macos-smoke-*`.

Preview distribution uses `macos:preview-assets`, then `macos:preview-draft` and `macos:preview-publish` from a clean, committed release checkout. These commands do not enable production updates. LICENSE and THIRD_PARTY_NOTICES.md ship inside App Resources.
