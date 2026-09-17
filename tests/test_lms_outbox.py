import asyncio
import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import discord

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678', 'ADMIN_ROLE_ID': '1', 'ONBOARDING_CHANNEL_ID': '2', 'INTRO_CHANNEL_ID': '3'}):
    module = importlib.import_module('cogs.lms_outbox')


class OutboxTests(unittest.IsolatedAsyncioTestCase):
    async def test_submission_repairs_private_dashboard_and_individual_reminder_uses_dm(self):
        bot, channel, job = self.fixture()
        onboarding = SimpleNamespace(ensure_dashboard=AsyncMock(return_value=channel))
        bot.get_cog = lambda _: onboarding
        result = await module.deliver(bot, {**job, 'kind': 'submission'})
        self.assertEqual(result['state'], 'sent')
        onboarding.ensure_dashboard.assert_awaited_once()
        member = SimpleNamespace(create_dm=AsyncMock(return_value=channel))
        guild = SimpleNamespace(fetch_member=AsyncMock(return_value=member))
        bot.get_guild = lambda _: guild
        result = await module.deliver(bot, {**job, 'kind': 'reminder', 'channelId': 'dm:123', 'payload': {**job['payload'], 'audience': 'individual', 'targetId': '123'}})
        self.assertEqual(result['state'], 'sent')
        guild.fetch_member.assert_awaited_once_with(123)

    async def test_attendance_repairs_private_channel_and_refuses_delivery_without_guard(self):
        bot, channel, job = self.fixture()
        bot.get_cog = lambda _: None
        result = await module.deliver(bot, {**job, 'kind': 'attendance'})
        self.assertEqual(result['error'], 'private_channel_required')
        channel.send.assert_not_awaited()
        onboarding = SimpleNamespace(ensure_dashboard=AsyncMock(return_value=channel))
        bot.get_cog = lambda _: onboarding
        result = await module.deliver(bot, {**job, 'kind': 'attendance'})
        self.assertEqual(result['state'], 'sent')
        onboarding.ensure_dashboard.assert_awaited_once()

    async def test_team_reminder_rejects_public_channel_without_posting(self):
        bot, channel, job = self.fixture()
        guild = bot.get_guild(11)
        guild.id, guild.me, guild.default_role = 11, SimpleNamespace(id=100), SimpleNamespace(id=0)
        bot.get_cog = lambda _: SimpleNamespace(store=SimpleNamespace(get=AsyncMock(return_value={'id': 5})))
        channel.permissions_for.return_value = SimpleNamespace(view_channel=True)
        result = await module.deliver(bot, {**job, 'kind': 'reminder', 'payload': {**job['payload'], 'audience': 'team', 'targetId': 't1', 'roleId': '8'}})
        self.assertEqual(result['error'], 'private_channel_required')
        channel.send.assert_not_awaited()

    async def test_publication_routes_private_team_channel_and_verified_dm_and_reports_dm_failure(self):
        bot, channel, job = self.fixture()
        guild = bot.get_guild(11)
        guild.id, guild.me, guild.default_role = 11, SimpleNamespace(id=100), SimpleNamespace(id=0)
        bot.get_cog = lambda _: SimpleNamespace(store=SimpleNamespace(get=AsyncMock(return_value={'id': 5})))
        channel.permissions_for.return_value = SimpleNamespace(view_channel=False)
        channel.overwrites = {}
        team_job = {**job, 'kind': 'publication', 'payload': {**job['payload'], 'audience': 'team', 'targetId': 't1', 'roleId': '8'}}
        self.assertEqual((await module.deliver(bot, team_job))['state'], 'sent')
        channel.send.reset_mock()
        channel.permissions_for.return_value = SimpleNamespace(view_channel=True)
        self.assertEqual((await module.deliver(bot, team_job))['error'], 'private_channel_required')
        channel.send.assert_not_awaited()
        guild.fetch_member = AsyncMock(return_value=SimpleNamespace(create_dm=AsyncMock(return_value=channel)))
        dm_job = {**job, 'kind': 'publication', 'channelId': 'dm:123', 'payload': {**job['payload'], 'audience': 'individual', 'targetId': '123'}}
        self.assertEqual((await module.deliver(bot, dm_job))['state'], 'sent')
        guild.fetch_member.assert_awaited_once_with(123)
        channel.send.side_effect = discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'DM blocked')
        result = await module.deliver(bot, dm_job)
        self.assertEqual((result['state'], result['error']), ('failed', 'permissions'))

    def fixture(self):
        channel = MagicMock(spec=discord.TextChannel)
        channel.id = 22
        channel.send = AsyncMock(return_value=SimpleNamespace(id=33))
        guild = SimpleNamespace(fetch_channel=AsyncMock(return_value=channel))
        bot = SimpleNamespace(get_guild=lambda _: guild, user=SimpleNamespace(id=1))
        job = {'id': 'event1', 'workspaceId': 'w1', 'claim': 'claim', 'guildId': '11', 'channelId': '22', 'kind': 'notice', 'nonce': 'stable-nonce', 'reconcile': False, 'createdAt': 1000, 'payload': {'title': '공지', 'description': '@everyone <@123> 안내', 'course': '과정'}}
        return bot, channel, job

    async def test_send_uses_stable_nonce_and_blocks_all_mentions(self):
        bot, channel, job = self.fixture()
        result = await module.deliver(bot, job)
        self.assertEqual(result['state'], 'sent')
        self.assertEqual(result['messageId'], '33')
        options = channel.send.call_args.kwargs
        self.assertEqual(options['nonce'], 'stable-nonce')
        self.assertEqual(options['allowed_mentions'].to_dict()['parse'], [])
        self.assertEqual(options['embed'].footer.text, 'LMS:event1')

    async def test_timeout_is_uncertain_and_recovery_finds_original_message_without_resending(self):
        bot, channel, job = self.fixture()
        channel.send.side_effect = asyncio.TimeoutError()
        self.assertEqual((await module.deliver(bot, job))['state'], 'uncertain')
        async def history(**kwargs):
            yield SimpleNamespace(id=44, author=SimpleNamespace(id=1), embeds=[SimpleNamespace(footer=SimpleNamespace(text='LMS:event1'))])
        channel.history = history
        channel.send.reset_mock()
        result = await module.deliver(bot, {**job, 'reconcile': True})
        self.assertEqual(result['messageId'], '44')
        channel.send.assert_not_awaited()

    async def test_missing_evidence_and_reconciliation_permission_failures_never_become_send_retries(self):
        bot, channel, job = self.fixture()
        async def empty(**kwargs):
            if False:
                yield None
        channel.history = empty
        result = await module.deliver(bot, {**job, 'reconcile': True})
        self.assertEqual((result['state'], result['error']), ('uncertain', 'not_found'))
        async def denied(**kwargs):
            raise discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'denied')
            yield
        channel.history = denied
        self.assertEqual((await module.deliver(bot, {**job, 'reconcile': True}))['state'], 'uncertain')
        channel.send.assert_not_awaited()

    async def test_known_permission_deleted_channel_and_rate_limit_errors_are_reported(self):
        for code, expected in [(403, 'permissions'), (404, 'channel_missing'), (429, 'rate_limit'), (500, 'discord_error')]:
            bot, channel, job = self.fixture()
            error_type = {403: discord.Forbidden, 404: discord.NotFound}.get(code, discord.HTTPException)
            channel.send.side_effect = error_type(SimpleNamespace(status=code, reason='failure'), 'failure')
            result = await module.deliver(bot, job)
            self.assertEqual(result['error'], expected)
            self.assertEqual(result['state'], 'uncertain' if code == 500 else 'failed')
