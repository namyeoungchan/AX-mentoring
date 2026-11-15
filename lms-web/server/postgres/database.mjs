import pg from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import metadata from './schema.json' with { type: 'json' }

const contexts = new AsyncLocalStorage()
const connections = new Map()
const pools = new Map()
export async function closePostgresConnections() {
  await Promise.all([...pools.values()].map(pool=>pool.end()))
  connections.clear(); pools.clear()
}
const queryTails = new WeakMap()
function queryClient(client, sql, values) {
  const task = (queryTails.get(client) || Promise.resolve()).catch(() => {}).then(() => client.query(sql, values))
  queryTails.set(client, task)
  return task
}
pg.types.setTypeParser(20, value => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds the supported range')
  return number
})
pg.types.setTypeParser(1700, value => {
  const number=Number(value)
  if(!Number.isFinite(number) || Math.abs(number)>Number.MAX_SAFE_INTEGER) throw new Error('Database numeric exceeds the supported range')
  return number
})
export const databaseContext = action => contexts.run(new Map(), async () => {
  try { return await action() }
  finally {
    // Never return a connection with an abandoned transaction to the shared pool.
    const state=contexts.getStore()
    for(const client of state.values()) {
      try {await queryClient(client,'ROLLBACK')} finally {client.release()}
    }
    state.clear()
  }
})
export const identifier = value => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid database identifier')
  return `"${value}"`
}
export function schemaName(namespace, workspaceId = 'default') {
  return workspaceId === 'default' ? `${namespace}_main` : `${namespace}_w_${workspaceId.replaceAll('-', '_')}`
}
export function postgresConnection(env = process.env) {
  if (!env.DATABASE_URL) return null
  const namespace = env.PG_NAMESPACE || 'ax'
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(namespace)) throw new Error('Invalid PG_NAMESPACE')
  const max = Number(env.PG_POOL_MAX || 10)
  if (!Number.isInteger(max) || max < 2 || max > 30) throw new Error('PG_POOL_MAX must be between 2 and 30')
  const key = `${env.DATABASE_URL}|${namespace}|${max}`
  if (!connections.has(key)) {
    const poolKey = `${env.DATABASE_URL}|${max}`
    if (!pools.has(poolKey)) {
      const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 25000, lock_timeout: 5000, application_name: 'ax-learningops' })
      pool.on('error', () => console.error('PostgreSQL idle connection failed'))
      pools.set(poolKey,pool)
    }
    const pool = pools.get(poolKey)
    connections.set(key, { pool, namespace })
  }
  return connections.get(key)
}

// Parameter binding, legacy column casing, and INSERT conflict syntax live here,
// while all I/O remains asynchronous and transactions retain a checked-out client.
export function postgresSql(sql) {
  let count = 0
  sql = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, token => token === '?' ? `$${++count}` : token)
  sql = sql.replace(/\bAS ([a-z_][a-z0-9_]*[A-Z][a-zA-Z0-9_]*)\b/g, 'AS "$1"')
  sql = sql.replace(/\browid\b/gi, '_ax_order')
  sql = sql.replace(/\bGROUP_CONCAT\(/gi,'STRING_AGG(').replace(/\bchar\(/gi,'chr(')
  sql = sql.replace(/\bjson_each\((\$\d+)\)/g, (_,value)=>`json_array_elements_text(${value}::json) AS value`)
  sql = sql.replace(/NOT GLOB '\*\[\^0-9\]\*'/g, () => "~ '^[0-9]+$'")
  sql = sql.replace(/\$(\d+) IS NULL/g, (_, n) => `$${n}::text IS NULL`)
  sql = sql.replace(/\bIS \$(\d+)/g, (_, n) => `IS NOT DISTINCT FROM $${n}`)
  const ignored = /^\s*INSERT OR IGNORE INTO\b/i.test(sql)
  sql = sql.replace(/^\s*INSERT OR IGNORE INTO\b/i, 'INSERT INTO')
  if (ignored) sql = sql.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING')
  sql = sql.replace(/\bINSERT INTO (\w+)\s+(VALUES|SELECT)\b/gi, (match, table, tail) => {
    if (!metadata.tables[table]) throw new Error('Unknown insert table')
    return `INSERT INTO ${identifier(table)} (${metadata.tables[table].columns.map(identifier).join(',')}) ${tail}`
  })
  return sql
}

export async function openPostgres(connection, workspaceId = 'default') {
  const schema = schemaName(connection.namespace, workspaceId)
  identifier(schema)
  const { pool } = connection
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`schema:${schema}`])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)}`)
    await client.query(`SET LOCAL search_path TO ${identifier(schema)},pg_catalog`)
    const present = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='_ax_migrations'", [schema])
    if (!present.rowCount) {
      await client.query(readFileSync(new URL('./functions.sql', import.meta.url), 'utf8'))
      await client.query(readFileSync(new URL('./tables.sql', import.meta.url), 'utf8'))
      await client.query(readFileSync(new URL('./triggers.sql', import.meta.url), 'utf8'))
      await client.query('CREATE TABLE _ax_migrations(version INTEGER PRIMARY KEY); INSERT INTO _ax_migrations VALUES(1)')
    }
    const version=(await client.query('SELECT MAX(version) AS version FROM _ax_migrations')).rows[0].version
    if(![1,2,3].includes(version)) throw new Error('Unsupported PostgreSQL schema version')
    if(version===1) {
      await client.query('ALTER TABLE lms_users ADD COLUMN IF NOT EXISTS is_super_admin BIGINT NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0,1))')
      await client.query('INSERT INTO _ax_migrations VALUES(2)')
    }
    if(version<3) {
      await client.query(readFileSync(new URL('./mentoring-feedback.sql', import.meta.url), 'utf8'))
      await client.query('INSERT INTO _ax_migrations VALUES(3)')
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
  const db = { dialect: 'postgres', connection, schema, workspaceId,
    async resetIdentitySequences(tables) {
      for(const table of tables) if(metadata.tables[table]?.identity) {
        const sequence=(await db.query("SELECT pg_get_serial_sequence($1,'id') AS name",[`${schema}.${table}`])).rows[0].name
        const current=(await db.query(`SELECT last_value,is_called FROM ${sequence.split('.').map(identifier).join('.')}`)).rows[0]
        const max=(await db.query(`SELECT COALESCE(MAX(id),0) AS value FROM ${identifier(table)}`)).rows[0].value
        const value=Math.max(max,current.is_called?current.last_value:0)
        await db.query('SELECT setval($1,$2,$3)',[sequence,Math.max(1,value),value>0])
      }
    },
    get isTransaction() { return Boolean(contexts.getStore()?.get(db)) },
    async query(sql, values = []) {
      const transaction = contexts.getStore()?.get(db)
      const client = transaction || await pool.connect()
      try {
        if (!transaction) await client.query(`SET search_path TO ${identifier(schema)},pg_catalog`)
        const result = await queryClient(client, sql, values)
        for (const row of result.rows || []) delete row._ax_order
        return result
      } finally { if (!transaction) client.release() }
    },
    prepare(sql) {
      const tableInfo = sql.match(/^PRAGMA table_info\("?(\w+)"?\)$/i)
      async function rows(values) {
        if (tableInfo) return metadata.tables[tableInfo[1]].columns.map(name=>({name}))
        if (sql.includes('FROM sqlite_master')) {
          const name = values[0] || sql.match(/WHERE name='([^']+)'/)?.[1]
          const type = sql.match(/type='([^']+)'/)?.[1]
          return metadata.legacy.filter(row => (!name || row.name === name) && (!type || row.type === type))
        }
        if (sql === 'PRAGMA foreign_key_check') return [] // PostgreSQL enforces all declared FKs.
        return (await db.query(postgresSql(sql),values)).rows
      }
      return { all: (...values)=>rows(values), get: async (...values)=>(await rows(values))[0],
        async run(...values) {
          let query = postgresSql(sql)
          const table = query.match(/^\s*INSERT INTO "?(\w+)"?/i)?.[1]
          if (table && metadata.tables[table]?.identity && !/\bRETURNING\b/i.test(query)) query += ' RETURNING id'
          const result = await db.query(query,values)
          return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id }
        },
      }
    },
    async exec(sql) {
      const command = sql.trim().toUpperCase()
      // Schema changes are versioned in postgres/*.sql, not run as SQLite DDL.
      if (/^(CREATE|ALTER|DROP INDEX|PRAGMA)\b/.test(command)) return
      let state = contexts.getStore()
      if (command === 'BEGIN IMMEDIATE' || command === 'BEGIN') {
        if (!state) { state = new Map(); contexts.enterWith(state) }
        if (state.has(db)) throw new Error('Nested database transaction')
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query(`SET LOCAL search_path TO ${identifier(schema)},pg_catalog`)
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`write:${schema}`])
          state.set(db, client)
        } catch (error) { await client.query('ROLLBACK'); client.release(); throw error }
        return
      }
      if (command === 'COMMIT' || command === 'ROLLBACK') {
        const client = state?.get(db)
        if (!client) throw new Error('No active database transaction')
        try { await client.query(command) } finally { state.delete(db); client.release() }
        return
      }
      return db.query(postgresSql(sql))
    },
    close() {},
  }
  return db
}
