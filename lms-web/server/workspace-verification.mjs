// Discord ownership is global; permission to use it is verified separately in each workspace.
export function initializeVerification(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS lms_workspace_verifications (
    workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL, verified_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,user_id,guild_id)
  )`)
}

export function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

export function workspaceForGuild(db, guildId) {
  if (!tableExists(db, 'lms_workspace_guilds')) return null
  return db.prepare('SELECT workspace_id FROM lms_workspace_guilds WHERE guild_id=?').get(guildId)?.workspace_id || null
}

export function workspaceVerified(db, workspaceId, userId, guildId) {
  return Boolean(db.prepare(`SELECT 1 FROM lms_workspace_verifications v
    JOIN lms_users u ON u.id=v.user_id AND u.discord_id=v.discord_id
    JOIN lms_workspace_guilds g ON g.workspace_id=v.workspace_id AND g.guild_id=v.guild_id
    WHERE v.workspace_id=? AND v.user_id=? AND (? IS NULL OR v.guild_id=?)`)
    .get(workspaceId, userId, guildId || null, guildId || null))
}

// Run once after legacy workspace bindings and memberships have been initialized.
// Never infer verification from a roster entry or from membership alone.
export function migrateVerification(db) {
  initializeVerification(db)
  if (db.prepare("SELECT 1 FROM lms_workspace_migrations WHERE name='verification-v1'").get()) return
  db.prepare(`INSERT OR IGNORE INTO lms_workspace_verifications
    SELECT g.workspace_id,u.id,g.guild_id,u.discord_id,u.verified_at
    FROM lms_users u JOIN lms_workspace_guilds g ON g.guild_id=u.guild_id
    JOIN lms_workspace_members m ON m.workspace_id=g.workspace_id AND m.user_id=u.id
    WHERE u.verified_at IS NOT NULL AND length(u.discord_id) BETWEEN 17 AND 20
      AND u.discord_id NOT GLOB '*[^0-9]*'`).run()
  if (tableExists(db, 'lms_staff_connections')) db.prepare(`INSERT OR IGNORE INTO lms_workspace_verifications
    SELECT c.workspace_id,u.id,g.guild_id,u.discord_id,u.verified_at
    FROM lms_staff_connections c JOIN lms_users u ON u.id=c.user_id AND u.discord_id=c.discord_id
    JOIN lms_workspace_guilds g ON g.workspace_id=c.workspace_id
    JOIN lms_workspace_members m ON m.workspace_id=c.workspace_id AND m.user_id=c.user_id
    WHERE u.verified_at IS NOT NULL AND length(u.discord_id) BETWEEN 17 AND 20
      AND u.discord_id NOT GLOB '*[^0-9]*'`).run()
  if (tableExists(db, 'lms_admissions')) db.prepare(`INSERT OR IGNORE INTO lms_workspace_verifications
    SELECT a.workspace_id,u.id,g.guild_id,u.discord_id,u.verified_at
    FROM lms_admissions a JOIN lms_users u ON u.id=a.user_id
    JOIN lms_workspace_guilds g ON g.workspace_id=a.workspace_id AND g.guild_id=a.guild_id
    WHERE a.state='joined' AND u.verified_at IS NOT NULL
      AND length(u.discord_id) BETWEEN 17 AND 20 AND u.discord_id NOT GLOB '*[^0-9]*'`).run()
  // Old pending codes have no explicit workspace binding; require a fresh code.
  db.prepare('UPDATE lms_registrations SET expires_at=0 WHERE workspace_id IS NULL AND verified_at IS NULL').run()
  db.prepare("INSERT INTO lms_workspace_migrations VALUES('verification-v1')").run()
}
