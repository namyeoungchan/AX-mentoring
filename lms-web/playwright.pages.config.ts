import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './pages-tests', workers: 1,
  outputDir: 'test-results-pages',
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --outDir dist-pages --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175/asanAX-mentoring/',
    env: { PAGES_BASE_PATH: '/asanAX-mentoring/' },
  },
})
