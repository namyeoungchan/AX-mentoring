import importlib
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678'}):
    assignment = importlib.import_module('cogs.assignment')
    database = importlib.import_module('database')


class AssignmentDeletionTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_delete_checks_new_submissions_and_removes_children_without_fk_pragma(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(database, 'DB_PATH', os.path.join(directory, 'test.db')):
            await database.init_db()
            aid = await database.create_assignment(1, '과제', '', '2026-10-01', 'team')
            preview = await database.get_assignment_delete_preview(aid)
            await database.create_submission(aid, '123456789012345678', '수강생', '1조', '답변', '')
            await database.mark_assignment_reminder_sent(aid, '1조')
            with self.assertRaisesRegex(ValueError, 'stale_revision'):
                await database.delete_assignment(aid, preview['revision'])
            latest = await database.get_assignment_delete_preview(aid)
            self.assertEqual(latest['submissionCount'], 1)
            self.assertTrue(await database.delete_assignment(aid, latest['revision']))
            self.assertEqual(await database.get_submissions(aid), [])
            self.assertFalse(await database.is_assignment_reminder_sent(aid, '1조'))
            self.assertFalse(await database.delete_assignment(aid))

    def interaction(self):
        return SimpleNamespace(response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()), edit_original_response=AsyncMock())

    async def test_permission_is_rechecked_before_delete(self):
        view = assignment.DeleteConfirmView(MagicMock(), {'assignment': {'id': 1}, 'revision': 'r', 'submissionCount': 0})
        interaction = self.interaction()
        with patch.object(assignment, '_is_admin', return_value=False), patch.object(database, 'delete_assignment', new_callable=AsyncMock) as remove:
            await view.confirm.callback(interaction)
            remove.assert_not_awaited()
            interaction.response.send_message.assert_awaited_once()

    async def test_acknowledges_before_io_and_missing_record_is_not_reported_as_deleted(self):
        preview = {'assignment': {'id': 1, 'title': '과제'}, 'revision': 'r', 'submissionCount': 2}
        view = assignment.DeleteConfirmView(MagicMock(), preview)
        interaction = self.interaction()
        async def remove(*args, **kwargs):
            interaction.response.defer.assert_awaited_once()
            return False
        with patch.object(assignment, '_is_admin', return_value=True), patch.object(database, 'delete_assignment', side_effect=remove), patch.object(assignment, 'refresh_dashboard', new_callable=AsyncMock):
            await view.confirm.callback(interaction)
        self.assertEqual(interaction.edit_original_response.call_args.kwargs['embed'].title, '이미 삭제된 과제')

    async def test_database_failure_keeps_success_message_off_the_screen(self):
        view = assignment.DeleteConfirmView(MagicMock(), {'assignment': {'id': 1}, 'revision': 'r', 'submissionCount': 0})
        interaction = self.interaction()
        with patch.object(assignment, '_is_admin', return_value=True), patch.object(database, 'delete_assignment', side_effect=ValueError('stale_revision')):
            await view.confirm.callback(interaction)
        self.assertIn('최신 내역', interaction.edit_original_response.call_args.kwargs['content'])
