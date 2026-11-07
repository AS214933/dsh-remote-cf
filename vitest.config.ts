import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // Node lifecycle tests construct Gateway with clone-on-read socket attachments.
      // Only the runtime base class is stubbed here; the integration script separately
      // runs real workerd with explicit WebSocket-preserving hibernation.
      'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    // The protocol and crypto tests are pure; nothing needs a DOM.
    environment: 'node',
  },
})
