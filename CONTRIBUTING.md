# Contributing to MyPipCam

Thanks for helping improve MyPipCam. This project is created by
[EarnYour Marketing](https://earnyour.com) and published freely on GitHub under
the [MIT License](LICENSE).

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## What to know before you start

- Monorepo layout: `apps/extension` (Chrome), `apps/macos` (SwiftUI), `apps/web` (site + share API)
- **First-time setup / agent bootstrap:** [AGENTS.md](AGENTS.md)
- Prefer small, focused pull requests with a clear problem statement
- Do not commit secrets (API keys, OAuth client secrets, signing credentials)
- Keep the local-first privacy model: no new telemetry/analytics without an
  explicit docs update in [PRIVACY.md](PRIVACY.md)

## Build: Chrome extension

```bash
cd apps/extension
npm install
npm run build
```

Load unpacked from `apps/extension/dist` on `chrome://extensions` (Developer mode).

For day-to-day work:

```bash
cd apps/extension
npm run dev
```

Reload the extension after meaningful changes. See the root [README](README.md)
for Drive OAuth setup and the shared library folder.

## Build: macOS app

**Install script (Release `.app` → Applications):**

```bash
./scripts/install-macos-app.sh
```

**Xcode debug:**

1. Open `apps/macos/MyPipCam.xcodeproj`
2. Select your Development Team under Signing & Capabilities
3. Run (⌘R) and grant Camera / Microphone when prompted

Requires macOS 14+ and Xcode 16+.

## Pull request expectations

1. **Describe why** — bug, feature, or docs fix in a few sentences
2. **Test what you touched** — extension build/reload and/or macOS run path
3. **Keep scope tight** — unrelated refactors make review harder
4. **Update docs** when behavior users rely on changes (README, TERMS, PRIVACY, SECURITY)
5. **Security** — report vulnerabilities privately via [SECURITY.md](SECURITY.md);
   do not open a public issue with exploit details

## License of contributions

Unless you state otherwise before merge, contributions are accepted under the
same MIT License as the rest of the project (copyright holder remains
EarnYour Marketing and contributors).
