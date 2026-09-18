"""Async PostgreSQL execution for the legacy bot repository's cursor contract."""
import json
import re
import sqlite3
from pathlib import Path
import psycopg

TABLES = json.loads((Path(__file__).parent / 'postgres/schema.json').read_text(encoding='utf-8'))['tables']


class Row(dict):
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


class Cursor:
    def __init__(self, connection, sql, parameters):
        self.connection, self.sql, self.parameters = connection, sql, parameters
        self.rows, self.rowcount, self.lastrowid = [], 0, None

    async def execute(self):
        sql = self.sql
        if sql.strip().upper().startswith('BEGIN'):
            sql = 'SELECT 1'
        ignored = bool(re.match(r'\s*INSERT OR IGNORE', sql, re.I))
        sql = re.sub(r'\bINSERT OR IGNORE\b', 'INSERT', sql, flags=re.I)
        if ignored:
            sql = sql.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING'
        # Bind values; quoted SQL text is never interpolated with input values.
        sql = sql.replace('%', '%%')
        sql = re.sub(r"'(?:''|[^'])*'|\?", lambda m: '%s' if m[0] == '?' else m[0], sql)
        insert = re.match(r'\s*INSERT INTO (\w+)', sql, re.I)
        identity = insert and TABLES.get(insert[1], {}).get('identity')
        if identity:
            sql += ' RETURNING id'
        try:
            # A handled duplicate must not abort the surrounding receipt transaction.
            async with self.connection.raw.transaction():
                cur = await self.connection.raw.execute(sql, self.parameters)
                self.rowcount = cur.rowcount
                if cur.description:
                    names = [col.name for col in cur.description]
                    values = await cur.fetchall()
                    if identity and values:
                        self.lastrowid = values[0][0]
                    for value in values:
                        row = Row((key, item) for key, item in zip(names, value) if key != '_ax_order')
                        self.rows.append(row if self.connection.row_factory else tuple(row.values()))
        except psycopg.IntegrityError as error:
            raise sqlite3.IntegrityError('Data constraint failed') from error
        return self

    def __await__(self):
        return self.execute().__await__()

    async def __aenter__(self):
        return await self.execute()

    async def __aexit__(self, *_):
        return False

    async def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    async def fetchall(self):
        rows, self.rows = self.rows, []
        return rows


class Connection:
    def __init__(self, raw):
        self.raw, self.row_factory = raw, None

    def execute(self, sql, parameters=()):
        return Cursor(self, sql, parameters)

    async def commit(self):
        await self.raw.commit()

    async def rollback(self):
        await self.raw.rollback()


async def connect(url, schema, read_only):
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', schema):
        raise ValueError('Invalid schema')
    raw = await psycopg.AsyncConnection.connect(url, connect_timeout=5)
    try:
        await raw.execute('BEGIN READ ONLY' if read_only else 'BEGIN')
        await raw.execute(psycopg.sql.SQL('SET LOCAL search_path TO {},pg_catalog').format(psycopg.sql.Identifier(schema)))
        await raw.execute("SET LOCAL statement_timeout='25s'; SET LOCAL lock_timeout='5s'")
        if not read_only:
            await raw.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('write:' + schema,))
        return Connection(raw)
    except BaseException:
        await raw.close()
        raise
