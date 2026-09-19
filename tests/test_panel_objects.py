import importlib
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import discord

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678', 'ADMIN_ROLE_ID': '123456789012345679', 'ONBOARDING_CHANNEL_ID': '123456789012345680', 'INTRO_CHANNEL_ID': '123456789012345681'}):
    module = importlib.import_module('cogs.auto_panels')
from cogs.panel_messages import ensure_panel
from cogs.lms_onboarding_store import OnboardingStore


async def stream(values):
    for value in values:
        yield value


class PanelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = OnboardingStore(os.path.join(self.directory.name, 'bot.db'))
        await self.store.initialize()
        self.guild = SimpleNamespace(id=module.config.GUILD_ID, me=SimpleNamespace(id=9))
        self.message = SimpleNamespace(id=77, author=SimpleNamespace(id=9), embeds=[], pinned=False, edit=AsyncMock(), pin=AsyncMock())
        self.channel = SimpleNamespace(id=11, guild=self.guild, send=AsyncMock(return_value=self.message), fetch_message=AsyncMock(return_value=self.message), pins=lambda **_: stream([]), history=lambda **_: stream([]))

    async def test_existing_dashboard_is_adopted_and_pin_failure_does_not_create_duplicates(self):
        denied = discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'Pin permission')
        self.message.pin.side_effect = [denied, None]
        with self.assertRaises(discord.Forbidden):
            await ensure_panel(self.channel, 'dashboard', [discord.Embed(title='현황')], None, self.store, '77')
        await ensure_panel(self.channel, 'dashboard', [discord.Embed(title='갱신')], None, self.store)
        self.channel.send.assert_not_awaited()
        self.assertEqual(self.message.edit.await_count, 2)
        self.assertEqual(self.message.pin.await_count, 2)

    async def test_missing_message_recreated_and_human_message_never_edited(self):
        self.channel.fetch_message.return_value = SimpleNamespace(author=SimpleNamespace(id=8))
        await ensure_panel(self.channel, 'submit', [discord.Embed(title='제출')], None, self.store, '99')
        self.channel.send.assert_awaited_once()
        self.message.edit.assert_not_awaited()
        reopened = OnboardingStore(self.store.path)
        self.assertEqual((await reopened.get(self.guild.id, 'panel', 'submit:11'))['messageId'], 77)

    async def test_old_and_new_footer_markers_recover_owned_panels_without_duplicates(self):
        for footer in (f'learningops:panel:{self.guild.id}:submit', 'AX LearningOps · 과제 제출 · 자동 갱신'):
            store = SimpleNamespace(get=AsyncMock(return_value=None), put=AsyncMock())
            self.message.embeds = [discord.Embed(title='기존 패널').set_footer(text=footer)]
            self.channel.pins = lambda **_: stream([self.message])
            await ensure_panel(self.channel, 'submit', [discord.Embed(title='새 패널')], None, store)
            self.channel.send.assert_not_awaited()
            self.assertNotIn('learningops:panel:', self.message.edit.call_args.kwargs['embeds'][0].footer.text)

    async def test_one_failed_panel_does_not_stop_other_declared_objects(self):
        bot = MagicMock()
        cog = module.AutoPanels(bot)
        cog.publish = AsyncMock(side_effect=[discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'missing'), *([None] * (len(module.PANEL_OBJECTS) - 1))])
        await cog.sync_once()
        self.assertEqual(cog.publish.await_count, len(module.PANEL_OBJECTS))

    async def test_other_workspace_cannot_receive_primary_bot_panels(self):
        cog = module.AutoPanels(MagicMock(get_guild=MagicMock(return_value=self.guild)))
        other = SimpleNamespace(guild=SimpleNamespace(id=self.guild.id + 1))
        cog.build = AsyncMock()
        self.assertIsNone(await cog.publish('dashboard', channel=other))
        cog.build.assert_not_awaited()

    async def test_concurrent_refreshes_share_one_persisted_message(self):
        import asyncio
        cog = module.AutoPanels(MagicMock(get_guild=MagicMock(return_value=self.guild)))
        cog.store = self.store
        cog.bot.get_cog.return_value = SimpleNamespace(ensure_dashboard=AsyncMock(return_value=self.channel))
        cog.legacy_id = AsyncMock(return_value=None)
        cog.build = AsyncMock(return_value=([discord.Embed(title='과제')], MagicMock()))
        with patch.object(module.database, 'save_assignment_panel', new_callable=AsyncMock):
            await asyncio.gather(cog.publish('dashboard', self.channel), cog.publish('dashboard', self.channel))
        self.channel.send.assert_awaited_once()
        self.message.edit.assert_awaited_once()

    async def test_no_active_evaluation_does_not_create_a_round_or_post_a_panel(self):
        cog = module.AutoPanels(MagicMock())
        with patch.object(module.database, 'get_active_peer_round', new_callable=AsyncMock, return_value=None):
            self.assertIsNone(await cog.build(self.guild, 'peer_eval'))

    async def test_private_panels_are_never_built_if_channel_permissions_cannot_be_repaired(self):
        from cogs.lms_onboarding import OnboardingError
        cog = module.AutoPanels(MagicMock(get_guild=MagicMock(return_value=self.guild)))
        cog.bot.get_cog.return_value = SimpleNamespace(ensure_dashboard=AsyncMock(side_effect=OnboardingError('permissions')))
        cog.build = AsyncMock()
        for kind in ['dashboard', 'participation', 'peer_eval']:
            with self.assertRaisesRegex(ValueError, 'Staff dashboard unavailable'):
                await cog.publish(kind, self.channel)
        cog.build.assert_not_awaited()
        self.channel.send.assert_not_awaited()

    async def test_missing_dashboard_is_repaired_before_publication(self):
        cog = module.AutoPanels(MagicMock(get_guild=MagicMock(return_value=self.guild)))
        cog.store = self.store
        cog.resolve_channel = AsyncMock(return_value=None)
        repair = AsyncMock(return_value=self.channel)
        cog.bot.get_cog.return_value = SimpleNamespace(ensure_dashboard=repair)
        cog.build = AsyncMock(return_value=([discord.Embed(title='과제 현황')], MagicMock()))
        cog.legacy_id = AsyncMock(return_value=None)
        with patch.object(module.database, 'save_assignment_panel', new_callable=AsyncMock):
            await cog.publish('dashboard')
        repair.assert_awaited_once_with(self.guild, None)
        self.channel.send.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
