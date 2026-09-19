import { z } from 'zod';

export async function issueMentorAccount(auth, workspaces, workspaceId, body, actor) {
    const input = z.object({ username: z.string(), name: z.string(), mentorType: z.enum(['main', 'group']).default('main'), teamIds: z.array(z.string()).max(50).default([]) }).strict().parse(body);
    return auth.createInvitationAccount({ username: input.username, name: input.name }, actor,
        username => workspaces.invite(workspaceId, { username, role: 'instructor', mentorType: input.mentorType, teamIds: input.teamIds }, actor),
        () => workspaces.requireRole(workspaceId, actor, ['admin']));
}
