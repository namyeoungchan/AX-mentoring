export async function installMentoringFeedback(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_mentoring_feedback_control(id INTEGER PRIMARY KEY CHECK(id=1),activated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lms_mentoring_feedback_requests(
      id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('mentor','mentee')),
      discord_id TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(booking_id,role));
    CREATE TABLE IF NOT EXISTS lms_mentoring_feedback_responses(
      event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES lms_mentoring_feedback_requests(id),
      content TEXT NOT NULL,submitted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS lms_mentoring_feedback_response_request ON lms_mentoring_feedback_responses(request_id,submitted_at);`);
    // Enabling the feature must not send requests for all historical appointments.
    await db.prepare('INSERT OR IGNORE INTO lms_mentoring_feedback_control VALUES(1,?)').run(Date.now());
}
