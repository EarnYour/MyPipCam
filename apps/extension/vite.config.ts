import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // MV3 service workers have no `document`. Emptying modulepreload deps
    // avoids the worst crash path; scripts/strip-sw-vite-preload.mjs then
    // removes Vite's document-based preload helper from the SW boot chunk.
    modulePreload: false,
    rollupOptions: {
      input: {
        recorder: 'src/recorder/index.html',
        library: 'src/library/index.html',
        editor: 'src/editor/index.html',
        offscreen: 'src/offscreen/index.html',
        pip: 'src/pip/index.html',
      },
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
