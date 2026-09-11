import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws outside the React Server bundle; unit tests import
      // server modules directly, so swap in an empty module.
      'server-only': fileURLToPath(new URL('./tests/unit/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // Node by default; component tests opt into jsdom with a file comment.
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
  },
});
