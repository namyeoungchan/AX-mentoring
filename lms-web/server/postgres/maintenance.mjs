import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiError } from '../store.mjs'
import { createRuntime } from '../runtime.mjs'
import { decodeBackup, safeRestoreState, MAX_BACKUP_BYTES } from '../data-maintenance.mjs'
import { databaseContext, identifier, openPostgres } from './database.mjs'
import { schemas, exportPostgres, importPostgres, discard, swapNamespaces } from './backup.mjs'

export function createPostgresMaintenance({ dbPath, getRuntime, closeRuntime, openRuntime, env }) {
  const connection = getRuntime().store.db.connection
  const control = identifier(connection.namespace + '_control')
  const setup = connection.pool.query(`CREATE SCHEMA IF NOT EXISTS ${control}; CREATE TABLE IF NOT EXISTS ${control}.backups(id TEXT PRIMARY KEY,created_at BIGINT NOT NULL,data BYTEA NOT NULL)`)
  setup.catch(()=>{}) // Operations below await setup and surface any initialization error.
  let busy=false, broken=false, active=0, upload=null
  const track = handler => async (req,res,next) => { active++; try { await handler(req,res,next) } finally { active-- } }
  async function exclusive(action) {
    if (busy || broken) throw new ApiError(503,'데이터 관리 작업 중입니다. 잠시 후 다시 시도하세요.')
    busy=true
    try {
      const deadline=Date.now()+30000
      while(active) { if(Date.now()>deadline) throw new ApiError(409,'처리 중인 요청이 있습니다. 완료 후 다시 시도하세요.'); await delay(25) }
      return await action()
    } finally { if(!broken) busy=false }
  }
  async function backup() {
    for(const row of await getRuntime().store.db.prepare("SELECT id FROM lms_workspaces WHERE id<>'default'").all()) await getRuntime().workspaces.open(row.id)
    const bytes=await exportPostgres(connection)
    if(bytes.length>MAX_BACKUP_BYTES) throw new ApiError(413,'압축 백업은 최대 32MB까지 지원합니다.')
    decodeBackup(bytes)
    return bytes
  }
  async function backups() {
    await setup
    return (await connection.pool.query(`SELECT id,created_at,octet_length(data) AS bytes FROM ${control}.backups ORDER BY created_at DESC`)).rows.map(r=>({id:r.id,createdAt:new Date(r.created_at).toISOString(),bytes:r.bytes}))
  }
  async function download(id) {
    await setup
    const row=(await connection.pool.query(`SELECT data FROM ${control}.backups WHERE id=$1`,[id])).rows[0]
    if(!row) throw new ApiError(404,'백업 파일을 찾을 수 없습니다.')
    return row.data
  }
  async function prepare(data) {
    const namespace='tmp'+randomUUID().replaceAll('-','').slice(0,12)
    const staged={...connection,namespace}
    let runtime
    try {
      if(data) await importPostgres(staged,data)
      runtime=await databaseContext(()=>createRuntime(dbPath,{...env,NODE_ENV:'development',PG_NAMESPACE:namespace,LEARNINGOPS_AUTH_GUILD_ID:''}))
      if(!data) await runtime.store.db.prepare("INSERT OR IGNORE INTO lms_workspace_migrations VALUES('admin-data-reset-v1')").run()
      const ids=(await runtime.store.db.prepare("SELECT id FROM lms_workspaces WHERE id<>'default'").all()).map(row=>row.id)
      if(data && ids.some(id=>!data.databases.some(entry=>entry.id===id))) throw new Error('Missing workspace data')
      for(const id of ids) await runtime.workspaces.open(id)
      for(const schema of await schemas(staged)) {
        const id=schema===namespace+'_main'?'default':schema.slice((namespace+'_w_').length).replaceAll('_','-')
        await safeRestoreState(await openPostgres(staged,id))
      }
      const accounts=(await runtime.store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n
      if(!await runtime.store.db.prepare("SELECT 1 FROM lms_users WHERE platform_role='admin'").get() && (env.ADMIN_PASSWORD||'').length<16) throw new ApiError(409,'관리자 계정이 없는 백업입니다. 최초 관리자 설정 키를 먼저 준비하세요.')
      return { staged,summary:{createdAt:data?.createdAt,databases:(await schemas(staged)).length,accounts,workspaces:ids.length+1} }
    } catch(error) {
      await discard(staged)
      if(error instanceof ApiError) throw error
      const failure=new ApiError(422,'백업 데이터의 형식 또는 연결 관계를 확인하세요.')
      failure.cause=error
      throw failure
    } finally { runtime?.close() }
  }
  async function preview(bytes,actorId) {
    const result=await prepare(decodeBackup(bytes))
    await discard(result.staged)
    upload={id:randomUUID(),bytes,actorId,expiresAt:Date.now()+600000}
    return {token:upload.id,expiresAt:upload.expiresAt,...result.summary}
  }
  async function replace(kind,token,actorId) {
    if(kind==='reset' && (env.ADMIN_PASSWORD||'').length<16) throw new ApiError(409,'최초 관리자 설정 키를 먼저 준비하세요.')
    if(kind==='restore' && (!upload || upload.id!==token || upload.actorId!==actorId || upload.expiresAt<Date.now())) throw new ApiError(409,'복구 파일을 다시 선택하고 검증하세요.')
    const {staged}=await prepare(kind==='restore'?decodeBackup(upload.bytes):null)
    const archived={...connection,namespace:'old'+randomUUID().replaceAll('-','').slice(0,12)}
    let swapped=false
    try {
      await setup
      const bytes=await backup(),backupId=`${Date.now()}-${randomUUID()}.axbackup`
      await connection.pool.query(`INSERT INTO ${control}.backups VALUES($1,$2,$3)`,[backupId,Date.now(),bytes])
      decodeBackup(await download(backupId))
      await closeRuntime()
      await swapNamespaces(connection,staged,archived); swapped=true
      await openRuntime()
      upload=null
      // Retained safety bytes are separate from application schemas.
      await discard(archived).catch(()=>console.error('PostgreSQL previous schemas retained after successful restore'))
      return {ok:true,backupId,action:kind,requiresLogin:true}
    } catch(error) {
      if(swapped) {
        try {
          await closeRuntime()
          await swapNamespaces(connection,archived,staged)
          await openRuntime()
        } catch { broken=true; throw new ApiError(503,'데이터 복구가 중단되었습니다. 보존된 이전 스키마에서 복구가 필요합니다.') }
      } else await openRuntime()
      throw error
    } finally { if(!broken) await discard(staged) }
  }
  return {track,exclusive,backup,preview,replace,backups,download,
    get busy(){return busy||broken},get broken(){return broken},
    async status(){return {maxBackupBytes:MAX_BACKUP_BYTES,resetEnabled:(env.ADMIN_PASSWORD||'').length>=16,backups:await backups(),database:'postgresql'}}}
}
