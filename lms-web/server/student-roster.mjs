import { z } from 'zod';
import { ApiError } from './store.mjs';
import { normalizeRoster } from '../shared/student-roster.mjs';

export const ROSTER_INITIAL_PASSWORD = 'bdaxuser1!';
const busy = new Set();
const inputSchema = z.object({ rows: z.array(z.unknown()).min(1).max(500), courseId: z.string().max(100).default(''), title: z.string().trim().min(1).max(100).default('천안형 인재육성사업'), revision: z.string().optional() }).strict();

export function createStudentRoster(db, workspaces, auth, admissions, staff) {
  async function preview(id, body, actor) {
    await workspaces.requireRole(id, actor, ['admin']);
    const metadata = await workspaces.metadata(id);
    if (metadata.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
    const input = inputSchema.parse(body);
    let roster;
    try { roster = normalizeRoster(input.rows); } catch (error) { throw new ApiError(422, error.message); }
    const groups = await staff.groups(id), courseId = input.courseId || groups.courseId;
    if (courseId && !groups.courses.some(c => c.id === courseId)) throw new ApiError(422, '이 워크스페이스의 과정을 선택하세요.');
    const existing = (await admissions.studentAccounts(id, actor)).accounts;
    const rows = [];
    for (const row of roster.participants) {
      const account = await db.prepare('SELECT id FROM lms_users WHERE username=?').get(row.username);
      const assigned = existing.find(a => a.id === account?.id), team = groups.teams.find(t => t.id === assigned?.teamId);
      const same = assigned && assigned.name === row.name && assigned.courseId === courseId && team?.name === row.team && ['approved','joined'].includes(assigned.state);
      rows.push({ ...row, action: !account ? 'create' : same ? 'existing' : 'conflict', ...(!account || same ? {} : { error: '이미 사용 중이거나 다른 이름·과정·조로 배정된 아이디입니다.' }) });
    }
    return { courseId, revision: groups.revision, rows, failed: roster.failed, excluded: roster.excluded, teams: roster.teams.map(name => ({ name, count: rows.filter(r => r.team === name).length })), guildReady: metadata.guildIds.length === 1 };
  }
  async function apply(id, body, actor, accounts = false) {
    if (busy.has(id)) throw new ApiError(409, '이 워크스페이스의 명단을 처리 중입니다. 완료 후 다시 확인하세요.');
    busy.add(id);
    try {
      const plan = await preview(id, body, actor), input = inputSchema.parse(body);
      if (!input.revision || plan.revision !== input.revision) throw new ApiError(409, '운영 정보가 변경됐습니다. 명단을 다시 확인하세요.');
      if (accounts && !plan.guildReady) throw new ApiError(422, '먼저 Discord 서버를 연결하세요. 조 준비는 서버 연결 전에도 가능합니다.');
      if (!plan.teams.length) throw new ApiError(422, '적용할 수 있는 참여자가 없습니다.');
      const groups = await staff.setupGroups(id, { count: plan.teams.length, names: plan.teams.map(t => t.name), courseId: plan.courseId, title: input.title, revision: plan.revision }, actor);
      const results = [...plan.failed.map(row => ({ ...row, result: 'failed' })), ...(!accounts ? plan.rows.map(row => ({ ...row, result: 'prepared' })) : [])];
      if (accounts) for (const row of plan.rows) {
        if (row.action === 'conflict') { results.push({ ...row, result: 'failed' }); continue; }
        if (row.action === 'existing') { results.push({ ...row, result: 'existing' }); continue; }
        const team = groups.teams.find(t => t.courseId === groups.courseId && t.name === row.team);
        try {
          const authorize = () => admissions.validateStudentIssue(id, team.id, actor);
          await auth.createStudentAccount({ username: row.username, name: row.name }, actor, authorize, async user => {
            const result = await admissions.assignStudent(id, team.id, user, actor);
            // Profile is in the registry transaction with account and admission.
            await db.prepare('INSERT INTO lms_runtime_state VALUES(?,?,?,?) ON CONFLICT(guild_id,kind,record_key) DO UPDATE SET data=excluded.data').run(`workspace:${id}`, 'student-profile', user.id, JSON.stringify({ name: row.name, email: row.email, phone: row.phone, school: row.school, department: row.department }));
            return result;
          }, { initialPassword: ROSTER_INITIAL_PASSWORD });
          results.push({ ...row, result: 'created' });
        } catch (error) {
          // Each account and its admission commit together. A retry skips completed rows.
          results.push({ ...row, result: 'failed', error: error instanceof ApiError ? error.message : '발급하지 못했습니다. 명단을 다시 확인해 재시도하세요.' });
        }
      }
      return { courseId: groups.courseId, revision: groups.revision, teams: plan.teams, excluded: plan.excluded.length, results };
    } finally { busy.delete(id); }
  }
  return { preview, apply };
}
