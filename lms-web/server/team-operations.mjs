import { z } from 'zod';
import { ApiError } from './store.mjs';
export function createTeamOperations(workspaces, onboarding) {
    async function read(id, user) {
        await workspaces.requireRole(id, user, ['admin', 'instructor']);
        const data = await workspaces.role(id, user) === 'admin' ? await workspaces.snapshot(id) : await workspaces.teaching(id, user);
        // Teaching intentionally strips Discord IDs; restore only internally for status lookup.
        const all = await workspaces.snapshot(id);
        const states = await onboarding.memberStates(id, all.learners.filter(l => data.learners.some(row => row.id === l.id)));
        return { revision: data.revision, courses: data.courses, teams: data.teams, learners: states.map(({ email: _email, discordId: _discordId, ...row }) => row),
            history: all.logs.filter(log => log.text.includes('learners.') && (() => {
                try {
                    return data.learners.some(l => l.id === JSON.parse(log.after || 'null')?.id);
                }
                catch {
                    return false;
                }
            })()).map(log => ({ ...log, before: JSON.parse(log.before || 'null')?.team || '', after: JSON.parse(log.after).team, studentId: JSON.parse(log.after).id })) };
    }
    async function save(id, body, user) {
        const input = z.object({ revision: z.string().min(1), learnerIds: z.array(z.string().min(1)).min(1).max(100), teamId: z.string().min(1) }).strict().parse(body);
        const data = await read(id, user);
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        const team = data.teams.find(t => t.id === input.teamId);
        if (!team || new Set(input.learnerIds).size !== input.learnerIds.length)
            throw new ApiError(422, '담당 팀과 중복 없는 명단을 선택하세요.');
        if (input.learnerIds.some(key => !data.learners.some(l => l.id === key && l.courseId === team.courseId && l.status === '정상')))
            throw new ApiError(403, '담당 과정의 활성 수강생만 배정할 수 있습니다.');
        const all = await workspaces.snapshot(id);
        await workspaces.mutate(id, { revision: input.revision, changes: all.learners.filter(l => input.learnerIds.includes(l.id)).map(l => ({ kind: 'learners', value: { ...l, team: team.name } })) }, user.username || user.id);
        return await read(id, user);
    }
    async function retry(id, body, user) {
        const input = z.object({ learnerIds: z.array(z.string()).min(1).max(100) }).strict().parse(body);
        const data = await read(id, user);
        if ((await workspaces.metadata(id)).archivedAt !== null)
            throw new ApiError(409, '보관된 워크스페이스입니다.');
        if (input.learnerIds.some(key => !data.learners.some(l => l.id === key)))
            throw new ApiError(403, '담당 수강생이 아닙니다.');
        await onboarding.retryMembers(id, (await workspaces.snapshot(id)).learners.filter(l => input.learnerIds.includes(l.id)), user.username || user.id);
        return await read(id, user);
    }
    return { read, save, retry };
}
