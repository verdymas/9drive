import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    // React resolves its production build when NODE_ENV is inherited as
    // `production` from the caller's shell, which strips `act` and breaks every
    // DOM test. Pin the test value instead of relying on Vitest's default.
    env: { NODE_ENV: 'test' },
  },
})
