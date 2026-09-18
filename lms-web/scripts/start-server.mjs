import { config } from 'dotenv'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { postgresConnection, closePostgresConnections } from '../server/postgres/database.mjs'
import { schemas, exportPostgres } from '../server/postgres/backup.mjs'
import { decodeBackup } from '../server/data-maintenance.mjs'

config({quiet:true})
const source=resolve(process.env.BOT_DB_PATH || '../data/mentoring.db')
try {
  const connection=postgresConnection()
  if(connection) {
    const existing=await schemas(connection)
    const directory=join(dirname(source),'predeploy-backups')
    if(!existing.length && existsSync(source)) {
      if(process.env.MIGRATE_SQLITE_TO_POSTGRES!=='1') throw new Error('Existing SQLite data detected. Set MIGRATE_SQLITE_TO_POSTGRES=1 for the verified one-time migration')
      mkdirSync(directory,{recursive:true,mode:0o700})
      const output=join(directory,`sqlite-before-postgres-${Date.now()}.axbackup`)
      const result=spawnSync(process.execPath,['scripts/migrate-postgres.mjs','--sqlite',source,'--output',output,'--apply'],{stdio:'inherit',windowsHide:true})
      if(result.error || result.status!==0) throw new Error('SQLite migration failed; source files were preserved')
    } else if(existing.length) {
      // Keep a verified logical copy before this deployment opens application tables.
      mkdirSync(directory,{recursive:true,mode:0o700})
      const backup=join(directory,`postgres-before-start-${Date.now()}.axbackup`)
      const bytes=await exportPostgres(connection)
      decodeBackup(bytes)
      writeFileSync(backup,bytes,{flag:'wx',mode:0o600})
      decodeBackup(readFileSync(backup))
      console.log(JSON.stringify({prestartBackup:'verified',database:'postgresql'}))
    }
  }
} catch(error) {
  console.error('Database startup failed:',error.code || error.message)
  process.exitCode=1
} finally {await closePostgresConnections()}
if(!process.exitCode) await import('../server/index.mjs')
