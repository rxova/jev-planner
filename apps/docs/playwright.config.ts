import { defineConfig, devices } from '@playwright/test'

// Runs against the built dist, mounted at DOCS_BASE_URL like GitHub Pages
// mounts it. Build first: `pnpm build && pnpm test:e2e`. docs.yml does the same.
const PORT = 4330
const base = (process.env.DOCS_BASE_URL ?? '/').replace(/\/?$/, '/')

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}${base}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node ./e2e/serve.mjs ${String(PORT)}`,
    url: `http://localhost:${String(PORT)}${base}`,
    reuseExistingServer: !process.env.CI,
  },
})
