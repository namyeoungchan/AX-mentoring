import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { DatabaseSync } from 'node:sqlite'
import { createAuth } from '../server/auth.mjs'
import { openPostgres, postgresConnection, databaseContext, closePostgresConnections } from '../server/postgres/database.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(root, '.env'), quiet: true })
let db, rl
try {
  const username = process.argv[2]
  if (!username || process.argv.length !== 3 || !process.stdin.isTTY)
    throw new Error('실제 DB를 사용하는 서버 터미널에서 npm run account:super -- 아이디 를 실행하세요. 비밀번호는 명령 인자로 받지 않습니다.')
  const dbPath = resolve(root, process.env.BOT_DB_PATH || '../data/mentoring.db')
  if (!process.env.DATABASE_URL && !existsSync(dbPath))
    throw new Error('기존 DB를 찾을 수 없습니다. DATABASE_URL 또는 BOT_DB_PATH를 확인하세요.')
  let muted = false
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done() } })
  rl = createInterface({ input: process.stdin, output, terminal: true })
  const question = async label => {
    process.stdout.write(label); muted = true
    try { return await rl.question('') } finally { muted = false; process.stdout.write('\n') }
  }
  const password = await question('슈퍼계정 비밀번호 (8자 이상): ')
  const confirm = await question('비밀번호 확인: ')
  if (password !== confirm) throw new Error('비밀번호가 일치하지 않습니다.')
  const postgres = postgresConnection()
  db = postgres ? await openPostgres(postgres) : new DatabaseSync(dbPath)
  await db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  await databaseContext(async () => {
    const auth = await createAuth(db)
    const user = await auth.createSuperAdmin({ username, name: '슈퍼관리자', password })
    console.log(`슈퍼계정 ${user.username} 생성 완료. 비밀번호는 DB에 scrypt 해시로만 저장했습니다.`)
  })
} catch (error) {
  console.error(error.name === 'ZodError' ? error.issues.map(issue => issue.message).join(' / ') : error.message)
  process.exitCode = 1
} finally { rl?.close(); db?.close(); await closePostgresConnections() }
