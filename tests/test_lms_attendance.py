import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678'}):
    attendance = importlib.import_module('cogs.lms_attendance')


class AttendanceCommandTests(unittest.IsolatedAsyncioTestCase):
    def cog(self, url='http://127.0.0.1:3002/api/integrations/discord/verify'):
        with patch.dict(os.environ, {'LEARNINGOPS_AUTH_URL': url, 'LEARNINGOPS_AUTH_TOKEN': 'test-only-auth-token-12345678901234567890'}):
            return attendance.LMSAttendance(None)

    def interaction(self, guild_id=123456789012345678):
        return SimpleNamespace(guild_id=guild_id, user=SimpleNamespace(id=223456789012345678),
                               response=SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                               followup=SimpleNamespace(send=AsyncMock()))

    async def test_identity_is_from_invoking_member_and_response_is_private(self):
        cog, interaction = self.cog(), self.interaction()
        response = MagicMock(status=200)
        response.json = AsyncMock(return_value={'date': '2026-09-18', 'period': 2, 'status': '출석', 'alreadyRecorded': False})
        response.__aenter__ = AsyncMock(return_value=response)
        response.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        session.post.return_value = response
        with patch.object(cog.transport, 'session', return_value=session):
            await attendance.LMSAttendance.check_in.callback(cog, interaction, ' 001234 ')
        self.assertEqual(session.post.call_args.args[0], 'http://127.0.0.1:3002/api/integrations/discord/attendance/checkin')
        self.assertEqual(session.post.call_args.kwargs['json'], {'code': '001234', 'discordId': str(interaction.user.id), 'guildId': str(interaction.guild_id)})
        self.assertFalse(session.post.call_args.kwargs['allow_redirects'])
        self.assertTrue(interaction.response.defer.call_args.kwargs['ephemeral'])
        self.assertTrue(interaction.followup.send.call_args.kwargs['ephemeral'])
        self.assertIn('2차시', interaction.followup.send.call_args.args[0])
        self.assertFalse(interaction.followup.send.call_args.kwargs['allowed_mentions'].everyone)

    async def test_invalid_codes_dm_and_unconfigured_endpoint_never_request(self):
        for cog, interaction, code in [(self.cog(), self.interaction(), '１２３４５６'), (self.cog(), self.interaction(), '12345'),
                                        (self.cog(), self.interaction(None), '123456'), (self.cog('https://user:secret@example.com/wrong'), self.interaction(), '123456')]:
            with patch.object(cog, 'request', new=AsyncMock()) as request:
                await attendance.LMSAttendance.check_in.callback(cog, interaction, code)
                request.assert_not_awaited()
                self.assertTrue(interaction.response.send_message.call_args.kwargs['ephemeral'])

    async def test_duplicate_correction_expiry_rate_limit_and_unknown_result_are_clear(self):
        cog = self.cog()
        for status, data, message in [(200, {'date': '2026-09-18', 'period': 1, 'status': '지각', 'alreadyRecorded': True}, '정정'),
                                       (410, None, '만료'), (429, None, '1분'), (503, None, '같은 코드'), (200, {}, '확인하지 못했습니다')]:
            interaction = self.interaction()
            with patch.object(cog, 'request', new=AsyncMock(return_value=(status, data))):
                await attendance.LMSAttendance.check_in.callback(cog, interaction, '123456')
            self.assertIn(message, interaction.followup.send.call_args.args[0])
            self.assertTrue(interaction.followup.send.call_args.kwargs['ephemeral'])

    async def test_network_timeout_returns_unknown_result_without_exposing_connection_details(self):
        cog = self.cog()
        with patch.object(cog.transport, 'session', side_effect=TimeoutError('secret connection')):
            self.assertEqual(await cog.request('123456', 1, 2), (503, None))

    async def test_presence_retry_payload_cannot_override_invoking_identity(self):
        cog = self.cog()
        cog.transport.post_json = AsyncMock(return_value=(200, {'alreadyRecorded': True}))
        await cog.presence('mark', 123, 456, {'code': '123456', 'action': 'in', 'discordId': 'other', 'guildId': 'other'})
        call = cog.transport.post_json.call_args
        self.assertEqual(call.kwargs['body'], {'code': '123456', 'action': 'in', 'discordId': '123', 'guildId': '456'})
        self.assertTrue(call.kwargs['retry'])
