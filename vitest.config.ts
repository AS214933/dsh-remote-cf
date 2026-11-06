import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // The Workers runtime provides `cloudflare:workers`; vitest runs in Node and
      // cannot resolve it. Tests never construct the Durable Object, so a stub
      // whose base class does nothing is enough for the module to load.
      'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    // The protocol and crypto tests are pure; nothing needs a DOM.
    environment: 'node',
  },
})
