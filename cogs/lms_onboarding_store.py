import json
import aiosqlite


class OnboardingStore:
    def __init__(self, path):
        self.path = path

    async def initialize(self):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("CREATE TABLE IF NOT EXISTS lms_managed_onboarding(guild_id TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,kind,record_key))")
            await db.commit()

    async def get(self, guild_id, kind, key):
        async with aiosqlite.connect(self.path) as db:
            async with db.execute("SELECT data FROM lms_managed_onboarding WHERE guild_id=? AND kind=? AND record_key=?", (str(guild_id), kind, str(key))) as rows:
                row = await rows.fetchone()
                return json.loads(row[0]) if row else None

    async def put(self, guild_id, kind, key, value):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("INSERT INTO lms_managed_onboarding VALUES(?,?,?,?) ON CONFLICT(guild_id,kind,record_key) DO UPDATE SET data=excluded.data", (str(guild_id), kind, str(key), json.dumps(value)))
            await db.commit()

    async def all(self, guild_id, kind):
        async with aiosqlite.connect(self.path) as db:
            async with db.execute("SELECT record_key,data FROM lms_managed_onboarding WHERE guild_id=? AND kind=?", (str(guild_id), kind)) as rows:
                return {key: json.loads(data) for key, data in await rows.fetchall()}
