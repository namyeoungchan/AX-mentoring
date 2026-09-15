import { spawnSync } from 'node:child_process'

// Isolated demo output for testing the repository subpath used by Pages.
const env = { ...process.env, PAGES_BASE_PATH: '/asanAX-mentoring/', VITE_APP_MODE: 'demo', VITE_API_BASE_URL: '' }
for (const args of [['node_modules/typescript/bin/tsc', '-b'], ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-pages']]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
