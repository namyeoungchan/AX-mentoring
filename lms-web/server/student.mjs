// Ownership is resolved from the verified Discord ID, never from client IDs or names.
export function studentLearning(db, user) {
  const records = kind => db.prepare('SELECT data FROM lms_records WHERE kind=?').all(kind).map(row => JSON.parse(row.data))
  const learner = records('learners').find(row => row.discordId === user.discordId)
  const enrolled = learner && ['정상', '수료'].includes(learner.status)
  const course = enrolled ? records('courses').find(row => row.id === learner.courseId) : null
  return {
    enrollment: learner ? { name: learner.name, status: learner.status, team: learner.team } : null,
    courses: course ? [{ id: course.id, title: course.title, description: course.description, status: course.status, startDate: course.startDate, endDate: course.endDate }] : [],
    attendance: course ? records('attendance').filter(row => row.studentId === learner.id && row.courseId === course.id).map(row => ({ id: row.id, date: row.date, period: row.period, status: row.status })) : [],
    scores: course ? records('scores').filter(row => row.studentId === learner.id && row.courseId === course.id).map(row => ({ id: row.id, item: row.item, score: row.score, maximum: row.maximum })) : [],
    assignments: course ? db.prepare(`SELECT a.id,a.title,a.due_date AS dueDate,a.is_active AS active FROM assignments a
      JOIN lms_assignment_courses c ON c.assignment_id=a.id WHERE c.course_id=? ORDER BY a.id DESC LIMIT 100`).all(course.id) : [],
  }
}
