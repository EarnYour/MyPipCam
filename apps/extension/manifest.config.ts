import { defineManifest } from '@crxjs/vite-plugin'
import { DRIVE_SCOPE, GOOGLE_OAUTH_CLIENT_ID } from './src/shared/driveConfig'

export default defineManifest({
  manifest_version: 3,
  name: 'MyPipCam',
  description:
    'Record this Chrome tab with a live draggable camera PiP (Loom-style). Local library and editor.',
  version: '1.1.13',
  // PUBLIC key only → stable unpacked extension ID across reloads.
  // Unpacked ID: akpchobfndfddajiihkkdpnihihdicjc
  // Chrome Web Store ID (zip without this field): meiehjfjcaahfjcdneoegjkmajbfghmm
  // Matching PRIVATE key must never be committed (apps/extension/keys/*.pem).
  // Forks/distributors: generate your own keypair (`openssl genrsa` / Chrome pack)
  // and replace this field, or omit `key` and accept a new extension ID.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvt5e+6w3dk+PBuZiSG2Wr/TvaPOlrIVMlYRmYUzsJSupxWtXf2J+wEpXNxS8Tp7dGovM2jFsKNcroQGKIrJpZFPhczdPoZFXXqv1tMxMjhXh8hVqwDu7lZFsohOk2Cl+9YR4SOz3khMzOr0XX6hN2Pz7oTXWeRhjl6plncvn2MprWEsGutxOdig/C+j0F3uu7bsYhGghHgjV7QDzNugTlVLhQbHw0Bq0fSxTxy1HxoYVDytgu7MXze5cTp+heQu9ClVoH+G+CLldcmuMCGM0DJb2EN707eAI2EPVLpqs1Fh7YSxOBra2Hxw8krcy09gfj48GXqd1Ps1ZmzSjReGgYQIDAQAB',
  // Lets https://mypipcam.earnyour.com/open-library ask this extension to open
  // Library via chrome.tabs (avoids ERR_BLOCKED_BY_CLIENT from ad blockers on
  // direct chrome-extension:// navigation from the macOS app).
  externally_connectable: {
    matches: ['https://mypipcam.earnyour.com/*'],
  },
  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'MyPipCam',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: [
    'storage',
    'unlimitedStorage',
    'tabs',
    'scripting',
    'activeTab',
    'tabCapture',
    'offscreen',
    'identity',
    'alarms',
    'notifications',
  ],
  oauth2: {
    // From VITE_GOOGLE_OAUTH_CLIENT_ID (.env.local) via driveConfig.ts.
    // Local: Client B Item ID akpchobfndfddajiihkkdpnihihdicjc.
    // Store zip: Client A Item ID meiehjfjcaahfjcdneoegjkmajbfghmm.
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    scopes: [DRIVE_SCOPE],
  },
  // Required to inject the recording overlay into the captured http(s) tab.
  // activeTab alone is not reliable across countdown/restart. See SECURITY.md.
  host_permissions: ['http://*/*', 'https://*/*'],
  web_accessible_resources: [
    {
      // Extension-origin camera PiP iframe + its bundled scripts (not page getUserMedia).
      // MediaPipe WASM/model are loaded from the iframe via chrome.runtime.getURL.
      // Camera start is gated by a registered channel token (see pip + background).
      resources: [
        'src/pip/index.html',
        // Stable classic overlay (executeScript injects this; listed for clarity).
        'src/content/pipOverlay.js',
        // PiP iframe entry only — do NOT use assets/pip*.js (that also matches
        // orphan CRX ESM chunks named assets/pipOverlay.ts-*.js).
        'assets/pip-*.js',
        'assets/security*.js',
        'assets/backgroundBlur*.js',
        'assets/modulepreload-polyfill*.js',
        'mediapipe/**/*',
      ],
      matches: ['http://*/*', 'https://*/*'],
    },
  ],
  commands: {
    'start-recording': {
      suggested_key: {
        default: 'Ctrl+Shift+U',
        mac: 'Command+Shift+U',
      },
      description: 'Start or stop MyPipCam tab recording',
    },
  },
  content_security_policy: {
    // MV3 extension_pages cannot use blob: (Chrome rejects it as insecure).
    // wasm-unsafe-eval is required for ffmpeg.wasm; load core/wasm via chrome.runtime.getURL (not toBlobURL).
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
})
