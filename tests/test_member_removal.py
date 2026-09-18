import importlib
import os
import sqlite3
from contextlib import closing
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only'}):
    database = importlib.import_module('database')
    contexts = importlib.import_module('workspace_context')


class RemovedMentorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, 'bot.db')
        patcher = patch.object(database, 'DB_PATH', self.path)
        patcher.start()
        self.addCleanup(patcher.stop)
        await database.init_db()
        self.mentor_id = await database.add_mentor('123456789012345678', '멘토')
        self.slot_id = await database.add_slot(self.mentor_id, '2030-01-01T12:00:00', '2030-01-01T13:00:00', '멘토링')

    def disable(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE mentors SET is_active=0 WHERE id=?', (self.mentor_id,))
            db.execute('UPDATE slots SET is_active=0 WHERE mentor_id=?', (self.mentor_id,))

    async def test_stale_booking_button_cannot_book_removed_mentor(self):
        self.disable()
        self.assertEqual(await database.get_mentors(), [])
        self.assertIsNone(await database.get_mentor_by_id(self.mentor_id))
        self.assertIsNone(await database.get_mentor_by_discord_id('123456789012345678'))
        self.assertFalse(await database.create_booking(self.slot_id, 'student', '학생'))
        self.assertIsNone(await database.get_booking_for_slot(self.slot_id))

    async def test_existing_booking_stays_readable_and_student_can_cancel(self):
        self.assertTrue(await database.create_booking(self.slot_id, 'student', '학생'))
        self.disable()
        booking = await database.get_booking_by_user('student')
        mentor = await database.get_mentor_by_id(booking['mentor_id'], include_inactive=True)
        self.assertEqual(mentor['name'], '멘토')
        self.assertTrue(await database.cancel_booking(self.slot_id, 'student'))

    async def test_old_mentor_view_and_modal_recheck_active_mentor_after_workspace_binding(self):
        for base in (contexts.MentorWorkspaceView, contexts.MentorWorkspaceModal):
            with patch.object(contexts, 'enter_interaction', new=AsyncMock(return_value=True)):
                view = base() if base is contexts.MentorWorkspaceView else base(title='예약 설정')
                view.mentor = {'id': self.mentor_id}
                interaction = SimpleNamespace(response=SimpleNamespace(send_message=AsyncMock()))
                self.disable()
                self.assertFalse(await view.interaction_check(interaction))
                interaction.response.send_message.assert_awaited_once()

    async def test_legacy_mentor_schema_migrates_without_disabling_existing_members(self):
        legacy = os.path.join(self.directory.name, 'legacy.db')
        with closing(sqlite3.connect(legacy)) as db, db:
            db.execute("CREATE TABLE mentors(id INTEGER PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, bio TEXT DEFAULT '')")
            db.execute("INSERT INTO mentors VALUES(1,'223456789012345678','기존 멘토','AI')")
        with patch.object(database, 'DB_PATH', legacy):
            await database.init_db()
            self.assertEqual((await database.get_mentor_by_id(1))['is_active'], 1)
