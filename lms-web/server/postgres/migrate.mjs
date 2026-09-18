import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { decodeBackup, safeRestoreState } from '../data-maintenance.mjs'
import { databaseContext, openPostgres } from './database.mjs'
import { schemas, importPostgres, exportPostgres, swapNamespaces, discard } from './backup.mjs'

const normalized = value => value && typeof value === 'object' && 'integer' in value ? Number(value.integer) : value
function rows(table, columns) {
  const indexes=columns.map(name=>table.columns.indexOf(name))
  return table.rows.map(row=>JSON.stringify(indexes.map(index=>normalized(row[index])))).sort()
}
export function verifyImportedData(source, restored) {
  let count=0, tables=0
  assert.equal(restored.databases.length,source.databases.length,'Database count differs')
  for(const entry of source.databases) {
    const target=restored.databases.find(candidate=>candidate.id===entry.id)
    assert.ok(target,'Missing workspace')
    for(const table of entry.tables) {
      const imported=target.tables.find(candidate=>candidate.name===table.name)
      assert.ok(imported,'Missing table')
      if(table.name==='sqlite_sequence') {
        for(const [name,value] of table.rows) assert.ok(imported.rows.some(row=>row[0]===name && row[1]>=Number(normalized(value))),'Sequence moved backwards')
      } else {
        assert.deepEqual(rows(imported,table.columns),rows(table,table.columns),`Imported rows differ: ${table.name}`)
        count+=table.rows.length;tables++
      }
    }
  }
  const main=source.databases.find(entry=>entry.id==='main')
  const workspaces=main.tables.find(table=>table.name==='lms_workspaces')
  for(const row of workspaces.rows) {
    const id=row[workspaces.columns.indexOf('id')]
    assert.ok(id==='default' || source.databases.some(entry=>entry.id===id),'Missing registered workspace database')
  }
  return {databases:source.databases.length,tables,rows:count}
}

// A dry run stages, compares every source row and removes only its own temporary schemas.
// Publishing is permitted only into an unused namespace and never overwrites live data.
export async function migrateBackup(connection, bytes, {apply=false}={}) {
  const source=decodeBackup(bytes)
  const staged={...connection,namespace:'mig'+randomUUID().replaceAll('-','').slice(0,12)}
  const lock=await connection.pool.connect()
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))',['migration:'+connection.namespace])
    if((await schemas(connection)).length) throw new Error('Target namespace already exists; migration will not overwrite it')
    await importPostgres(staged,source)
    const summary=verifyImportedData(source,decodeBackup(await exportPostgres(staged)))
    for(const entry of source.databases) await databaseContext(async()=>safeRestoreState(await openPostgres(staged,entry.id==='main'?'default':entry.id)))
    if(apply) {
      // Repeat after staging to catch an application accidentally started during migration.
      if((await schemas(connection)).length) throw new Error('Target namespace was initialized during migration')
      await swapNamespaces(connection,staged,{...connection,namespace:'old'+randomUUID().replaceAll('-','').slice(0,12)})
    }
    return {...summary,applied:apply}
  } finally {
    try {await discard(staged)} finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['migration:'+connection.namespace])
      lock.release()
    }
  }
}
