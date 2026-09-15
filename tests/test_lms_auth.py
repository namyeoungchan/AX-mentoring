import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

with patch.dict(os.environ, {"DISCORD_TOKEN": "test-only", "GUILD_ID": "123456789012345678", "ADMIN_ROLE_ID": "1", "ONBOARDING_CHANNEL_ID": "2", "INTRO_CHANNEL_ID": "3"}):
    auth = importlib.import_module("cogs.lms_auth")


class AuthCommandTests(unittest.IsolatedAsyncioTestCase):
    def interaction(self, guild_id=None):
        return SimpleNamespace(guild_id=guild_id if guild_id is not None else auth.config.GUILD_ID,
                               user=SimpleNamespace(id=555456789012345678),
                               response=SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
                               followup=SimpleNamespace(send=AsyncMock()))

    async def test_unconfigured_and_wrong_guild_do_not_call_api(self):
        with patch.dict(os.environ, {"LEARNINGOPS_AUTH_URL": "", "LEARNINGOPS_AUTH_TOKEN": ""}):
            cog = auth.LMSAuth(None)
        interaction = self.interaction()
        await auth.LMSAuth.verify_registration.callback(cog, interaction, "01234567-89ABCDEF")
        self.assertTrue(interaction.response.send_message.call_args.kwargs["ephemeral"])
        interaction.response.defer.assert_not_awaited()
        interaction = self.interaction(999456789012345678)
        await auth.LMSAuth.verify_registration.callback(cog, interaction, "01234567-89ABCDEF")
        interaction.response.defer.assert_not_awaited()

    async def test_invoking_member_identity_is_sent_and_reply_is_private(self):
        with patch.dict(os.environ, {"LEARNINGOPS_AUTH_URL": "http://127.0.0.1:3002/api/integrations/discord/verify", "LEARNINGOPS_AUTH_TOKEN": "test-only-auth-key-12345678901234567890"}):
            cog = auth.LMSAuth(None)
        response = MagicMock()
        response.status = 200
        response.json = AsyncMock(return_value={"username": "student.test"})
        response.__aenter__ = AsyncMock(return_value=response)
        response.__aexit__ = AsyncMock(return_value=False)
        session = MagicMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        session.post.return_value = response
        interaction = self.interaction()
        with patch.object(auth.aiohttp, "ClientSession", return_value=session):
            await auth.LMSAuth.verify_registration.callback(cog, interaction, "01234567-89abcdef")
        payload = session.post.call_args.kwargs["json"]
        self.assertEqual(payload, {"code": "0123456789ABCDEF", "discordId": str(interaction.user.id), "guildId": str(interaction.guild_id)})
        self.assertFalse(session.post.call_args.kwargs["allow_redirects"])
        self.assertTrue(interaction.response.defer.call_args.kwargs["ephemeral"])
        self.assertTrue(interaction.followup.send.call_args.kwargs["ephemeral"])
        self.assertIn("student.test", interaction.followup.send.call_args.args[0])
        view = interaction.followup.send.call_args.kwargs["view"]
        confirmation = self.interaction()
        confirmation.response.edit_message = AsyncMock()
        confirmation.edit_original_response = AsyncMock()
        with patch.object(cog, "api_request", new=AsyncMock(return_value=(200, {"ok": True}))) as request:
            await view.confirm.callback(confirmation)
        self.assertEqual(request.call_args.args[-1], "verify")
        confirmation.edit_original_response.assert_awaited_once()

    def test_endpoint_rejects_credentials_wrong_paths_and_nonlocal_http(self):
        for value in ["http://example.com/api/integrations/discord/verify", "https://user:pass@example.com/api/integrations/discord/verify", "https://example.com/wrong", "https://example.com/api/integrations/discord/verify?key=x"]:
            with self.assertRaises(ValueError):
                auth.validate_auth_endpoint(value)


if __name__ == "__main__":
    unittest.main()
