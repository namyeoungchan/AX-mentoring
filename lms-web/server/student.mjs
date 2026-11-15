import { asyncFilter } from './async-collections.mjs';
// Video access needs enrollment only, without loading attendance, scores or assignments.
// Callers must supply verification for this workspace, not the global account flag.
export async function studentEnrollment(db, user, verified = false) {
    if (!verified || !/^\d{17,20}$/.test(user.discordId || ''))
        return { learner: null, course: null };
    const row = await db.prepare("SELECT data FROM lms_records WHERE kind='learners' AND json_extract(data,'$.discordId')=? LIMIT 1").get(user.discordId);
    const learner = row ? JSON.parse(row.data) : null;
    const enrolled = learner && ['정상', '수료'].includes(learner.status);
    const courseRow = enrolled ? await db.prepare("SELECT data FROM lms_records WHERE kind='courses' AND id=?").get(learner.courseId) : null;
    return { learner, course: courseRow ? JSON.parse(courseRow.data) : null };
}
export async function studentLearning(db, user, verified = false, guildId = '') {
    const { learner, course } = await studentEnrollment(db, user, verified);
    const records = async (kind) => (await (db.prepare('SELECT data FROM lms_records WHERE kind=?')).all(kind)).map(row => JSON.parse(row.data));
    const confirmed = async (row) => {
        const round = await (db.prepare('SELECT state FROM lms_attendance_rounds WHERE course_id=? AND date=? AND period=?')).get(row.courseId, row.date, row.period);
        return !round || round.state === '마감';
    };
    return {
        enrollment: learner ? { name: learner.name, status: learner.status, team: learner.team } : null,
        courses: course ? [{ id: course.id, title: course.title, description: course.description, status: course.status, startDate: course.startDate, endDate: course.endDate }] : [],
        attendance: course ? (await asyncFilter((await records('attendance')), async (row) => row.studentId === learner.id && row.courseId === course.id && await confirmed(row))).map(row => ({ id: row.id, date: row.date, period: row.period, status: row.status })) : [],
        scores: course ? (await records('scores')).filter(row => row.studentId === learner.id && row.courseId === course.id).map(row => ({ id: row.id, item: row.item, score: row.score, maximum: row.maximum })) : [],
        assignments: course ? await studentAssignments(db, user, learner, course) : [],
        assignmentDiscordUrl: course ? await assignmentDiscordUrl(db, guildId) : '',
    };
}

async function assignmentDiscordUrl(db, guildId) {
    if (!/^\d{17,20}$/.test(guildId)) return '';
    const configured = await db.prepare("SELECT name FROM sqlite_master WHERE name='lms_bot_settings' AND type='table'").get();
    const settings = configured ? await db.prepare('SELECT data FROM lms_bot_settings WHERE guild_id=?').get(guildId) : null;
    const channel = settings ? JSON.parse(settings.data).channels?.ASSIGNMENT_SUBMIT_CHANNEL_ID : '';
    return `https://discord.com/channels/${guildId}${/^\d{17,20}$/.test(channel || '') ? '/' + channel : ''}`;
}

async function studentAssignments(db, user, learner, course) {
    const assignments = await db.prepare(`SELECT a.id,a.week,a.title,a.description,a.fields,a.type,a.due_date AS dueDate,a.is_active AS active
        FROM assignments a JOIN lms_assignment_courses c ON c.assignment_id=a.id WHERE c.course_id=? ORDER BY a.id DESC`).all(course.id);
    const teams = (await db.prepare("SELECT id,data FROM lms_records WHERE kind='teams'").all()).filter(row => {
        const team = JSON.parse(row.data);
        return team.courseId === course.id && team.name === learner.team;
    });
    const team = teams.length === 1 ? teams[0] : null;
    const own = new Map((await db.prepare(`SELECT s.assignment_id,s.content,s.link,s.submitted_at AS submittedAt,s.team
        FROM submissions s JOIN lms_assignment_courses c ON c.assignment_id=s.assignment_id
        WHERE c.course_id=? AND s.user_id=?`).all(course.id, user.discordId)).map(({ assignment_id, ...submission }) => [assignment_id, submission]));
    // Only a completion flag crosses the student boundary for teammates.
    // Prefer frozen team IDs; use names only for unmapped legacy submissions.
    const teamAssignments = new Set(team ? (await db.prepare(`SELECT DISTINCT s.assignment_id FROM submissions s
        JOIN lms_assignment_courses c ON c.assignment_id=s.assignment_id
        LEFT JOIN lms_submission_targets t ON t.submission_id=s.id WHERE c.course_id=?
        AND (t.target_key=? OR (t.submission_id IS NULL AND s.team=?))`).all(course.id, `team:${team.id}`, learner.team)).map(row => row.assignment_id) : []);
    return assignments.map(assignment => {
        let fields = [];
        try { const parsed = JSON.parse(assignment.fields); if (Array.isArray(parsed)) fields = parsed.filter(value => typeof value === 'string'); } catch { /* Legacy fields may be empty. */ }
        return { ...assignment, fields, courseTitle: course.title, teamSubmitted: assignment.type === 'team' && teamAssignments.has(assignment.id), submission: own.get(assignment.id) || null };
    });
}
