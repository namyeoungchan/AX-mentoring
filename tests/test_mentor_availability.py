import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only'}):
    import database
    from ui.mentor_setup import ScheduleSetModal
    from ui.mentor_availability import AvailabilityButton
    from workspace_context import MentorWorkspaceView
    from cogs.assignment import AdminDashboardView
    from ui.mentor_setup import MentorSetupView


class AvailabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_dashboard_entry_opens_only_current_mentors_private_setup(self):
        guild_id = 123456789012345678
        interaction = self.interaction()
        interaction.guild_id = guild_id
        member_lookup = AsyncMock()
        interaction.client = SimpleNamespace(get_guild=lambda _: SimpleNamespace(fetch_member=member_lookup))
        view = AdminDashboardView(interaction.client)
        self.assertTrue(view.is_persistent())
        button = next(child for child in view.children if child.custom_id == 'assignment:mentor_setup')
        mentor = {'id': 7, 'discord_id': str(interaction.user.id)}
        with patch('ui.mentor_availability.enter_interaction', new=AsyncMock(return_value=True)) as enter, \
             patch.object(database, 'get_online_mentor_by_discord_id', new=AsyncMock(return_value=mentor)) as lookup, \
             patch.object(database, 'get_slot_template', new=AsyncMock(return_value=None)), \
             patch('ui.mentor_setup.build_setup_embed', new=AsyncMock(return_value=None)):
            await button.callback(interaction)
            enter.assert_awaited_once_with(interaction, guild_id)
            lookup.assert_awaited_once_with(str(interaction.user.id))
            member_lookup.assert_awaited_once_with(interaction.user.id)
            result = interaction.followup.send.call_args.kwargs
            self.assertTrue(result['ephemeral'])
            self.assertIsInstance(result['view'], MentorSetupView)
            self.assertEqual(result['view'].mentor, mentor)
            lookup.return_value = None
            interaction.followup.send.reset_mock()
            await button.callback(interaction)
            self.assertNotIn('view', interaction.followup.send.call_args.kwargs)

    def interaction(self, user_id=223456789012345678):
        return SimpleNamespace(user=SimpleNamespace(id=user_id),
                               response=SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                               followup=SimpleNamespace(send=AsyncMock()))

    async def test_schedule_save_enables_date_generation_in_next_view(self):
        mentor = {'id': 1, 'discord_id': '223456789012345678'}
        modal = ScheduleSetModal(mentor, SimpleNamespace())
        modal.start_time._value, modal.end_time._value, modal.interval._value = '19:00', '21:00', '30'
        template = {'start_hour': 19, 'start_minute': 0, 'end_hour': 21, 'end_minute': 0, 'interval_minutes': 30}
        interaction = self.interaction()
        with patch.object(database, 'set_slot_template', new=AsyncMock()) as save, patch.object(database, 'get_slot_template', new=AsyncMock(return_value=template)):
            await modal.on_submit(interaction)
            save.assert_awaited_once_with(1, 19, 0, 21, 0, 30)
        interaction.response.defer.assert_awaited_once()
        view = interaction.followup.send.call_args.kwargs['view']
        self.assertFalse(view.generate_slots.disabled)

    async def test_invalid_clock_time_never_saves(self):
        modal = ScheduleSetModal({'id': 1}, SimpleNamespace())
        modal.start_time._value, modal.end_time._value, modal.interval._value = '19:70', '25:00', '30'
        with patch.object(database, 'set_slot_template', new=AsyncMock()) as save:
            await modal.on_submit(self.interaction())
            save.assert_not_awaited()

    async def test_old_self_service_view_checks_owner_and_current_group_scope(self):
        view = MentorWorkspaceView()
        view.mentor = {'id': 1, 'discord_id': '223456789012345678'}
        with patch('workspace_context.enter_interaction', new=AsyncMock(return_value=True)), patch.object(database, 'get_online_mentor_by_id', new=AsyncMock(return_value=view.mentor)) as lookup:
            self.assertFalse(await view.interaction_check(self.interaction(99)))
            lookup.assert_not_awaited()
            self.assertTrue(await view.interaction_check(self.interaction()))
            lookup.return_value = None
            self.assertFalse(await view.interaction_check(self.interaction()))

    async def test_notification_button_acknowledges_then_rechecks_group_membership(self):
        interaction = self.interaction()
        interaction.client = SimpleNamespace(get_guild=lambda _: SimpleNamespace(fetch_member=AsyncMock()))
        with patch('ui.mentor_availability.enter_interaction', new=AsyncMock(return_value=True)), patch.object(database, 'get_online_mentor_by_discord_id', new=AsyncMock(return_value=None)):
            await AvailabilityButton(123456789012345678, interaction.user.id).callback(interaction)
        interaction.response.defer.assert_awaited_once()
        self.assertNotIn('view', interaction.followup.send.call_args.kwargs)
