import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { DatabaseSync } from 'node:sqlite'
import { createAuth } from '../server/auth.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(root, '.env'), quiet: true })
let db, rl
try {
  const username = process.argv[2]
  if (!username || process.argv.length !== 3 || !process.stdin.isTTY) throw new Error('서버 터미널에서 npm run account:reset -- 아이디 를 실행하세요. 비밀번호는 명령 인자로 받지 않습니다.')
  let muted = false
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done() } })
  rl = createInterface({ input: process.stdin, output, terminal: true })
  const question = async label => {
    process.stdout.write(label); muted = true
    try { return await rl.question('') } finally { muted = false; process.stdout.write('\n') }
  }
  const newPassword = await question('새 비밀번호 (8자 이상): ')
  const confirm = await question('새 비밀번호 확인: ')
  if (newPassword !== confirm) throw new Error('비밀번호가 일치하지 않습니다.')
  db = new DatabaseSync(resolve(root, process.env.BOT_DB_PATH || '../data/mentoring.db'), { open: true })
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  await createAuth(db).resetPassword({ username, newPassword })
  console.log('비밀번호를 변경하고 해당 계정의 모든 로그인을 해제했습니다.')
} catch (error) {
  console.error(error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' / ') : error.message)
  process.exitCode = 1
} finally { rl?.close(); db?.close() }
