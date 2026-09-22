import { z } from 'zod';
import { ApiError } from './store.mjs';
import { staffRoles } from '../shared/staff-import.mjs';

const batch = z.object({ rows: z.array(z.object({ row: z.number().int().min(2).max(501), category: z.string().max(30), name: z.string().trim().max(100), username: z.string().trim().toLowerCase().max(100), teamIds: z.array(z.string().max(100)).max(50) }).strict()).min(1).max(50) }).strict();
export async function previewStaffAccounts(db, workspaces, id, body, actor) {
  await workspaces.requireRole(id, actor, ['admin']);
  if (actor.mustChangePassword || actor.mustCompleteProfile) throw new ApiError(403, '먼저 초기 계정 설정을 완료하세요.');
  if ((await workspaces.metadata(id)).archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스에는 초대할 수 없습니다.');
  const { rows } = batch.parse(body), result = [];
  const teams = new Set((await workspaces.snapshot(id)).teams.map(team => team.id));
  for (const row of rows) {
    const mapping = Object.hasOwn(staffRoles, row.category) ? staffRoles[row.category] : null;
    const errors = [];
    if (!mapping) errors.push('구분은 PM·강의·기술멘토·자문/운영 중 하나여야 합니다.');
    if (!row.name || row.name.length > 50) errors.push('이름은 1~50자로 입력하세요.');
    if (!/^[a-z0-9][a-z0-9_.-]{3,31}$/.test(row.username)) errors.push('아이디는 영문 소문자·숫자·_.- 조합 4~32자로 입력하세요.');
    if (rows.filter(r => r.username === row.username).length > 1 || rows.filter(r => r.row === row.row).length > 1) errors.push('파일 안에 중복된 아이디 또는 행이 있습니다.');
    if (mapping?.role === 'admin' && actor.role !== 'admin') errors.push('자문/운영 계정은 총관리자만 발급할 수 있습니다.');
    if (await db.prepare('SELECT 1 FROM lms_users WHERE username=?').get(row.username)) errors.push('이미 사용 중인 아이디입니다. 기존 계정 초대를 이용하세요.');
    if (mapping?.mentorType === 'group') {
      if (!row.teamIds.length) errors.push('조 담당 멘토는 담당 조를 하나 이상 선택하세요.');
      if (new Set(row.teamIds).size !== row.teamIds.length || row.teamIds.some(team => !teams.has(team))) errors.push('이 워크스페이스의 조를 선택하세요.');
    }
    result.push({ ...row, role: mapping?.role, mentorType: mapping?.mentorType, label: mapping?.label, errors });
  }
  return { rows: result, valid: result.every(row => !row.errors.length) };
}
export async function issueStaffAccounts(db, auth, workspaces, id, body, actor) {
  const preview = await previewStaffAccounts(db, workspaces, id, body, actor);
  if (!preview.valid) throw new ApiError(422, '발급할 명단에 오류가 있습니다. 다시 검증해 주세요.');
  const results = [];
  for (const row of preview.rows) {
    try {
      // Each account and its invitation commit together. Never reset existing users.
      const invitation = await auth.createInvitationAccount({ username: row.username, name: row.name }, actor,
        username => workspaces.invite(id, { username, role: row.role, mentorType: row.mentorType, teamIds: row.mentorType === 'group' ? row.teamIds : [] }, actor),
        () => workspaces.requireRole(id, actor, ['admin']));
      results.push({ row: row.row, ...invitation });
    } catch (error) {
      results.push({ row: row.row, username: row.username, error: error instanceof ApiError ? error.message : '계정을 발급하지 못했습니다. 명단을 다시 검증해 주세요.' });
    }
  }
  return { results };
}
