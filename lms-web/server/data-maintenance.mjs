import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPostgresMaintenance } from './postgres/maintenance.mjs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, createStore } from './store.mjs';
import { installBotStorage } from './bot-storage.mjs';
import { createRuntime } from './runtime.mjs';
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const workspaceId = /^[a-z0-9-]{1,64}$/;
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const hash = data => createHash('sha256').update(data).digest('hex');
const invalid = () => new ApiError(422, '백업 파일이 손상되었거나 현재 버전과 호환되지 않습니다.');
const tables = async (db) => (await (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name")).all()).map(row => row.name);
const columns = async (db, table) => (await (db.prepare(`PRAGMA table_info(${quote(table)})`)).all()).map(row => row.name);
const paths = dbPath => ({ main: dbPath, workspaces: dbPath + '.workspaces', job: dbPath + '.maintenance', backups: dbPath + '.backups' });
const remove = path => {
    if (existsSync(path))
        rmSync(path, { recursive: true, force: true });
};
async function checkpoint(db) { await db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
async function integrity(db) {
    if ((await (db.prepare('PRAGMA integrity_check')).get()).integrity_check !== 'ok' || (await (db.prepare('PRAGMA foreign_key_check')).all()).length)
        throw invalid();
}
// The journal uses fixed paths derived from BOT_DB_PATH, never uploaded paths.
// A process interruption before commit rolls both database locations back at startup.
export function recoverDataMaintenance(dbPath) {
    const p = paths(resolve(dbPath)), journalPath = join(p.job, 'journal.json');
    if (!existsSync(journalPath))
        return;
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (journal.state !== 'committed') {
        for (const [key, previous] of [['main', 'main.db'], ['workspaces', 'workspaces']]) {
            const old = join(p.job, 'previous', previous);
            if (existsSync(old)) {
                remove(p[key]);
                if (key === 'main') {
                    remove(p.main + '-wal');
                    remove(p.main + '-shm');
                }
                renameSync(old, p[key]);
            }
            else if (!journal.existed[key])
                remove(p[key]);
        }
    }
    remove(p.job);
}
function encodeCell(value) {
    if (typeof value === 'bigint')
        return { integer: String(value) };
    if (value instanceof Uint8Array)
        return { blob: Buffer.from(value).toString('base64') };
    return value;
}
function decodeCell(value) {
    if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
        return value;
    if (value && Object.keys(value).length === 1) {
        if (typeof value.integer === 'string' && /^-?\d{1,19}$/.test(value.integer)) {
            const n = BigInt(value.integer);
            if (n >= -(2n ** 63n) && n < 2n ** 63n)
                return n;
        }
        if (typeof value.blob === 'string' && Buffer.from(value.blob, 'base64').toString('base64') === value.blob)
            return Buffer.from(value.blob, 'base64');
    }
    throw invalid();
}
async function exportDatabase(db, id) {
    await integrity(db);
    return { id, tables: await Promise.all((await tables(db)).map(async (name) => {
            const statement = db.prepare(`SELECT * FROM ${quote(name)}`);
            statement.setReadBigInts(true);
            const names = await columns(db, name);
            return { name, columns: names, rows: (await statement.all()).map(row => names.map(column => encodeCell(row[column]))) };
        })) };
}
async function importDatabase(db, source) {
    const allowed = new Set(await tables(db)), seen = new Set();
    if (!Array.isArray(source.tables) || source.tables.length > 150)
        throw invalid();
    // Only the application's own schema and triggers execute. The upload contains values only.
    const triggers = await (db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")).all();
    await db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
        for (const trigger of triggers)
            await db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
        for (const name of allowed)
            await db.exec(`DELETE FROM ${quote(name)}`);
        for (const table of source.tables) {
            if (!allowed.has(table.name) || seen.has(table.name) || !Array.isArray(table.columns) || !Array.isArray(table.rows))
                throw invalid();
            seen.add(table.name);
            const current = await columns(db, table.name);
            const expected = table.name === 'lms_users' && !table.columns.includes('is_super_admin')
                ? current.filter(name => name !== 'is_super_admin') : current;
            if (table.columns.length !== expected.length || new Set(table.columns).size !== expected.length || table.columns.some(name => !expected.includes(name)))
                throw invalid();
            const statement = db.prepare(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
            // Restore sequence counters after all AUTOINCREMENT tables below.
            if (table.name === 'sqlite_sequence')
                continue;
            for (const row of table.rows) {
                if (!Array.isArray(row) || row.length !== expected.length)
                    throw invalid();
                await statement.run(...row.map(decodeCell));
            }
        }
        const sequence = source.tables.find(table => table.name === 'sqlite_sequence');
        if (sequence) {
            await db.exec('DELETE FROM sqlite_sequence');
            const statement = db.prepare(`INSERT INTO sqlite_sequence (${sequence.columns.map(quote).join(',')}) VALUES (?,?)`);
            for (const row of sequence.rows) {
                if (!Array.isArray(row) || row.length !== 2)
                    throw invalid();
                await statement.run(...row.map(decodeCell));
            }
        }
        if (!seen.has('lms_records') || !seen.has('mentors') || (source.id === 'main' && (!seen.has('lms_users') || !seen.has('lms_workspaces'))))
            throw invalid();
        for (const trigger of triggers)
            await db.exec(trigger.sql);
        await integrity(db);
        await db.exec('COMMIT');
    }
    catch (error) {
        await db.exec('ROLLBACK');
        throw error instanceof ApiError ? error : invalid();
    }
    finally {
        await db.exec('PRAGMA foreign_keys=ON');
    }
}
export function decodeBackup(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BACKUP_BYTES)
        throw invalid();
    try {
        const envelope = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }).toString('utf8'));
        if (envelope.format !== 'ax-learningops-backup' || envelope.version !== 1 || typeof envelope.payload !== 'string' || hash(envelope.payload) !== envelope.sha256)
            throw invalid();
        const data = JSON.parse(envelope.payload);
        if (!Array.isArray(data.databases) || !data.databases.length || data.databases.length > 200 || !Number.isFinite(Date.parse(data.createdAt)))
            throw invalid();
        const ids = new Set();
        for (const entry of data.databases) {
            if (typeof entry?.id !== 'string' || !workspaceId.test(entry.id) || entry.id === 'default' || ids.has(entry.id))
                throw invalid();
            ids.add(entry.id);
        }
        if (!ids.has('main'))
            throw invalid();
        return data;
    }
    catch {
        throw invalid();
    }
}
export async function safeRestoreState(db) {
    const names = new Set(await tables(db));
    if (names.has('lms_attendance_codes'))
        await db.exec('UPDATE lms_attendance_codes SET expires_at=0');
    if (names.has('lms_auth_sessions'))
        await db.exec('DELETE FROM lms_auth_sessions; DELETE FROM lms_registrations; DELETE FROM lms_auth_limits');
    // Old dispatch claims must never become valid again after a restore.
    if (names.has('lms_outbox'))
        await db.exec("UPDATE lms_outbox SET state='held',claim=NULL,lease_until=NULL,error='백업 복구로 자동 발송 중지' WHERE state IN ('pending','sending','reconcile','failed','uncertain')");
    if (names.has('lms_discord_jobs'))
        await db.exec("UPDATE lms_discord_jobs SET state='failed',claim_hash=NULL,lease_until=NULL,error_code='backup_restored' WHERE state IN ('queued','running')");
    if (names.has('lms_admissions'))
        await db.exec("UPDATE lms_admissions SET invite_state='failed',claim_hash=NULL,lease_until=NULL,invite_code=NULL,invite_expires=NULL WHERE invite_state IN ('queued','running','ready')");
}
export function createDataMaintenance({ dbPath, getRuntime, closeRuntime, openRuntime, env = process.env }) {
    if (getRuntime().store.db.dialect === 'postgres') return createPostgresMaintenance({ dbPath, getRuntime, closeRuntime, openRuntime, env });
    dbPath = resolve(dbPath);
    const p = paths(dbPath);
    let busy = false, broken = false, active = 0, upload = null;
    const track = handler => async (req, res, next) => {
        active++;
        try {
            await handler(req, res, next);
        }
        finally {
            active--;
        }
    };
    async function exclusive(action) {
        if (busy || broken)
            throw new ApiError(503, '데이터 관리 작업 중입니다. 잠시 후 다시 시도하세요.');
        busy = true;
        try {
            const deadline = Date.now() + 30000;
            while (active) {
                if (Date.now() > deadline)
                    throw new ApiError(409, '처리 중인 요청이 있습니다. 완료 후 다시 시도하세요.');
                await delay(25);
            }
            return await action();
        }
        finally {
            if (!broken)
                busy = false;
        }
    }
    async function databases() {
        const runtime = getRuntime(), result = [{ id: 'main', db: runtime.store.db }];
        for (const path of [p.main, p.workspaces])
            if (existsSync(path) && lstatSync(path).isSymbolicLink())
                throw new ApiError(409, 'DB 심볼릭 링크는 지원하지 않습니다.');
        await installBotStorage(runtime.store.db);
        const known = new Set((await (runtime.store.db.prepare("SELECT id FROM lms_workspaces WHERE id<>'default'")).all()).map(row => row.id));
        // Include archived and orphaned workspace files rather than silently losing them.
        if (existsSync(p.workspaces))
            for (const file of readdirSync(p.workspaces))
                if (file.endsWith('.db'))
                    known.add(file.slice(0, -3));
        try {
            for (const id of known) {
                if (!workspaceId.test(id) || ['main', 'default'].includes(id))
                    throw new ApiError(409, '지원하지 않는 워크스페이스 파일 이름입니다.');
                const file = join(p.workspaces, id + '.db');
                if (existsSync(file) && lstatSync(file).isSymbolicLink())
                    throw new ApiError(409, 'DB 심볼릭 링크는 지원하지 않습니다.');
                if (await (runtime.store.db.prepare('SELECT 1 FROM lms_workspaces WHERE id=?')).get(id)) {
                    const db = (await runtime.workspaces.open(id)).db;
                    await installBotStorage(db);
                    result.push({ id, db });
                }
                else {
                    const db = new DatabaseSync(file);
                    result.push({ id, db, owned: true });
                    await installBotStorage(db);
                }
            }
        }
        catch (error) {
            for (const source of result)
                if (source.owned)
                    source.db.close();
            throw error;
        }
        return result;
    }
    async function backup() {
        const sources = await databases();
        try {
            const payload = JSON.stringify({ createdAt: new Date().toISOString(), databases: await Promise.all(sources.map(async ({ db, id }) => await exportDatabase(db, id))) });
            const envelope = JSON.stringify({ format: 'ax-learningops-backup', version: 1, sha256: hash(payload), payload });
            if (Buffer.byteLength(envelope) > MAX_EXPANDED_BYTES)
                throw new ApiError(413, '백업 용량이 웹 관리 한도를 초과했습니다. 서버 백업 도구를 사용하세요.');
            const bytes = gzipSync(envelope);
            if (bytes.length > MAX_BACKUP_BYTES)
                throw new ApiError(413, '압축 백업은 최대 32MB까지 지원합니다.');
            const verified = await prepare(decodeBackup(bytes));
            remove(verified.directory);
            return bytes;
        }
        finally {
            for (const source of sources)
                if (source.owned)
                    source.db.close();
        }
    }
    function backups() {
        if (!existsSync(p.backups))
            return [];
        return readdirSync(p.backups).filter(name => /^\d{13}-[a-f0-9-]+\.axbackup$/.test(name)).sort().reverse().map(id => ({ id, createdAt: new Date(Number(id.slice(0, 13))).toISOString(), bytes: lstatSync(join(p.backups, id)).size }));
    }
    function download(id) {
        if (!backups().some(item => item.id === id))
            throw new ApiError(404, '백업 파일을 찾을 수 없습니다.');
        return readFileSync(join(p.backups, id));
    }
    async function prepare(data) {
        const directory = join(dirname(dbPath), '.ax-restore-' + randomUUID());
        mkdirSync(directory, { mode: 0o700 });
        const file = join(directory, basename(dbPath));
        let runtime;
        try {
            runtime = await createRuntime(file, { ...env, NODE_ENV: 'development', LEARNINGOPS_AUTH_GUILD_ID: '' });
            await installBotStorage(runtime.store.db);
            if (!data) {
                await runtime.store.db.prepare("INSERT OR IGNORE INTO lms_workspace_migrations VALUES('admin-data-reset-v1')").run();
            }
            else {
                const main = data.databases.find(entry => entry.id === 'main');
                await importDatabase(runtime.store.db, main);
                await safeRestoreState(runtime.store.db);
                const ids = (await runtime.store.db.prepare("SELECT id FROM lms_workspaces WHERE id<>'default'").all()).map(row => row.id);
                if (ids.some(id => !workspaceId.test(id) || id === 'main' || !data.databases.some(entry => entry.id === id)))
                    throw invalid();
                if (!await runtime.store.db.prepare("SELECT 1 FROM lms_users WHERE platform_role='admin'").get() && (env.ADMIN_PASSWORD || '').length < 16)
                    throw new ApiError(409, '관리자 계정이 없는 백업입니다. 서버의 최초 관리자 설정 키를 먼저 준비하세요.');
                for (const entry of data.databases.filter(entry => entry.id !== 'main')) {
                    const store = await createStore(join(file + '.workspaces', entry.id + '.db'), { workspaceId: entry.id });
                    try {
                        await installBotStorage(store.db);
                        await importDatabase(store.db, entry);
                        await safeRestoreState(store.db);
                        await integrity(store.db);
                        await checkpoint(store.db);
                    }
                    finally {
                        store.db.close();
                    }
                }
            }
            await integrity(runtime.store.db);
            await checkpoint(runtime.store.db);
            const summary = { createdAt: data?.createdAt, databases: data?.databases.length || 1,
                accounts: (await runtime.store.db.prepare('SELECT COUNT(*) AS n FROM lms_users').get()).n,
                workspaces: (await runtime.store.db.prepare('SELECT COUNT(*) AS n FROM lms_workspaces').get()).n };
            runtime.close();
            runtime = null;
            return { directory, file, summary };
        }
        catch (error) {
            runtime?.close();
            remove(directory);
            throw error;
        }
    }
    async function preview(bytes, actorId) {
        const data = decodeBackup(bytes), staged = await prepare(data);
        remove(staged.directory);
        upload = { id: randomUUID(), bytes, actorId, expiresAt: Date.now() + 10 * 60000 };
        return { token: upload.id, expiresAt: upload.expiresAt, ...staged.summary };
    }
    async function replace(kind, token, actorId) {
        if (kind === 'reset' && (env.ADMIN_PASSWORD || '').length < 16)
            throw new ApiError(409, '서버의 최초 관리자 설정 키(ADMIN_PASSWORD, 16자 이상)를 준비한 뒤 초기화하세요.');
        if (kind === 'restore' && (!upload || upload.id !== token || upload.actorId !== actorId || upload.expiresAt < Date.now()))
            throw new ApiError(409, '복구 파일을 다시 선택하고 검증하세요.');
        const staged = await prepare(kind === 'restore' ? decodeBackup(upload.bytes) : null);
        let closed = false, installed = false, backupId;
        try {
            const bytes = await backup();
            mkdirSync(p.backups, { recursive: true, mode: 0o700 });
            backupId = `${Date.now()}-${randomUUID()}.axbackup`;
            writeFileSync(join(p.backups, backupId), bytes, { mode: 0o600, flag: 'wx', flush: true });
            // Verify the on-disk safety copy before changing any active database.
            decodeBackup(readFileSync(join(p.backups, backupId)));
            mkdirSync(join(p.job, 'previous'), { recursive: true, mode: 0o700 });
            const journal = { state: 'installing', existed: { main: existsSync(p.main), workspaces: existsSync(p.workspaces) } };
            const saveJournal = () => {
                writeFileSync(join(p.job, 'journal.tmp'), JSON.stringify(journal), { mode: 0o600, flush: true });
                renameSync(join(p.job, 'journal.tmp'), join(p.job, 'journal.json'));
            };
            // Closing after draining asynchronous work also flushes WAL files.
            await closeRuntime();
            closed = true;
            saveJournal();
            for (const suffix of ['-wal', '-shm'])
                if (existsSync(p.main + suffix)) {
                    // A surviving WAL may belong to another writer. Refuse replacement.
                    if (suffix === '-wal' && lstatSync(p.main + suffix).size)
                        throw new ApiError(409, '다른 프로세스가 DB를 사용 중입니다. 종료 후 다시 시도하세요.');
                    remove(p.main + suffix);
                }
            if (journal.existed.main)
                renameSync(p.main, join(p.job, 'previous', 'main.db'));
            if (journal.existed.workspaces)
                renameSync(p.workspaces, join(p.job, 'previous', 'workspaces'));
            renameSync(staged.file, p.main);
            if (existsSync(staged.file + '.workspaces'))
                renameSync(staged.file + '.workspaces', p.workspaces);
            await openRuntime();
            installed = true;
            journal.state = 'committed';
            saveJournal();
            remove(p.job);
            upload = null;
            return { ok: true, backupId, action: kind, requiresLogin: true };
        }
        catch (error) {
            if (installed)
                await closeRuntime();
            if (closed) {
                try {
                    recoverDataMaintenance(dbPath);
                    await openRuntime();
                }
                catch {
                    broken = true;
                    throw new ApiError(503, '데이터 복구가 중단되었습니다. 서버를 재시작하여 자동 복원을 완료하세요.');
                }
            }
            throw error;
        }
        finally {
            remove(staged.directory);
        }
    }
    return { track, exclusive, backup, preview, replace, backups, download,
        get busy() { return busy || broken; },
        get broken() { return broken; },
        status() { return { maxBackupBytes: MAX_BACKUP_BYTES, resetEnabled: (env.ADMIN_PASSWORD || '').length >= 16, backups: backups() }; } };
}
