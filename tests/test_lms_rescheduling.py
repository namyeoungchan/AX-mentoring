from contextlib import closing
import importlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678', 'ADMIN_ROLE_ID': '1', 'ONBOARDING_CHANNEL_ID': '2', 'INTRO_CHANNEL_ID': '3'}):
    module = importlib.import_module('cogs.lms_rescheduling')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lms-web/server'))
    worker = importlib.import_module('storage_worker')

from storage_codec import decode

GUILD = '123456789012345678'
USER = '223456789012345678'
MENTOR = '323456789012345678'


class CoordinationUITests(unittest.IsolatedAsyncioTestCase):
    def panel_interaction(self, result):
        cog = SimpleNamespace(request=AsyncMock(return_value=result))
        interaction = SimpleNamespace(user=SimpleNamespace(id=int(USER)), guild_id=int(GUILD),
                                      client=SimpleNamespace(get_cog=lambda _: cog),
                                      response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
                                      followup=SimpleNamespace(send=AsyncMock()))
        return interaction, cog

    async def test_public_and_staff_panels_open_only_the_callers_private_booking_list(self):
        from ui.mentor_panel import MentorPanelView
        from cogs.assignment import AdminDashboardView
        sessions = [{'id': '1', 'mentor': '멘토', 'student': '수강생', 'start': '2031-01-01T15:00:00', 'status': 'confirmed'}]
        for factory, custom_id in [(lambda bot: MentorPanelView([]), 'mentoring:my_reservations'),
                                   (AdminDashboardView, 'assignment:mentor_rescheduling')]:
            interaction, cog = self.panel_interaction((200, {'sessions': sessions}))
            view = factory(interaction.client)
            self.assertTrue(view.is_persistent())
            button = next(child for child in view.children if child.custom_id == custom_id)
            await button.callback(interaction)
            cog.request.assert_awaited_once_with('list', int(GUILD), int(USER))
            interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
            result = interaction.followup.send.call_args.kwargs
            self.assertTrue(result['ephemeral'])
            self.assertIsInstance(result['view'], module.BookingsView)
            self.assertEqual(result['view'].user_id, int(USER))
            self.assertEqual(result['view'].guild_id, int(GUILD))

    async def test_panel_entry_does_not_expose_controls_when_role_is_denied_or_no_bookings_exist(self):
        for result in [(403, {'error': '조 담당 멘토와 수강생만 할 수 있습니다.'}), (200, {'sessions': []}), (503, None)]:
            interaction, _ = self.panel_interaction(result)
            await module.show_bookings(interaction)
            self.assertTrue(interaction.followup.send.call_args.kwargs['ephemeral'])
            self.assertNotIn('view', interaction.followup.send.call_args.kwargs)
        interaction, cog = self.panel_interaction((200, {'sessions': []}))
        interaction.guild_id = None
        await module.show_bookings(interaction)
        cog.request.assert_not_awaited()

    async def test_large_mentor_panels_keep_persistent_entry_within_discord_component_and_field_limits(self):
        from ui.mentor_panel import MentorPanelView, build_panel_embed
        mentors = [{'id': index, 'name': f'멘토 {index}'} for index in range(1, 31)]
        first, restored = MentorPanelView(mentors), MentorPanelView(mentors)
        self.assertEqual(len(first.children), 25)
        self.assertTrue(first.is_persistent())
        self.assertEqual([child.custom_id for child in first.children], [child.custom_id for child in restored.children])
        self.assertIn('mentoring:my_reservations', [child.custom_id for child in restored.children])
        with patch.object(worker.database, 'get_slots_for_mentor', new=AsyncMock(return_value=[])), \
             patch.object(worker.database, 'get_bookings_by_slot_ids', new=AsyncMock(return_value={})):
            embed = await build_panel_embed(mentors)
        self.assertLessEqual(len(embed.fields), 25)

    async def test_panel_refresh_updates_the_existing_owned_message_with_the_new_button(self):
        from ui.mentor_panel import MentorPanelView
        from cogs.panel_messages import ensure_panel
        import discord
        message = SimpleNamespace(id=77, author=SimpleNamespace(id=99), pinned=True, edit=AsyncMock())
        channel = SimpleNamespace(id=88, guild=SimpleNamespace(id=int(GUILD), me=SimpleNamespace(id=99)),
                                  fetch_message=AsyncMock(return_value=message), send=AsyncMock())
        store = SimpleNamespace(get=AsyncMock(return_value={'messageId': 77}), put=AsyncMock())
        await ensure_panel(channel, 'mentoring', [discord.Embed(title='멘토링 예약')], MentorPanelView([]), store)
        channel.send.assert_not_awaited()
        updated_view = message.edit.call_args.kwargs['view']
        self.assertIn('mentoring:my_reservations', [child.custom_id for child in updated_view.children])

    async def test_persistent_entry_is_bound_to_recipient_and_workspace(self):
        view = module.coordination_view(GUILD, '10', USER)
        self.assertTrue(view.is_persistent())
        item = view.children[0]
        self.assertLessEqual(len(item.custom_id), 100)
        restored = await module.EntryButton.from_custom_id(None, item.item, item.template.fullmatch(item.custom_id))
        interaction = SimpleNamespace(user=SimpleNamespace(id=99), guild_id=None, response=SimpleNamespace(send_message=AsyncMock()))
        with patch.object(module, 'show_booking', new_callable=AsyncMock) as show:
            await restored.callback(interaction)
            show.assert_not_awaited()
            interaction.user.id = int(USER)
            interaction.guild_id = 999
            await restored.callback(interaction)
            show.assert_not_awaited()
            interaction.guild_id = None
            await restored.callback(interaction)
            show.assert_awaited_once_with(interaction, int(GUILD), '10')

    async def test_actions_only_offer_accept_to_counterparty(self):
        data = {'id': '1', 'version': 3, 'editable': True, 'role': 'student', 'proposal': {'by': 'student'}, 'slots': []}
        mine = module.ActionsView(GUILD, USER, data)
        self.assertNotIn('변경 수락', [item.label for item in mine.children])
        self.assertIn('제안 철회', [item.label for item in mine.children])
        data['role'] = 'mentor'
        theirs = module.ActionsView(GUILD, MENTOR, data)
        self.assertIn('변경 수락', [item.label for item in theirs.children])
        self.assertNotIn('제안 철회', [item.label for item in theirs.children])

    async def test_modal_sends_original_availability_and_frozen_revision(self):
        modal = module.ChangeModal(GUILD, USER, {'id': '1', 'version': 4}, 'propose', '2')
        modal.reason._value = '일정 변경'
        modal.available._value = '불가'
        interaction = SimpleNamespace(user=SimpleNamespace(id=int(USER)), guild_id=None)
        with patch.object(module, 'send_action', new_callable=AsyncMock) as send:
            await modal.on_submit(interaction)
            self.assertEqual(send.call_args.args[2]['version'], 4)
            self.assertEqual(send.call_args.args[3], {'action': 'propose', 'reason': '일정 변경', 'originalAvailable': False, 'slotId': '2'})

    async def test_accept_retries_keep_discord_interaction_id_and_api_errors_are_visible(self):
        cog = SimpleNamespace(request=AsyncMock(return_value=(409, {'error': '상대방이 일정을 변경했습니다.'})))
        interaction = SimpleNamespace(id=423456789012345678, user=SimpleNamespace(id=int(USER)),
                                      client=SimpleNamespace(get_cog=lambda _: cog),
                                      response=SimpleNamespace(defer=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
        with patch.object(module, 'show_booking', new_callable=AsyncMock):
            await module.send_action(interaction, GUILD, {'id': '1', 'version': 4}, {'action': 'accept'})
        sent = cog.request.call_args.args[4]
        self.assertEqual(sent, {'action': 'accept', 'version': 4, 'eventId': str(interaction.id)})
        self.assertIn('상대방이 일정을 변경했습니다', interaction.followup.send.call_args.args[0])


class CoordinationStorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # A unique file also works with Windows restricted tokens (Python's 0700
        # TemporaryDirectory ACL can exclude the restricted token's group).
        self.filename = str(Path(tempfile.gettempdir()) / f'coordination-worker-{uuid.uuid4()}.db')
        self.addCleanup(lambda: Path(self.filename).unlink(missing_ok=True))
        self.path_patch = patch.object(worker.database, 'DB_PATH', self.filename)
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)
        await worker.database.init_db()
        with closing(sqlite3.connect(self.filename)) as db, db:
            db.executescript('''CREATE TABLE lms_records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id));
                CREATE TABLE lms_storage_receipts(id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT);
                CREATE TABLE lms_audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,target TEXT);
                INSERT INTO mentors(id,discord_id,name) VALUES(1,'323456789012345678','멘토');
                INSERT INTO slots(id,mentor_id,start_time,end_time,label) VALUES
                    (1,1,'2035-01-03T15:00:00','2035-01-03T16:00:00','기존'),
                    (2,1,'2035-01-04T15:00:00','2035-01-04T16:00:00','제안'),
                    (3,1,'2035-01-04T15:30:00','2035-01-04T16:30:00','중복 슬롯');
                INSERT INTO bookings(id,slot_id,user_id,user_name,status) VALUES(1,1,'223456789012345678','수강생','approved');''')
        self.state = {'version': 1, 'bookingId': '1', 'status': 'proposed', 'unavailable': ['student'], 'proposal': {
            'slotId': '2', 'mentorId': 1, 'studentId': USER, 'start': '2035-01-04T15:00:00', 'end': '2035-01-04T16:00:00',
            'expiresAt': int(time.time() * 1000) + 3600000}}
        self.save()

    def save(self):
        with closing(sqlite3.connect(self.filename)) as db, db:
            db.execute("INSERT OR REPLACE INTO lms_records VALUES('mentoringCoordination','1',?)", (json.dumps(self.state),))

    async def call(self, operation, args):
        return decode(await worker.run({'operation': operation, 'args': args, 'requestId': str(uuid.uuid4()),
                                        'guildId': GUILD, 'onlineMentorIds': [1]}, self.filename))

    async def test_holds_cover_overlapping_slots_and_are_released_on_expiry(self):
        for slot in (2, 3):
            self.assertFalse(await self.call('create_booking', [slot, '523456789012345678', '다른 수강생']))
        self.state['proposal']['expiresAt'] = 0
        self.save()
        self.assertTrue(await self.call('create_booking', [2, '523456789012345678', '다른 수강생']))
        self.assertFalse(await self.call('create_booking', [3, '623456789012345678', '다른 수강생']), 'confirmed overlapping booking remains protected')

    async def test_reminders_suppressed_until_agreement_and_receipts_follow_schedule_version(self):
        self.assertEqual(await self.call('get_approved_bookings_for_reminder', []), [])
        self.assertTrue(await self.call('is_reminder_sent', [1, 'day_before']))
        await self.call('mark_reminder_sent', [1, 'day_before'])
        with closing(sqlite3.connect(self.filename)) as db, db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM reminders').fetchone()[0], 0)
        self.state.update(status='needs_coordination', proposal=None)
        self.save()
        self.assertEqual(await self.call('get_approved_bookings_for_reminder', []), [])
        self.state.update(status='confirmed', version=3)
        self.save()
        self.assertEqual((await self.call('get_approved_bookings_for_reminder', []))[0]['schedule_version'], 3)

    async def test_old_cancel_buttons_and_slot_cleanup_cannot_destroy_coordination(self):
        for operation, args in [('cancel_booking', [1, USER]), ('admin_cancel_booking', [1]), ('reject_booking', [1, '거절']),
                                ('deactivate_slot', [2]), ('clear_slots', [1]), ('remove_mentor', [1])]:
            with self.assertRaises(ValueError, msg=operation):
                await self.call(operation, args)
        with closing(sqlite3.connect(self.filename)) as db, db:
            self.assertEqual(db.execute('SELECT slot_id FROM bookings WHERE id=1').fetchone()[0], 1)

    async def test_slot_picker_hides_held_slot_without_changing_storage_codec(self):
        slots = await self.call('get_slots_for_mentor_date', [1, '2035-01-04'])
        self.assertNotIn(2, [slot['id'] for slot in slots])


if __name__ == '__main__':
    unittest.main()
