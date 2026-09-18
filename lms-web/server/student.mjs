import { asyncFilter } from './async-collections.mjs';
// Callers must supply verification for this workspace, not the global account flag.
export async function studentLearning(db, user, verified = false) {
    if (!verified || !/^\d{17,20}$/.test(user.discordId || ''))
        return { enrollment: null, courses: [], attendance: [], scores: [], assignments: [] };
    const records = async (kind) => (await (db.prepare('SELECT data FROM lms_records WHERE kind=?')).all(kind)).map(row => JSON.parse(row.data));
    const learner = (await records('learners')).find(row => row.discordId === user.discordId);
    const enrolled = learner && ['정상', '수료'].includes(learner.status);
    const course = enrolled ? (await records('courses')).find(row => row.id === learner.courseId) : null;
    const confirmed = async (row) => {
        const round = await (db.prepare('SELECT state FROM lms_attendance_rounds WHERE course_id=? AND date=? AND period=?')).get(row.courseId, row.date, row.period);
        return !round || round.state === '마감';
    };
    return {
        enrollment: learner ? { name: learner.name, status: learner.status, team: learner.team } : null,
        courses: course ? [{ id: course.id, title: course.title, description: course.description, status: course.status, startDate: course.startDate, endDate: course.endDate }] : [],
        attendance: course ? (await asyncFilter((await records('attendance')), async (row) => row.studentId === learner.id && row.courseId === course.id && await confirmed(row))).map(row => ({ id: row.id, date: row.date, period: row.period, status: row.status })) : [],
        scores: course ? (await records('scores')).filter(row => row.studentId === learner.id && row.courseId === course.id).map(row => ({ id: row.id, item: row.item, score: row.score, maximum: row.maximum })) : [],
        assignments: course ? await (db.prepare(`SELECT a.id,a.title,a.due_date AS dueDate,a.is_active AS active FROM assignments a
      JOIN lms_assignment_courses c ON c.assignment_id=a.id WHERE c.course_id=? ORDER BY a.id DESC LIMIT 100`)).all(course.id) : [],
    };
}
