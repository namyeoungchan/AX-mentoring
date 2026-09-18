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
export async function studentLearning(db, user, verified = false) {
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
        assignments: course ? await (db.prepare(`SELECT a.id,a.title,a.due_date AS dueDate,a.is_active AS active FROM assignments a
      JOIN lms_assignment_courses c ON c.assignment_id=a.id WHERE c.course_id=? ORDER BY a.id DESC LIMIT 100`)).all(course.id) : [],
    };
}
