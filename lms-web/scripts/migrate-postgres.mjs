import { config } from 'dotenv'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createRuntime } from '../server/runtime.mjs'
import { createDataMaintenance, decodeBackup } from '../server/data-maintenance.mjs'
import { postgresConnection, databaseContext, closePostgresConnections } from '../server/postgres/database.mjs'
import { migrateBackup } from '../server/postgres/migrate.mjs'

config({quiet:true})
const {values}=parseArgs({options:{backup:{type:'string'},sqlite:{type:'string'},output:{type:'string'},apply:{type:'boolean',default:false}}})
try {
  const connection=postgresConnection()
  if(!connection) throw new Error('Set DATABASE_URL to the destination PostgreSQL database')
  if(Boolean(values.backup)===Boolean(values.sqlite)) throw new Error('Specify exactly one of --backup FILE or --sqlite FILE')
  let bytes
  if(values.backup) bytes=readFileSync(resolve(values.backup))
  else {
    const dbPath=resolve(values.sqlite)
    if(!existsSync(dbPath)) throw new Error('SQLite source does not exist')
    if(!values.output) throw new Error('--sqlite requires --output FILE to retain a verified backup')
    const env={...process.env,DATABASE_URL:'',NODE_ENV:'development'}
    const runtime=await databaseContext(()=>createRuntime(dbPath,env))
    try {bytes=await createDataMaintenance({dbPath,env,getRuntime:()=>runtime}).backup()}
    finally {await runtime.close()}
    decodeBackup(bytes)
    writeFileSync(resolve(values.output),bytes,{flag:'wx',mode:0o600})
  }
  const result=await migrateBackup(connection,bytes,{apply:values.apply})
  console.log(JSON.stringify({migration:result.applied?'applied':'verified-dry-run',...result}))
} catch(error) {
  // Driver errors can contain connection details; print a safe, actionable summary only.
  console.error('PostgreSQL migration failed:',error.code || (error.name==='AssertionError'?'row-verification-failed':error.message))
  process.exitCode=1
} finally {await closePostgresConnections()}
