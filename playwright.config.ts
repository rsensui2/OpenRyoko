import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:7779',
    headless: true,
  },
  // Don't auto-start a web server — tests assume gateway is running separately
  // We'll add webServer config only if needed
})
