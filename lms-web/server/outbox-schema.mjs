export function installOutbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lms_outbox (
    id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,source_id TEXT NOT NULL,
    guild_id TEXT NOT NULL DEFAULT '',channel_id TEXT NOT NULL DEFAULT '',payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    claim TEXT,lease_until INTEGER,first_attempt_at INTEGER,message_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER);
    CREATE TABLE IF NOT EXISTS lms_outbox_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,outbox_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,created_at INTEGER NOT NULL);`)
}
