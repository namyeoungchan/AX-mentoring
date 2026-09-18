import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import metadata from './schema.json' with { type: 'json' }
import { identifier, schemaName, openPostgres } from './database.mjs'

const names = Object.keys(metadata.tables)
const workspaceId = /^[a-z0-9-]{1,64}$/
function cell(value) {
  if(value===null || typeof value==='string' || typeof value==='number') return value
  if(value && Object.keys(value).length===1 && typeof value.integer==='string' && /^-?\d+$/.test(value.integer)) {
    const integer=BigInt(value.integer)
    if(integer>=-9223372036854775808n && integer<=9223372036854775807n) return value.integer
  }
  throw new Error('Invalid backup cell')
}
export async function schemas(connection, client = connection.pool) {
  const rows = (await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1 OR left(schema_name,$2)=$3 ORDER BY schema_name', [schemaName(connection.namespace), `${connection.namespace}_w_`.length, `${connection.namespace}_w_`])).rows
  return rows.map(row=>row.schema_name)
}
export async function discard(connection) {
  for (const schema of await schemas(connection)) await connection.pool.query(`DROP SCHEMA ${identifier(schema)} CASCADE`)
}
export async function exportPostgres(connection) {
  const client = await connection.pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const databases = []
    for (const schema of await schemas(connection, client)) {
      await client.query(`SET LOCAL search_path TO ${identifier(schema)},pg_catalog`)
      const tables = [], sequences = []
      for (const [name, info] of Object.entries(metadata.tables)) {
        const columns = info.columns
        const result = await client.query({ text: `SELECT ${columns.map(identifier).join(',')} FROM ${identifier(name)} ORDER BY _ax_order`, rowMode: 'array' })
        tables.push({ name, columns, rows: result.rows })
        if (info.identity) {
          const sequence = (await client.query('SELECT pg_get_serial_sequence($1,$2) AS name', [`${schema}.${name}`, 'id'])).rows[0].name
          const value = (await client.query(`SELECT last_value,is_called FROM ${sequence.split('.').map(identifier).join('.')}`)).rows[0]
          sequences.push([name, value.is_called ? value.last_value : 0])
        }
      }
      tables.push({ name: 'sqlite_sequence', columns: ['name','seq'], rows: sequences })
      const id = schema === schemaName(connection.namespace) ? 'main' : schema.slice(`${connection.namespace}_w_`.length).replaceAll('_','-')
      databases.push({ id, tables })
    }
    await client.query('COMMIT')
    const payload = JSON.stringify({ createdAt: new Date().toISOString(), database: 'postgresql', databases })
    return gzipSync(JSON.stringify({ format:'ax-learningops-backup',version:1,sha256:createHash('sha256').update(payload).digest('hex'),payload }))
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function importPostgres(connection, data) {
  // Only application-owned tables and columns are accepted. SQL never comes from a backup.
  for (const entry of data.databases) {
    if (!workspaceId.test(entry.id) || entry.id === 'default') throw new Error('Invalid backup workspace')
    await openPostgres(connection, entry.id === 'main' ? 'default' : entry.id)
  }
  const client = await connection.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET CONSTRAINTS ALL DEFERRED')
    for (const entry of data.databases) {
      const schema = schemaName(connection.namespace, entry.id === 'main' ? 'default' : entry.id)
      await client.query(`SET LOCAL search_path TO ${identifier(schema)},pg_catalog`)
      for (const name of names) await client.query(`ALTER TABLE ${identifier(name)} DISABLE TRIGGER USER`)
      await client.query(`TRUNCATE ${names.map(identifier).join(',')} RESTART IDENTITY`)
      const seen = new Set()
      for (const table of entry.tables) {
        if (seen.has(table.name)) throw new Error('Duplicate backup table')
        seen.add(table.name)
        if (table.name === 'sqlite_sequence') continue
        const expected = metadata.tables[table.name]?.columns
        if (!expected || !Array.isArray(table.columns) || table.columns.length !== expected.length || new Set(table.columns).size !== expected.length || table.columns.some(name=>!expected.includes(name)) || !Array.isArray(table.rows)) throw new Error('Invalid backup columns')
        const sql = `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(',')}) VALUES (${table.columns.map((_,i)=>`$${i+1}`).join(',')})`
        for (const row of table.rows) {
          if (!Array.isArray(row) || row.length !== expected.length) throw new Error('Invalid backup row')
          await client.query(sql,row.map(cell))
        }
      }
      if (!seen.has('lms_records') || !seen.has('mentors') || (entry.id === 'main' && (!seen.has('lms_users') || !seen.has('lms_workspaces')))) throw new Error('Incomplete backup')
      const sequence = entry.tables.find(t=>t.name==='sqlite_sequence')
      if (sequence && (JSON.stringify(sequence.columns)!==JSON.stringify(['name','seq']) || !Array.isArray(sequence.rows))) throw new Error('Invalid sequences')
      for (const [name, info] of Object.entries(metadata.tables)) if (info.identity) {
        const max = Number((await client.query(`SELECT COALESCE(MAX(id),0) AS value FROM ${identifier(name)}`)).rows[0].value)
        const saved = Number(cell(sequence?.rows.find(row=>row[0]===name)?.[1] ?? 0))
        if (!Number.isSafeInteger(saved) || saved < 0) throw new Error('Invalid sequence value')
        const value = Math.max(saved,max)
        await client.query('SELECT setval(pg_get_serial_sequence($1,$2),$3,$4)', [`${schema}.${name}`,'id',Math.max(1,value),value>0])
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      for (const name of names) await client.query(`ALTER TABLE ${identifier(name)} ENABLE TRIGGER USER`)
      await client.query('SET CONSTRAINTS ALL DEFERRED')
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE')
    await client.query('COMMIT')
  } catch(error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

export async function swapNamespaces(live, staged, archived) {
  const client = await live.pool.connect()
  try {
    await client.query('BEGIN')
    for (const [from,to] of [[live,archived],[staged,live]]) {
      for (const schema of await schemas(from,client)) {
        const destination = to.namespace + schema.slice(from.namespace.length)
        await client.query(`ALTER SCHEMA ${identifier(schema)} RENAME TO ${identifier(destination)}`)
      }
    }
    await client.query('COMMIT')
  } catch(error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
