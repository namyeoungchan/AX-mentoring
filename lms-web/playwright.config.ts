import { defineConfig } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1,
  expect: { timeout: process.env.PLAYWRIGHT_DATABASE_URL ? 15000 : 5000 },
  use: { channel: process.env.PLAYWRIGHT_CHANNEL || undefined, baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node server/index.mjs', url: 'http://localhost:3006/api/health', env: { API_PORT: '3006', BOT_DB_PATH: join(tmpdir(), `learningops-data-admin-${randomUUID()}.db`), NODE_ENV: 'production', ADMIN_PASSWORD: 'data-setup-key-123456', ALLOWED_ORIGINS: 'http://localhost:3006' } },
    { command: 'node server/index.mjs', url: 'http://localhost:3005/api/health', env: { API_PORT: '3005', BOT_DB_PATH: join(tmpdir(), `learningops-student-accounts-${randomUUID()}.db`), NODE_ENV: 'production', ADMIN_PASSWORD: 'student-setup-key-123456', ALLOWED_ORIGINS: 'http://localhost:3005' } },
    { command: 'node server/index.mjs', url: 'http://localhost:3004/api/health', env: { API_PORT: '3004', BOT_DB_PATH: join(tmpdir(), `learningops-accounts-${randomUUID()}.db`), NODE_ENV: 'production', ADMIN_PASSWORD: 'account-setup-key-123456', ALLOWED_ORIGINS: 'http://localhost:3004' } },
    { command: 'node server/index.mjs', url: 'http://localhost:3003/api/health', env: { API_PORT: '3003', BOT_DB_PATH: join(tmpdir(), `learningops-production-${randomUUID()}.db`), NODE_ENV: 'production', ALLOW_LEGACY_ADMIN: 'true', ADMIN_PASSWORD: 'production-setup-key-123456', ALLOWED_ORIGINS: 'http://localhost:3003', RENDER_EXTERNAL_URL: 'https://actual-service.onrender.com' } },
    { command: 'node server/index.mjs', url: 'http://127.0.0.1:3002/api/health', env: { API_PORT: '3002', BOT_DB_PATH: join(tmpdir(), `learningops-e2e-${randomUUID()}.db`), NODE_ENV: 'test', ALLOW_LEGACY_STUDENT_REGISTRATION: 'true', ALLOW_LEGACY_ADMIN: 'true', ADMIN_PASSWORD: 'test-only-password-1234', ALLOWED_ORIGINS: 'http://127.0.0.1:5174,http://127.0.0.1:5176', LEARNINGOPS_SYNC_TOKEN: 'test-only-sync-token-12345678901234567890', LEARNINGOPS_SOURCE_ID: 'asan-ax', LEARNINGOPS_AUTH_TOKEN: 'test-only-auth-token-12345678901234567890', LEARNINGOPS_AUTH_GUILD_ID: '123456789012345678', LEARNINGOPS_PROVISION_TOKEN: 'test-only-provision-token-12345678901234567890' } },
    { command: 'npx vite --port 5174', url: 'http://127.0.0.1:5174', env: { VITE_API_TARGET: 'http://127.0.0.1:3002' } },
    { command: 'npx vite --port 5176', url: 'http://127.0.0.1:5176', env: { VITE_API_BASE_URL: 'http://127.0.0.1:3002', VITE_APP_MODE: 'api' } },
  ].map(server=>server.command==='node server/index.mjs' ? {...server,env:{...server.env,DATABASE_URL:process.env.PLAYWRIGHT_DATABASE_URL||'',PG_NAMESPACE:'e'+randomUUID().replaceAll('-','').slice(0,12),PG_POOL_MAX:'6'}} : server),
})
