import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from cogs.attendance_panel import AttendancePanelView, AttendanceCodeModal, build_attendance_embed


class AttendancePanelTests(unittest.IsolatedAsyncioTestCase):
    def setup_panel(self):
        cog = SimpleNamespace(url='https://example.test/checkin', presence=AsyncMock())
        interaction = SimpleNamespace(guild_id=123, user=SimpleNamespace(id=456), response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock(), send_modal=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
        return AttendancePanelView(SimpleNamespace(get_cog=lambda _: cog)), cog, interaction

    async def test_buttons_require_code_modal_without_recording_attendance(self):
        panel, cog, interaction = self.setup_panel()
        self.assertTrue(panel.is_persistent())
        for action in ['in', 'out']:
            await panel.handle(interaction, action)
            modal = interaction.response.send_modal.call_args.args[0]
            self.assertIsInstance(modal, AttendanceCodeModal)
            self.assertEqual(modal.action, action)
        cog.presence.assert_not_awaited()
        self.assertIn('종료 코드', build_attendance_embed().description)

    async def test_modal_uses_real_identity_and_private_result(self):
        panel, cog, interaction = self.setup_panel()
        modal = AttendanceCodeModal(cog, 'in', 456, 123)
        modal.code._value = '012345'
        cog.presence.return_value = (200, {'action':'in','date':'2026-09-19','period':1,'checkInAt':1789783200000})
        await modal.on_submit(interaction)
        cog.presence.assert_awaited_once_with('mark',456,123,{'code':'012345','action':'in'})
        self.assertTrue(interaction.followup.send.call_args.kwargs['ephemeral'])
        self.assertIn('종료 코드', interaction.followup.send.call_args.args[0])
        self.assertFalse(interaction.followup.send.call_args.kwargs['allowed_mentions'].everyone)

    async def test_invalid_or_foreign_modal_never_calls_server(self):
        _, cog, interaction = self.setup_panel()
        modal = AttendanceCodeModal(cog,'out',456,123)
        modal.code._value = '１２３４５６'
        await modal.on_submit(interaction)
        modal.code._value = '123456'
        interaction.guild_id = 999
        await modal.on_submit(interaction)
        cog.presence.assert_not_awaited()

    async def test_status_shows_schedule_and_failure_does_not_claim_success(self):
        panel, cog, interaction = self.setup_panel()
        cog.presence.return_value = (200, {'rounds':[{'period':1,'session':{'startTime':'10:00','endTime':'12:00'}}]})
        await panel.handle(interaction,'view')
        self.assertIn('10:00–12:00',interaction.followup.send.call_args.args[0])
        cog.presence.return_value = (503,None)
        await panel.handle(interaction,'view')
        self.assertIn('불러오지 못했습니다',interaction.followup.send.call_args.args[0])
        interaction.guild_id = None
        await panel.handle(interaction,'in')
        self.assertTrue(interaction.response.send_message.call_args.kwargs['ephemeral'])
