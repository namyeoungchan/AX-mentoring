import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { parse } from 'dotenv'
const file = resolve(dirname(fileURLToPath(import.meta.url)), '../.env')
const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
const settings = parse(existing)
if (!settings.LEARNINGOPS_SYNC_TOKEN) {
  appendFileSync(file, `\n# Render worker sync authentication (do not commit)\nLEARNINGOPS_SYNC_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  console.log('동기화 키를 lms-web/.env에 저장했습니다. 키 값은 출력하지 않습니다.')
} else if (settings.LEARNINGOPS_SYNC_TOKEN.length < 32) {
  throw new Error('기존 LEARNINGOPS_SYNC_TOKEN이 32자보다 짧습니다. .env에서 수정하세요.')
} else console.log('기존 동기화 키를 유지합니다.')
if (!settings.LEARNINGOPS_SOURCE_ID) appendFileSync(file, 'LEARNINGOPS_SOURCE_ID=asan-ax\n')
console.log('같은 키를 Render Worker와 웹 API의 LEARNINGOPS_SYNC_TOKEN에 설정하세요.')
