import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // MV3 SW: no document. Keep modulePreload off so Vite does not inject
    // document-based preload helpers around any remaining dynamic imports in
    // page bundles that share the Rollup graph.
    modulePreload: false,
    rollupOptions: {
      input: {
        recorder: 'src/recorder/index.html',
        library: 'src/library/index.html',
        editor: 'src/editor/index.html',
        offscreen: 'src/offscreen/index.html',
        pip: 'src/pip/index.html',
        hud: 'src/hud/index.html',
      },
      // Background entry must not emit import() — source uses static imports
      // only (see src/background/index.ts). Shared ESM chunks are OK for
      // type:"module" service workers; post-build verify-sw catches regressions.
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})
