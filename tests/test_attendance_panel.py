import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from cogs.attendance_panel import AttendancePanelView, AttendanceRoundView, build_attendance_embed


class AttendancePanelTests(unittest.IsolatedAsyncioTestCase):
    def setup_panel(self, rows):
        cog = SimpleNamespace(url='https://example.test/checkin', presence=AsyncMock(return_value=(200, {'rounds': rows})))
        bot = SimpleNamespace(get_cog=lambda _: cog)
        interaction = SimpleNamespace(guild_id=123, user=SimpleNamespace(id=456), response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
        return AttendancePanelView(bot), cog, interaction

    async def test_persistent_panel_uses_invoking_identity_and_keeps_results_private(self):
        row = {'courseId': 'course', 'date': '2026-09-19', 'period': 1, 'state': '진행 중'}
        panel, cog, interaction = self.setup_panel([row])
        cog.presence.side_effect = [(200, {'rounds': [row]}), (200, {**row, 'checkInAt': 1789783200000, 'checkOutAt': None})]
        self.assertTrue(panel.is_persistent())
        self.assertEqual(len(panel.children), 3)
        await panel.handle(interaction, 'in')
        self.assertEqual(cog.presence.call_args.args, ('mark', 456, 123, {'courseId': 'course', 'date': row['date'], 'period': 1, 'action': 'in'}))
        self.assertTrue(interaction.response.defer.call_args.kwargs['ephemeral'])
        self.assertTrue(interaction.followup.send.call_args.kwargs['ephemeral'])
        self.assertIn('퇴실도', interaction.followup.send.call_args.args[0])
        self.assertFalse(interaction.followup.send.call_args.kwargs['allowed_mentions'].everyone)
        self.assertIn('웹', build_attendance_embed().description)

    async def test_exit_without_entry_never_posts_a_mark_and_multiple_rounds_require_selection(self):
        rows = [{'courseId': 'c', 'date': '2026-09-19', 'period': n, 'state': '진행 중'} for n in (1, 2)]
        panel, cog, interaction = self.setup_panel(rows)
        await panel.handle(interaction, 'out')
        self.assertEqual(cog.presence.await_count, 1)
        await panel.handle(interaction, 'in')
        view = interaction.followup.send.call_args.kwargs['view']
        self.assertIsInstance(view, AttendanceRoundView)
        self.assertEqual(len(view.children[0].options), 2)
        foreign = SimpleNamespace(guild_id=999, user=SimpleNamespace(id=456), response=SimpleNamespace(send_message=AsyncMock()))
        self.assertFalse(await view.interaction_check(foreign))

    async def test_api_failure_and_dm_are_clear_and_do_not_claim_success(self):
        panel, cog, interaction = self.setup_panel([])
        cog.presence.return_value = (503, None)
        await panel.handle(interaction, 'in')
        self.assertIn('불러오지 못했습니다', interaction.followup.send.call_args.args[0])
        interaction.guild_id = None
        await panel.handle(interaction, 'in')
        self.assertEqual(cog.presence.await_count, 1)
        self.assertTrue(interaction.response.send_message.call_args.kwargs['ephemeral'])

    async def test_large_roster_of_rounds_is_paginated(self):
        rows = [{'courseId': 'c', 'date': '2026-09-19', 'period': n, 'state': '진행 중'} for n in range(1, 27)]
        view = AttendanceRoundView(MagicMock(), rows, 'in', 456, 123)
        self.assertEqual(len(view.children[0].options), 25)
        self.assertEqual(view.children[1].label, '다음 회차')
