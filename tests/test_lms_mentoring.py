import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678', 'ADMIN_ROLE_ID': '1', 'ONBOARDING_CHANNEL_ID': '2', 'INTRO_CHANNEL_ID': '3'}):
    module = importlib.import_module('cogs.lms_mentoring')

GUILD = '123456789012345678'
USER = '223456789012345678'
REQUEST = 'd9b7a63d-5e4f-4a0c-b334-c51a56cefda1'


class MentoringTests(unittest.IsolatedAsyncioTestCase):
    async def test_dm_button_survives_restart_and_only_recipient_can_open_form(self):
        view = module.feedback_view(GUILD, REQUEST, USER)
        self.assertTrue(view.is_persistent())
        button = view.children[0]
        self.assertLessEqual(len(button.custom_id), 100)
        restored = await module.FeedbackButton.from_custom_id(None, button.item, button.template.fullmatch(button.custom_id))
        interaction = SimpleNamespace(user=SimpleNamespace(id=99), guild_id=None,
                                      response=SimpleNamespace(send_message=AsyncMock(), send_modal=AsyncMock()))
        await restored.callback(interaction)
        interaction.response.send_modal.assert_not_awaited()
        interaction.user.id = int(USER)
        await restored.callback(interaction)
        modal = interaction.response.send_modal.call_args.args[0]
        self.assertEqual(modal.request_id, REQUEST)
        self.assertEqual(modal.user_id, int(USER))

    async def test_plain_reply_uses_exact_parent_recipient_and_original_message_id(self):
        bot = SimpleNamespace(user=SimpleNamespace(id=42))
        cog = module.LMSMentoring(bot)
        cog.submit = AsyncMock(return_value=(200, {'ok': True}))
        parent = SimpleNamespace(author=bot.user, components=[SimpleNamespace(children=[SimpleNamespace(custom_id=f'lms:mf:{GUILD}:{REQUEST}:{USER}')])])
        message = SimpleNamespace(id=323456789012345678, guild=None, author=SimpleNamespace(id=int(USER), bot=False),
                                  reference=SimpleNamespace(message_id=7), channel=SimpleNamespace(fetch_message=AsyncMock(return_value=parent)),
                                  content='데이터 분석 피드백', reply=AsyncMock())
        await cog.on_message(message)
        cog.submit.assert_awaited_once_with(GUILD, REQUEST, int(USER), message.id, message.content)
        self.assertIn('저장되었습니다', message.reply.call_args.args[0])
        cog.submit.reset_mock()
        message.author.id = 99
        await cog.on_message(message)
        cog.submit.assert_not_awaited()
        message.author.id = int(USER)
        message.reference = None
        await cog.on_message(message)
        cog.submit.assert_not_awaited()
        await cog.transport.close()

    async def test_modal_submits_author_identity_and_does_not_claim_success_on_api_failure(self):
        cog = SimpleNamespace(submit=AsyncMock(return_value=(503, None)))
        interaction = SimpleNamespace(id=423456789012345678, user=SimpleNamespace(id=int(USER)),
                                      client=SimpleNamespace(get_cog=lambda _: cog), response=SimpleNamespace(defer=AsyncMock()),
                                      followup=SimpleNamespace(send=AsyncMock()))
        modal = module.FeedbackModal(int(GUILD), REQUEST, int(USER))
        modal.content._value = '프로젝트 피드백'
        await modal.on_submit(interaction)
        cog.submit.assert_awaited_once_with(int(GUILD), REQUEST, int(USER), interaction.id, '프로젝트 피드백')
        self.assertIn('확인하지 못했습니다', interaction.followup.send.call_args.args[0])

    async def test_transport_retries_keep_the_same_discord_event_id(self):
        cog = module.LMSMentoring(SimpleNamespace())
        cog.url, cog.token = 'https://example.com/api/integrations/discord/mentoring/response', 'test-token'
        cog.transport.post_json = AsyncMock(return_value=(200, {'ok': True}))
        await cog.submit(GUILD, REQUEST, USER, 323456789012345678, '응답')
        kwargs = cog.transport.post_json.call_args.kwargs
        self.assertEqual(kwargs['body']['eventId'], '323456789012345678')
        self.assertTrue(kwargs['retry'])
        await cog.transport.close()
