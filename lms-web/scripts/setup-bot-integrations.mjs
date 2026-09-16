import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { parse } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = resolve(root, '.env')
const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
const settings = parse(existing)
for (const key of ['ADMIN_PASSWORD', 'LEARNINGOPS_AUTH_TOKEN', 'LEARNINGOPS_PROVISION_TOKEN']) {
  if (!settings[key]) {
    appendFileSync(file, `\n${key}=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    console.log(`${key}: lms-web/.env에 생성했습니다. 값은 출력하지 않습니다.`)
  } else {
    if (settings[key].length < (key === 'ADMIN_PASSWORD' ? 16 : 32)) throw new Error(`${key} 길이를 확인하세요.`)
    console.log(`${key}: 기존 값을 유지합니다.`)
  }
}
console.log('웹에서 워크스페이스와 Discord 서버를 1:1로 연결하세요. 고정 GUILD_ID는 필요하지 않습니다.')
console.log('API를 재시작하고, 봇의 Render 환경변수에 각 전용 키와 HTTPS API 주소를 설정하세요. Discord에 접속하거나 채널을 생성하지 않았습니다.')
