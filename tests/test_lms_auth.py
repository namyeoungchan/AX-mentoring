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
        with patch.object(cog.transport, "session", return_value=session), patch.object(cog, "verification_state", new=AsyncMock(return_value=(200, {"verified": False}))):
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

    async def test_panel_modal_uses_the_same_identity_checked_verification_flow(self):
        cog = SimpleNamespace(begin_verification=AsyncMock())
        modal = auth.VerificationModal(cog)
        modal.code._value = "01234567-89ABCDEF"
        interaction = self.interaction()
        await modal.on_submit(interaction)
        cog.begin_verification.assert_awaited_once_with(interaction, "01234567-89ABCDEF")

    async def test_used_or_expired_code_resumes_existing_proof_without_preview(self):
        cog = auth.LMSAuth(None)
        cog.url = 'https://example.com/api/integrations/discord/verify'
        cog.verification_state = AsyncMock(return_value=(200, {'verified': True}))
        cog.api_request = AsyncMock()
        interaction = self.interaction()
        await cog.begin_verification(interaction, '01234567-89ABCDEF')
        cog.verification_state.assert_awaited_once_with(interaction.user.id, interaction.guild_id)
        cog.api_request.assert_not_awaited()
        self.assertIn('재인증은 필요 없습니다', interaction.followup.send.call_args.args[0])
        cog.verification_state.return_value = (503, None)
        await cog.begin_verification(interaction, '01234567-89ABCDEF')
        cog.api_request.assert_not_awaited()
        self.assertIn('상태를 확인하지 못했습니다', interaction.followup.send.call_args.args[0])

    async def test_stale_confirmation_resumes_only_current_identity_proof(self):
        cog = SimpleNamespace(api_request=AsyncMock(return_value=(410, None)), verification_state=AsyncMock(return_value=(200, {'verified': True})), bot=None)
        interaction = self.interaction()
        interaction.response.edit_message = AsyncMock()
        interaction.edit_original_response = AsyncMock()
        view = auth.VerificationView(cog, '0123456789ABCDEF', interaction.user.id, interaction.guild_id)
        await view.confirm.callback(interaction)
        self.assertEqual(interaction.edit_original_response.call_args.kwargs['content'], auth.MESSAGES[200])
        cog.verification_state.return_value = (200, {'verified': False})
        await view.confirm.callback(interaction)
        self.assertEqual(interaction.edit_original_response.call_args.kwargs['content'], auth.MESSAGES[410])
        cog.verification_state.return_value = (503, None)
        await view.confirm.callback(interaction)
        self.assertEqual(interaction.edit_original_response.call_args.kwargs['content'], auth.MESSAGES[503])

    def test_endpoint_rejects_credentials_wrong_paths_and_nonlocal_http(self):
        for value in ["http://example.com/api/integrations/discord/verify", "https://user:pass@example.com/api/integrations/discord/verify", "https://example.com/wrong", "https://example.com/api/integrations/discord/verify?key=x"]:
            with self.assertRaises(ValueError):
                auth.validate_auth_endpoint(value)

    async def test_lost_verification_response_recovers_only_with_this_members_proof(self):
        onboarding = SimpleNamespace(after_verification=AsyncMock())
        cog = SimpleNamespace(api_request=AsyncMock(return_value=(503, None)),
                              verification_state=AsyncMock(), bot=SimpleNamespace(get_cog=lambda _: onboarding))
        for proof, expected in [({'verified': True}, 200), ({'verified': False}, 503), ({}, 503)]:
            cog.verification_state.return_value = (200, proof)
            interaction = self.interaction()
            interaction.response.edit_message = AsyncMock()
            interaction.edit_original_response = AsyncMock()
            await auth.VerificationView(cog, '0123456789ABCDEF', interaction.user.id, interaction.guild_id).confirm.callback(interaction)
            cog.verification_state.assert_awaited_with(interaction.user.id, interaction.guild_id)
            self.assertEqual(interaction.edit_original_response.call_args.kwargs['content'], auth.MESSAGES[expected])
        onboarding.after_verification.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
