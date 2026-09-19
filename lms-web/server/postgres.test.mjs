import { courseManagementScenario } from './course-management-scenario.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { BOT_TABLES } from './bot-storage.mjs'
import { createRuntime } from './runtime.mjs'
import { createDataMaintenance, decodeBackup } from './data-maintenance.mjs'
import { createAttendanceCodes } from './attendance-codes.mjs'
import { databaseContext, closePostgresConnections, identifier } from './postgres/database.mjs'
import { discard, importPostgres } from './postgres/backup.mjs'
import { migrateBackup, verifyImportedData } from './postgres/migrate.mjs'
import { schemas, exportPostgres } from './postgres/backup.mjs'
import { createPythonStorageExecutor } from './python-storage-executor.mjs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { rosterScenario } from './roster-scenarios.mjs'
import { courseVideosScenario } from './course-videos-scenario.mjs'
import { assignmentCourseScenario } from './assignment-course-scenario.mjs'

const url=process.env.POSTGRES_TEST_URL
const pgTest=(name,action)=>test(name,{skip:!url},t=>databaseContext(()=>action(t)))
after(closePostgresConnections)
pgTest('PostgreSQL course edits ignore unrelated writes and validate weekly schedules', async t => {
  const f = await fixture(t)
  await courseManagementScenario(f.runtime)
})
pgTest('PostgreSQL assignment course binding is atomic and never guesses between courses', async t => {
  const f = await fixture(t)
  await assignmentCourseScenario(f.runtime.workspaces, f.runtime.botStorage)
})
pgTest('PostgreSQL handles 80 queued classroom logins without sharing account attempt limits', async t => {
  const f = await fixture(t), db = f.runtime.store.db, auth = f.runtime.auth;
  const names = [];
  for (let i = 0; i < 80; i++) {
    const name = `classroom.${i}`; names.push(name);
    await db.prepare("INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at) SELECT ?,?,?,password_hash,?,'',? FROM lms_users WHERE id=?").run(name,name,name,`pending:${name}`,Date.now(),f.login.user.id);
  }
  const logins = await Promise.all(names.map(username => databaseContext(() => auth.login({username,password:'strong-test-password'}))));
  assert.equal(new Set(logins.map(login => login.user.id)).size,80);
})
pgTest('PostgreSQL course videos enforce enrollment, owner access and upload retry semantics', async t => {
  const f = await fixture(t)
  await courseVideosScenario(f.runtime)
})
pgTest('PostgreSQL roster import and student profile lifecycle', async t => {
  const f = await fixture(t)
  await rosterScenario(f.runtime, f.login.user)
})
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'ax-pg-')),dbPath=join(dir,'unused.db')
  const env={NODE_ENV:'test',ADMIN_PASSWORD:'postgres-test-bootstrap-key',DATABASE_URL:url,PG_NAMESPACE:'t'+randomUUID().replaceAll('-','').slice(0,12)}
  let runtime=await createRuntime(dbPath,env)
  const cleanups=[]
  const connection=runtime.store.db.connection
  t.after(async()=>{for(const cleanup of cleanups) await cleanup();await runtime.close();await discard(connection);await connection.pool.query(`DROP SCHEMA IF EXISTS ${identifier(connection.namespace+'_control')} CASCADE`);rmSync(dir,{recursive:true,force:true,maxRetries:3})})
  const maintenance=createDataMaintenance({dbPath,env,getRuntime:()=>runtime,closeRuntime:()=>runtime.close(),openRuntime:async()=>{runtime=await createRuntime(dbPath,env)}})
  const login=await runtime.auth.setup({username:'pg.owner',name:'관리자',password:'strong-test-password',setupKey:env.ADMIN_PASSWORD})
  return {get runtime(){return runtime},maintenance,login,connection,dir,env,cleanups}
}

pgTest('PostgreSQL preserves bot receipts, duplicate booking semantics, worker reuse and submission outbox',async t=>{
  const f=await fixture(t),r=f.runtime,guildId='123456789012345678'
  const workspace=await r.workspaces.create({name:'PG 과정',guildId})
  const call=(operation,args=[],requestId=randomUUID())=>r.botStorage.call({guildId,operation,args,requestId})
  const requestId=randomUUID(),mentor=await call('add_mentor',['223456789012345678','멘토',''],requestId)
  assert.deepEqual(await call('add_mentor',['223456789012345678','멘토',''],requestId),mentor)
  const slot=await call('add_slot',[mentor.result,'2026-10-01T10:00:00','2026-10-01T10:50:00','예약'])
  assert.equal((await call('create_booking',[slot.result,'323456789012345678','학생'])).result,true)
  assert.equal((await call('create_booking',[slot.result,'423456789012345678','중복'])).result,false)
  await (await r.workspaces.open(workspace.id)).db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?)').run('courses','assignment-course',JSON.stringify({id:'assignment-course',title:'과제 과정'}))
  const assignment=await call('create_assignment',[1,'과제','설명','2026-10-01','individual'])
  assert.equal((await call('create_submission',[assignment.result,'323456789012345678','학생','','제출',''])).result,true)
  const db=(await r.workspaces.open(workspace.id)).db
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_outbox WHERE kind='submission'").get()).n,1)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM bookings').get()).n,1)
  assert.equal(r.botStorage.diagnostics().workerStarts,1)
  await call('set_slot_template',[mentor.result,10,0,11,0,30])
  await call('block_date',[mentor.result,'2026-10-03'])
  const schedule=await call('generate_slots_for_range',[mentor.result,{$lms:'date',value:'2026-10-02'},{$lms:'date',value:'2026-10-03'}])
  assert.deepEqual(schedule.result,{$lms:'tuple',value:[2,1]})
  const round=await call('create_peer_round',['평가'])
  await call('save_peer_evaluation',[round.result,'1조','323456789012345678','423456789012345678','학생',[4,5,3,4],'의견'])
  const evaluations=await r.botStorage.table(workspace.id,'peer_evaluations')
  assert.equal(evaluations.rows[0].score1,4)
  assert.equal(evaluations.rows[0].comment,'의견')
})

pgTest('PostgreSQL attendance handles concurrent students and duplicate codes without overwriting corrections',async t=>{
  const f=await fixture(t),r=f.runtime,db=r.store.db,guildId='123456789012345678',selection={courseId:'course',date:'2026-09-18',period:1}
  await db.prepare('INSERT INTO lms_workspace_guilds VALUES(?,?)').run(guildId,'default')
  const put=(kind,row)=>db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind,row.id,JSON.stringify(row))
  await put('courses',{id:'course',title:'과정'})
  await put('teams',{id:'t1',name:'1조',courseId:'course'})
  const students=[]
  for(let i=0;i<20;i++){
    const id='s'+i,discordId=String(323456789012345678n+BigInt(i))
    await db.prepare('INSERT INTO lms_users(id,username,name,password_hash,discord_id,guild_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id,id,id,'unused',discordId,guildId,Date.now())
    await db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,?)').run('default',id,'student',Date.now())
    await db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run('default',id,guildId,discordId,Date.now())
    await put('learners',{id,discordId,courseId:'course',name:id,team:'1조',status:'정상'})
    students.push(discordId)
  }
  const admin=f.login.user,codes=createAttendanceCodes(db,r.workspaces,r.attendance)
  const view=()=>r.attendance.view('default',selection,admin)
  await r.attendance.save('default',{...selection,action:'start',entries:[],revision:(await view()).revision,requestId:randomUUID()},admin)
  const {code}=await codes.issue('default',selection,admin)
  const results=await Promise.all([...students,students[0]].map(discordId=>databaseContext(()=>codes.checkIn({guildId,discordId,code}))))
  assert.equal(results.filter(result=>result.alreadyRecorded).length,1)
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_records WHERE kind='attendance'").get()).n,20)
  await r.attendance.save('default',{...selection,action:'save',entries:[{studentId:'s0',status:'지각',reason:'정정'}],revision:(await view()).revision,requestId:randomUUID()},admin)
  assert.equal((await codes.checkIn({guildId,discordId:students[0],code})).status,'지각')
})

pgTest('SQLite backups import into PostgreSQL and PostgreSQL reset/restore retains accounts, workspaces and sequence counters',async t=>{
  const f=await fixture(t)
  const sqlitePath=join(f.dir,'legacy.db'),legacy=await createRuntime(sqlitePath,{NODE_ENV:'test',ADMIN_PASSWORD:f.env.ADMIN_PASSWORD})
  f.cleanups.push(()=>legacy.close())
  const login=await legacy.auth.setup({username:'legacy.owner',name:'이관 관리자',password:'strong-test-password',setupKey:f.env.ADMIN_PASSWORD})
  const workspace=await legacy.workspaces.create({name:'보존할 과정'})
  await legacy.workspaces.setArchived(workspace.id,true,login.user)
  const oldDb=(await legacy.workspaces.open(workspace.id)).db
  await oldDb.prepare("INSERT INTO mentors(id,discord_id,name) VALUES(901,'223456789012345678','보존 멘토')").run()
  await oldDb.prepare("INSERT INTO mentors(id,discord_id,name) VALUES(999,'323456789012345678','삭제 멘토')").run()
  await oldDb.prepare('DELETE FROM mentors WHERE id=999').run()
  const oldMaintenance=createDataMaintenance({dbPath:sqlitePath,env:{NODE_ENV:'test',ADMIN_PASSWORD:f.env.ADMIN_PASSWORD},getRuntime:()=>legacy})
  const bytes=await oldMaintenance.backup(),preview=await f.maintenance.preview(bytes,f.login.user.id)
  await f.maintenance.replace('restore',preview.token,f.login.user.id)
  assert.equal((await f.runtime.auth.login({username:'legacy.owner',password:'strong-test-password'})).user.name,'이관 관리자')
  let db=(await f.runtime.workspaces.open(workspace.id)).db
  assert.equal((await db.prepare("INSERT INTO mentors(discord_id,name) VALUES('423456789012345678','새 멘토')").run()).lastInsertRowid,1000)
  const native=await f.maintenance.backup()
  assert.equal(decodeBackup(native).database,'postgresql')
  await f.maintenance.replace('reset',null,login.user.id)
  assert.equal(await f.runtime.auth.setupEnabled(),true)
  const next=await f.maintenance.preview(native,login.user.id)
  await f.maintenance.replace('restore',next.token,login.user.id)
  db=(await f.runtime.workspaces.open(workspace.id)).db
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM mentors').get()).n,2)
  assert.notEqual((await f.runtime.workspaces.metadata(workspace.id)).archivedAt,null)
  assert.equal(await f.runtime.auth.session(login.token),null)
  assert.equal((await f.maintenance.backups()).length,3)
})

pgTest('invalid PostgreSQL restore rolls back the staged import and never changes live accounts',async t=>{
  const f=await fixture(t),data=decodeBackup(await f.maintenance.backup())
  const main=data.databases.find(entry=>entry.id==='main'),sessions=main.tables.find(table=>table.name==='lms_auth_sessions')
  sessions.rows[0][sessions.columns.indexOf('user_id')]='missing-account'
  const staged={...f.connection,namespace:'bad'+randomUUID().replaceAll('-','').slice(0,12)}
  try {await assert.rejects(importPostgres(staged,data),{code:'23503'})} finally {await discard(staged)}
  assert.equal((await f.runtime.auth.session(f.login.token)).id,f.login.user.id)
})

pgTest('migration verifies all rows in a dry run, publishes once and rejects an occupied target',async t=>{
  const f=await fixture(t),bytes=await f.maintenance.backup()
  const target={...f.connection,namespace:'m'+randomUUID().replaceAll('-','').slice(0,12)}
  f.cleanups.push(()=>discard(target))
  const dry=await migrateBackup(target,bytes)
  assert.equal(dry.applied,false)
  assert.deepEqual(await schemas(target),[])
  const applied=await migrateBackup(target,bytes,{apply:true})
  assert.equal(applied.applied,true)
  assert.ok(applied.rows>0)
  await assert.rejects(migrateBackup(target,bytes,{apply:true}),/already exists/)
  const restored=decodeBackup(await exportPostgres(target))
  const users=restored.databases.find(d=>d.id==='main').tables.find(t=>t.name==='lms_users')
  assert.equal(users.rows.length,1)
  const changed=structuredClone(restored)
  changed.databases.find(d=>d.id==='main').tables.find(t=>t.name==='lms_users').rows[0][2]='changed'
  assert.throws(()=>verifyImportedData(restored,changed),/Imported rows differ/)
})

pgTest('PostgreSQL legacy bootstrap preserves IDs and advances identities; invitations own or join a transaction',async t=>{
  const f=await fixture(t),r=f.runtime,guildId='723456789012345678'
  const workspace=await r.workspaces.create({name:'Legacy bot',guildId})
  const data={version:1,guildId,tables:Object.fromEntries(Object.keys(BOT_TABLES).map(name=>[name,[]])),settings:{channels:{},teams:[],qaUnansweredHours:24},runtime:[]}
  data.tables.mentors=[{id:400,discord_id:'823456789012345678',name:'imported',bio:''}]
  const archive=JSON.stringify(data)
  await r.botStorage.bootstrap({guildId,archive,checksum:createHash('sha256').update(archive).digest('hex')})
  const next=await r.botStorage.call({guildId,operation:'add_mentor',args:['923456789012345678','new',''],requestId:randomUUID()})
  assert.equal(next.result,401)
  const invite=await r.workspaces.invite(workspace.id,{username:'invited.admin',role:'admin'},f.login.user)
  assert.ok(invite.token)
  const db=r.store.db
  await db.exec('BEGIN')
  await r.workspaces.invite(workspace.id,{username:'rolledback.admin',role:'admin'},f.login.user)
  await db.exec('ROLLBACK')
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_workspace_invitations WHERE username='rolledback.admin'").get()).n,0)
})

pgTest('PostgreSQL bot reads bypass a blocked writer and abandoned request transactions roll back',async t=>{
  const f=await fixture(t),r=f.runtime,guildId='623456789012345678'
  const workspace=await r.workspaces.create({name:'Concurrent storage',guildId})
  const db=(await r.workspaces.open(workspace.id)).db
  await db.prepare("INSERT INTO mentors(discord_id,name) VALUES('523456789012345678','committed')").run()
  const call=(operation,args=[])=>r.botStorage.call({guildId,operation,args,requestId:randomUUID()})
  let pendingWrite
  await databaseContext(async()=>{
    await db.exec('BEGIN')
    await db.prepare("UPDATE mentors SET name='uncommitted'").run()
    pendingWrite=call('add_mentor',['423456789012345678','second',''])
    pendingWrite.catch(()=>{})
    const read=await call('get_mentors')
    assert.equal(Object.fromEntries(read.result[0].value).name,'committed')
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_storage_receipts').get()).n,0)
    // Deliberately omit COMMIT/ROLLBACK: the request context must release its client.
  })
  await pendingWrite
  assert.equal((await db.prepare("SELECT name FROM mentors WHERE discord_id='523456789012345678'").get()).name,'committed')
  assert.equal(r.botStorage.diagnostics().workerStarts,2)
})

pgTest('a PostgreSQL connection outage is retryable for the bot bridge',async t=>{
  const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening')
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve))
  const executor=createPythonStorageExecutor({python:process.env.PYTHON_EXECUTABLE||'python3',script:'server/storage_worker.py',env:{DATABASE_URL:`postgresql://test:test@127.0.0.1:${port}/test`}})
  t.after(()=>executor.close())
  await assert.rejects(executor.execute({schema:'outage_main',request:{operation:'get_mentors',args:[],requestId:randomUUID(),guildId:'123456789012345678'}},0),{status:503})
})
