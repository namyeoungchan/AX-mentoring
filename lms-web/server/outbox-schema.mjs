export async function installOutbox(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_outbox (
    id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,source_id TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',channel_id TEXT NOT NULL DEFAULT '',payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    claim TEXT,lease_until INTEGER,first_attempt_at INTEGER,message_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER);
    CREATE TABLE IF NOT EXISTS lms_outbox_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,outbox_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS lms_notification_control(id INTEGER PRIMARY KEY CHECK(id=1),importing INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO lms_notification_control VALUES(1,0);
    CREATE TABLE IF NOT EXISTS lms_submission_targets(submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,target_key TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS lms_submission_alert AFTER INSERT ON submissions WHEN (SELECT importing FROM lms_notification_control WHERE id=1)=0 BEGIN
      INSERT INTO lms_outbox(id,event_key,kind,source_id,payload,actor,created_at)
      VALUES(lower(hex(randomblob(16))),'submission:' || NEW.id,'submission',CAST(NEW.assignment_id AS TEXT),
        json_object('title','새 과제 제출','description',substr((SELECT title FROM assignments WHERE id=NEW.assignment_id),1,200) || char(10) || '제출자: ' || substr(NEW.user_name,1,200) || char(10) || '팀: ' || substr(NEW.team,1,100) || char(10) || '제출 시각 (UTC): ' || NEW.submitted_at,'assignmentId',NEW.assignment_id,'submissionId',NEW.id), 'submission',unixepoch()*1000);
      INSERT OR IGNORE INTO lms_submission_targets(submission_id,target_key)
        SELECT NEW.id, CASE WHEN a.type='individual' THEN 'user:' || NEW.user_id ELSE 'team:' || t.id END
        FROM assignments a LEFT JOIN lms_assignment_courses c ON c.assignment_id=a.id
        LEFT JOIN lms_records t ON t.kind='teams' AND json_extract(t.data,'$.courseId')=c.course_id AND json_extract(t.data,'$.name')=NEW.team
        WHERE a.id=NEW.assignment_id AND (a.type='individual' OR t.id IS NOT NULL);
    END;`);
}
