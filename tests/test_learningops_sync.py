import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import aiosqlite

# Isolated test configuration. No real token or Discord connection is used.
with patch.dict(os.environ, {
    "DISCORD_TOKEN": "test-only", "GUILD_ID": "123456789012345678", "ADMIN_ROLE_ID": "1",
    "ONBOARDING_CHANNEL_ID": "2", "INTRO_CHANNEL_ID": "3",
}):
    database = importlib.import_module("database")
    sync = importlib.import_module("cogs.learningops_sync")


class SnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = str(Path(self.directory.name) / "mentoring.db")
        self.original_path = database.DB_PATH
        database.DB_PATH = self.path
        await database.init_db()

    async def asyncTearDown(self):
        database.DB_PATH = self.original_path
        self.directory.cleanup()

    async def test_empty_database_has_no_fabricated_counts(self):
        result = await sync.read_snapshot(self.path)
        self.assertEqual(result["counts"]["mentors"], 0)
        self.assertEqual(result["bookings"], [])

    async def test_existing_bot_rows_are_exported_without_modification(self):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("INSERT INTO mentors(discord_id,name,bio) VALUES('223456789012345678','멘토','개발')")
            await db.execute("INSERT INTO slots(mentor_id,start_time,end_time,label) VALUES(1,'2026-09-15T14:00:00','2026-09-15T14:50:00','멘토링')")
            await db.execute("INSERT INTO bookings(slot_id,user_id,user_name,status) VALUES(1,'333456789012345678','학생','pending')")
            await db.execute("INSERT INTO assignments(week,title,due_date) VALUES(1,'과제','2026-09-20')")
            await db.execute("INSERT INTO submissions(assignment_id,user_id,user_name,content) VALUES(1,'333456789012345678','학생','제출내용')")
            await db.commit()
        result = await sync.read_snapshot(self.path)
        self.assertEqual(result["counts"]["pending_bookings"], 1)
        self.assertEqual(result["bookings"][0]["mentor_name"], "멘토")
        self.assertEqual(result["assignments"][0]["submitted"], 1)
        self.assertEqual(result["submissions"][0]["assignment_title"], "과제")
        self.assertNotIn("user_id", result["bookings"][0])
        async with aiosqlite.connect(self.path) as db:
            async with db.execute("SELECT status FROM bookings") as cursor:
                self.assertEqual((await cursor.fetchone())[0], "pending")
            async with db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'lms_%'") as cursor:
                self.assertEqual(await cursor.fetchall(), [])

    async def test_limit_preserves_total_counts(self):
        async with aiosqlite.connect(self.path) as db:
            await db.executemany("INSERT INTO mentors(discord_id,name) VALUES(?,?)", [(str(i), "멘토") for i in range(1002)])
            await db.commit()
        result = await sync.read_snapshot(self.path)
        self.assertEqual(result["counts"]["mentors"], 1002)
        self.assertEqual(len(result["mentors"]), 1000)
        self.assertEqual(result["mentors"][0]["id"], 1002)


class EndpointTests(unittest.TestCase):
    def test_https_and_local_development_endpoints(self):
        for origin in ("https://example.com", "http://127.0.0.1:3001"):
            url = origin + "/api/integrations/render/snapshot"
            self.assertEqual(sync.validate_endpoint(url), url)

    def test_rejects_unsafe_or_incorrect_endpoints(self):
        for url in ("http://example.com/api/integrations/render/snapshot", "https://user:password@example.com/api/integrations/render/snapshot", "https://example.com/wrong", "https://example.com/api/integrations/render/snapshot?token=secret"):
            with self.assertRaises(ValueError):
                sync.validate_endpoint(url)


if __name__ == "__main__":
    unittest.main()
