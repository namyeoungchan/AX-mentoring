import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node server/index.mjs', url: 'http://127.0.0.1:3002/api/health', env: { API_PORT: '3002', BOT_DB_PATH: join(tmpdir(), `learningops-e2e-${randomUUID()}.db`), NODE_ENV: 'development', ADMIN_PASSWORD: 'test-only-password-1234', ALLOWED_ORIGINS: 'http://127.0.0.1:5174,http://127.0.0.1:5176', LEARNINGOPS_SYNC_TOKEN: 'test-only-sync-token-12345678901234567890', LEARNINGOPS_SOURCE_ID: 'asan-ax' } },
    { command: 'npx vite --port 5174', url: 'http://127.0.0.1:5174', env: { VITE_API_TARGET: 'http://127.0.0.1:3002' } },
    { command: 'npx vite --port 5176', url: 'http://127.0.0.1:5176', env: { VITE_API_BASE_URL: 'http://127.0.0.1:3002', VITE_APP_MODE: 'api' } },
  ],
})
