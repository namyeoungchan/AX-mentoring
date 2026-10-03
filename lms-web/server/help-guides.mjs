import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './store.mjs';
import { HELP_GUIDES, HELP_ROLES } from './help-catalog.mjs';

export const MAX_GUIDE_BYTES = 5 * 1024 * 1024;
const uploadInput = z.object({ filename: z.string().trim().min(1).max(160).regex(/\.pdf$/i), base64: z.string().min(1).max(Math.ceil(MAX_GUIDE_BYTES / 3) * 4), revision: z.string().nullable() }).strict();
export function createHelpGuides(workspaces, { assetRoot = join(dirname(fileURLToPath(import.meta.url)), 'help-assets') } = {}) {
  async function context(id, user) {
    const meta = await workspaces.requireAccess(id, user);
    const role = meta.role === 'admin' ? 'admin' : meta.role === 'student' ? 'student' : (await workspaces.mentorScope(id, user.id)).mentorType;
    if (!HELP_ROLES[role]) throw new ApiError(403, '도움말을 볼 권한이 없습니다.');
    return { role, meta, db: (await workspaces.open(id)).db };
  }
  function guide(key) {
    const result = HELP_GUIDES.find(item => item.id === key);
    if (!result) throw new ApiError(404, '가이드를 찾을 수 없습니다.');
    return result;
  }
  async function allowed(id, key, user) {
    const ctx = await context(id, user), item = guide(key);
    if (item.role !== ctx.role) throw new ApiError(403, '현재 역할에 해당하는 가이드만 볼 수 있습니다.');
    return { ...ctx, item };
  }
  async function metadata(db) {
    const rows = await db.prepare("SELECT id,json_extract(data,'$.filename') AS filename,json_extract(data,'$.revision') AS revision,json_extract(data,'$.updatedAt') AS updatedAt FROM lms_records WHERE kind='helpDocument'").all();
    return rows.map(row => ({ ...row, updatedAt: Number(row.updatedAt) }));
  }
  async function list(id, user) {
    const { role, meta, db } = await context(id, user), files = await metadata(db);
    return { role, roleLabel: HELP_ROLES[role], canManage: role === 'admin' && meta.archivedAt === null,
      guides: HELP_GUIDES.filter(item => item.role === role).map(item => ({ ...item, document: files.find(f => f.id === item.id) || { filename: `${item.id}.pdf`, revision: null, updatedAt: null } })) };
  }
  async function management(id, user) {
    await workspaces.requireRole(id, user, ['admin']);
    const { db, meta } = await context(id, user), files = await metadata(db);
    return { roles: HELP_ROLES, readOnly: meta.archivedAt !== null,
      // Registration metadata only; another role's contents and files stay private.
      guides: HELP_GUIDES.map(({ id, role, title, category }) => ({ id, role, title, category, document: files.find(f => f.id === id) || { filename: `${id}.pdf`, revision: null, updatedAt: null } })) };
  }
  async function asset(id, key, type, user) {
    const { db, item } = await allowed(id, key, user);
    if (!['pdf', 'image'].includes(type)) throw new ApiError(404, '지원하지 않는 파일입니다.');
    if (type === 'pdf') {
      const row = await db.prepare("SELECT data FROM lms_records WHERE kind='helpDocument' AND id=?").get(item.id);
      if (row) return { bytes: Buffer.from(JSON.parse(row.data).base64, 'base64'), mime: 'application/pdf' };
    }
    try { return { bytes: await readFile(join(assetRoot, `${item.id}.${type === 'pdf' ? 'pdf' : 'jpg'}`)), mime: type === 'pdf' ? 'application/pdf' : 'image/jpeg' }; }
    catch (error) { if (error.code === 'ENOENT') throw new ApiError(503, '가이드 파일을 준비 중입니다. 잠시 후 다시 확인하세요.'); throw error; }
  }
  async function replace(id, key, raw, user, remove = false) {
    await workspaces.requireRole(id, user, ['admin']);
    const { db, meta } = await context(id, user), item = guide(key);
    if (meta.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스의 가이드는 변경할 수 없습니다.');
    const input = remove ? z.object({ revision: z.string().nullable() }).strict().parse(raw) : uploadInput.parse(raw);
    if (!remove) {
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.length > MAX_GUIDE_BYTES || bytes.toString('base64') !== input.base64 || !/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString()) || !bytes.subarray(-1024).includes(Buffer.from('%%EOF')))
        throw new ApiError(422, '5MB 이하의 올바른 PDF 파일을 선택하세요.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
      const previous = await db.prepare("SELECT data FROM lms_records WHERE kind='helpDocument' AND id=?").get(item.id);
      const before = previous ? JSON.parse(previous.data) : null;
      if ((before?.revision || null) !== input.revision) throw new ApiError(409, '다른 관리자가 PDF를 변경했습니다. 목록을 새로고침한 뒤 다시 시도하세요.');
      const after = remove ? null : { ...input, filename: input.filename.replace(/[\r\n\\/]/g, '_'), revision: randomUUID(), updatedAt: Date.now() };
      if (remove) await db.prepare("DELETE FROM lms_records WHERE kind='helpDocument' AND id=?").run(item.id);
      else await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('helpDocument',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(item.id, JSON.stringify(after));
      const summary = value => value && { filename: value.filename, revision: value.revision, updatedAt: value.updatedAt };
      await db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(user.username, remove ? 'help.pdf.reset' : 'help.pdf.upload', item.id, JSON.stringify(summary(before)), JSON.stringify(summary(after)));
      await db.exec('COMMIT');
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
    return management(id, user);
  }
  return { list, management, asset, upload: (id, key, raw, user) => replace(id, key, raw, user), reset: (id, key, raw, user) => replace(id, key, raw, user, true) };
}
