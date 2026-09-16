import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import discord
from cogs.lms_admissions import create_student_invite, LMSAdmissions


class AdmissionInviteTests(unittest.IsolatedAsyncioTestCase):
    def guild(self, allowed=True, visible=True):
        channel = MagicMock(spec=discord.TextChannel)
        channel.permissions_for.return_value = SimpleNamespace(create_instant_invite=allowed, view_channel=visible)
        channel.create_invite = AsyncMock(return_value=SimpleNamespace(code="test-invite-code"))
        guild = SimpleNamespace(me=object(), default_role=object(), fetch_channels=AsyncMock(return_value=[channel]))
        return guild, channel

    async def test_invite_is_single_use_expires_and_targets_a_visible_text_channel(self):
        guild, channel = self.guild()
        self.assertEqual(await create_student_invite(guild), "test-invite-code")
        self.assertEqual(channel.create_invite.call_args.kwargs["max_uses"], 1)
        self.assertEqual(channel.create_invite.call_args.kwargs["max_age"], 86400)
        self.assertTrue(channel.create_invite.call_args.kwargs["unique"])

    async def test_missing_permissions_or_private_channels_do_not_create_an_invite(self):
        for allowed, visible in [(False, True), (True, False)]:
            guild, channel = self.guild(allowed, visible)
            with self.assertRaises(ValueError):
                await create_student_invite(guild)
            channel.create_invite.assert_not_awaited()

    async def test_invites_only_target_the_configured_onboarding_channel(self):
        guild, channel = self.guild()
        channel.id = 123
        with self.assertRaises(ValueError):
            await create_student_invite(guild, 456)
        channel.create_invite.assert_not_awaited()
        self.assertEqual(await create_student_invite(guild, 123), "test-invite-code")

    async def test_complete_conflict_stops_replaying_a_stale_claim(self):
        response = MagicMock()
        response.status = 409
        response.__aenter__ = AsyncMock(return_value=response)
        response.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.post.return_value = response
        cog = SimpleNamespace(url="https://example.com/api/integrations/discord/admissions", token="test-only-token")
        self.assertEqual(await LMSAdmissions.post(cog, session, "complete", {}), {"expired": True})
