import { createStore } from './store.mjs';
import { postgresConnection } from './postgres/database.mjs';
import { createRenderSync } from './render-sync.mjs';
import { createAuth } from './auth.mjs';
import { createProvision } from './provision.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { createAdmissions } from './admissions.mjs';
import { createOnboarding } from './onboarding.mjs';
import { createBotStorage } from './bot-storage.mjs';
import { createStaffFlow } from './staff-flow.mjs';
import { createOutbox } from './outbox.mjs';
import { createAssignmentAlerts } from './assignment-alerts.mjs';
import { createTeamOperations } from './team-operations.mjs';
import { createAttendance } from './attendance.mjs';
import { createAttendanceCodes } from './attendance-codes.mjs';
import { createStudentRoster } from './student-roster.mjs';
// All database handles belong to one generation and are replaced together.
export async function createRuntime(dbPath, env = process.env) {
    const store = await createStore(dbPath, { postgres: postgresConnection(env) });
    let workspaces;
    try {
        const renderSync = await createRenderSync(store.db, { token: env.LEARNINGOPS_SYNC_TOKEN || '', sourceId: env.LEARNINGOPS_SOURCE_ID || 'asan-ax' });
        const auth = await createAuth(store.db, { adminPassword: env.ADMIN_PASSWORD || '', allowLegacyAdmin: env.NODE_ENV !== 'production' && env.ALLOW_LEGACY_ADMIN === 'true', botToken: env.LEARNINGOPS_AUTH_TOKEN || '', guildId: env.LEARNINGOPS_AUTH_GUILD_ID || '', guildAllowed: async (id) => id === env.LEARNINGOPS_AUTH_GUILD_ID || Boolean(await store.db.prepare('SELECT 1 FROM lms_workspace_guilds WHERE guild_id=?').get(id)) });
        if (env.NODE_ENV === 'production' && !await store.db.prepare("SELECT 1 FROM lms_users WHERE platform_role='admin'").get() && !await auth.setupEnabled())
            throw new Error('최초 관리자 등록을 위해 16자 이상의 ADMIN_PASSWORD 설정 키가 필요합니다.');
        const provision = await createProvision(store.db, { token: env.LEARNINGOPS_PROVISION_TOKEN || '' });
        workspaces = await createWorkspaces({ store, dbPath, provision, syncToken: env.LEARNINGOPS_SYNC_TOKEN || '', sourceId: env.LEARNINGOPS_SOURCE_ID || 'asan-ax', authGuildId: env.LEARNINGOPS_AUTH_GUILD_ID || '' });
        const admissions = await createAdmissions(store.db, workspaces, { token: env.LEARNINGOPS_PROVISION_TOKEN || '' });
        const onboarding = await createOnboarding(store.db, workspaces, provision);
        const staff = await createStaffFlow(store.db, workspaces, onboarding, admissions);
        const studentRoster = createStudentRoster(store.db, workspaces, auth, admissions, staff);
        const teamOperations = createTeamOperations(workspaces, onboarding);
        const botStorage = await createBotStorage(store.db, workspaces, onboarding, { env });
        const assignmentAlerts = createAssignmentAlerts(store.db, workspaces);
        const outbox = createOutbox(store.db, workspaces, { prepare: assignmentAlerts.prepare });
        const attendance = createAttendance(workspaces, { outbox });
        const attendanceCodes = createAttendanceCodes(store.db, workspaces, attendance, { enabled: auth.enabled });
        return { store, renderSync, auth, provision, workspaces, admissions, onboarding, staff, studentRoster, teamOperations, botStorage, assignmentAlerts, outbox, attendance, attendanceCodes,
            close() { botStorage.close(); workspaces.close(); store.db.close(); } };
    }
    catch (error) {
        workspaces?.close();
        store.db.close();
        throw error;
    }
}
