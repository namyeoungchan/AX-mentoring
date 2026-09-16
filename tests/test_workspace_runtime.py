import asyncio
import importlib
import inspect
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only'}):
    config = importlib.import_module('config')
    storage = importlib.import_module('storage_client')
    database = importlib.import_module('database')
    contexts = importlib.import_module('workspace_context')

GUILD_A, GUILD_B = 123456789012345678, 223456789012345678
URL = 'https://example.com/api/integrations/discord/provision'
TOKEN = 'test-only-workspace-token-' * 2


def state(guild_id, migrated=False):
    return {'guildId': str(guild_id), 'workspaceId': 'workspace-' + str(guild_id), 'migrated': migrated,
            'settings': {'channels': {'ADMIN_ROLE_ID': str(guild_id + 1), 'STUDENT_ROLE_ID': str(guild_id + 3)}, 'teams': [{'name': str(guild_id), 'channelId': str(guild_id + 2)}], 'qaNotifyRoleIds': [str(guild_id + 4)]}, 'teamMembers': {}}


class WorkspaceRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.addCleanup(patch.stopall)
        patch.object(config, 'managed_storage', True).start()
        patch.object(config, 'workspace_settings', {}).start()
        self.context_token = config.workspace_guild.set(None)
        self.addCleanup(config.workspace_guild.reset, self.context_token)
        self.router = storage.WorkspaceStorage(URL, TOKEN)
        self.router.legacy_checked = True
        patch.object(storage, 'client', self.router).start()

    def activate(self):
        for gid in (GUILD_A, GUILD_B):
            config.install_workspace(gid, state(gid))
            self.router.ready[gid] = state(gid)

    async def test_simultaneous_calls_keep_database_and_settings_in_the_invoking_guild(self):
        self.activate()
        requests = []
        entered = asyncio.Event()
        async def request(_operation, body):
            requests.append(body)
            if len(requests) == 2:
                entered.set()
            await entered.wait()
            return {'result': body['guildId']}
        with patch.object(storage.WebStorage, 'request', new=AsyncMock(side_effect=request)):
            async def call(gid):
                with config.guild_scope(gid):
                    result = await self.router.call('get_mentors', (), {})
                    self.assertEqual(config.current().ADMIN_ROLE_ID, gid + 1)
                    self.assertEqual(config.current().STUDENT_ROLE_ID, gid + 3)
                    self.assertEqual(config.current().QA_NOTIFY_ROLE_IDS, [gid + 4])
                    self.assertEqual(list(config.current().TEAM_CHANNELS), [str(gid)])
                    return result
            self.assertEqual(await asyncio.gather(call(GUILD_A), call(GUILD_B)), [str(GUILD_A), str(GUILD_B)])
        self.assertEqual({row['guildId'] for row in requests}, {str(GUILD_A), str(GUILD_B)})
        self.assertIsNone(config.workspace_guild.get())
        with self.assertRaises(storage.StorageUnavailable):
            await self.router.call('add_mentor', (), {})

    async def test_discovery_accepts_new_workspaces_without_import_and_handles_added_removed_guilds(self):
        request = AsyncMock(side_effect=[{'workspaces': [state(GUILD_A)]}, {'workspaces': [state(GUILD_A), state(GUILD_B)]}, {'workspaces': [state(GUILD_B)]}])
        self.router.request = request
        await self.router.refresh([GUILD_A, GUILD_B])
        self.assertEqual(set(self.router.ready), {GUILD_A})
        await self.router.refresh([GUILD_A, GUILD_B])
        self.assertEqual(set(self.router.ready), {GUILD_A, GUILD_B})
        await self.router.refresh([GUILD_B])
        self.assertEqual(set(self.router.ready), {GUILD_B})
        with config.guild_scope(GUILD_A), self.assertRaises(storage.StorageUnavailable):
            await self.router.call('get_mentors', (), {})
        self.assertTrue(all(call.args[0] == 'registry' for call in request.call_args_list))

    async def test_http_403_suspends_storage_and_recovers_on_next_discovery(self):
        self.activate()
        self.router.request = AsyncMock(side_effect=storage.StorageUnavailable('HTTP 403'))
        with self.assertRaises(storage.StorageUnavailable):
            await self.router.refresh([GUILD_A, GUILD_B])
        self.assertEqual(self.router.ready, {})
        self.router.request = AsyncMock(return_value={'workspaces': [state(GUILD_A)]})
        await self.router.refresh([GUILD_A])
        self.assertEqual(set(self.router.ready), {GUILD_A})

    async def test_panels_use_workspace_channels_even_when_legacy_environment_has_another_id(self):
        from cogs.auto_panels import AutoPanels
        self.activate()
        cog = AutoPanels(SimpleNamespace())
        cog.store.get = AsyncMock(return_value=None)
        with patch.object(config, 'MENTORING_CHANNEL_ID', 999456789012345678):
            for gid in (GUILD_A, GUILD_B):
                value = state(gid)
                value['settings']['channels']['MENTORING_CHANNEL_ID'] = str(gid + 5)
                config.install_workspace(gid, value)
                channel = MagicMock(spec=contexts.discord.TextChannel)
                guild = SimpleNamespace(id=gid, get_channel=lambda channel_id: channel if channel_id == gid + 5 else None, text_channels=[])
                with config.guild_scope(gid):
                    self.assertIs(await cog.resolve_channel(guild, 'mentoring'), channel)

    async def test_failed_legacy_import_does_not_copy_data_to_or_block_another_workspace(self):
        self.router.legacy_guild_id = GUILD_A
        async def request(operation, body):
            if operation == 'registry':
                return {'workspaces': [state(GUILD_A), state(GUILD_B)]}
            self.assertEqual(operation, 'bootstrap')
            self.assertEqual(body['guildId'], str(GUILD_A))
            raise storage.StorageUnavailable('HTTP 409')
        self.router.request = AsyncMock(side_effect=request)
        with patch.object(storage, 'export_archive', new=AsyncMock(return_value={'guildId': str(GUILD_A)})) as export:
            await self.router.refresh([GUILD_A, GUILD_B])
            export.assert_awaited_once_with(config.DB_PATH, GUILD_A)
        self.assertEqual(set(self.router.ready), {GUILD_B})

    async def test_buttons_and_dm_modals_keep_their_originating_workspace(self):
        self.activate()
        def interaction(gid):
            return SimpleNamespace(guild_id=gid, type=contexts.discord.InteractionType.component,
                                   response=SimpleNamespace(send_message=AsyncMock()))
        with config.guild_scope(GUILD_A):
            view = contexts.WorkspaceView()
            modal = contexts.WorkspaceModal(title='test')
        self.assertTrue(await view.interaction_check(interaction(None)))
        self.assertEqual(config.current().GUILD_ID, GUILD_A)
        self.assertFalse(await view.interaction_check(interaction(GUILD_B)))
        self.assertTrue(await modal.interaction_check(interaction(GUILD_A)))
        config.workspace_guild.set(None)
        common = contexts.WorkspaceView()
        self.assertTrue(await common.interaction_check(interaction(GUILD_B)))
        self.assertEqual(config.current().GUILD_ID, GUILD_B)
        self.router.ready = {}
        self.assertFalse(await modal.interaction_check(interaction(GUILD_A)))

    async def test_background_job_failure_is_isolated_to_its_guild(self):
        self.activate()
        seen = []
        class Cog:
            bot = SimpleNamespace(get_guild=lambda gid: SimpleNamespace(id=gid))
            @contexts.each_workspace
            async def work(self):
                seen.append(config.current().GUILD_ID)
                if config.current().GUILD_ID == GUILD_A:
                    raise storage.StorageUnavailable('first failed')
        await Cog().work()
        self.assertEqual(seen, [GUILD_A, GUILD_B])
        self.assertIsNone(config.workspace_guild.get())

    async def test_setup_does_not_request_web_storage_or_require_a_fixed_guild(self):
        bot_module = importlib.import_module('bot')
        originals = {name: fn for name, fn in inspect.getmembers(database, inspect.iscoroutinefunction)}
        with tempfile.TemporaryDirectory() as folder, patch.multiple(database, **originals), \
                patch.object(config, 'DB_PATH', os.path.join(folder, 'bot.db')), \
                patch.object(database, 'DB_PATH', os.path.join(folder, 'bot.db')), \
                patch.object(config, 'GUILD_ID', 0), \
                patch.dict(os.environ, {'LEARNINGOPS_PROVISION_URL': URL, 'LEARNINGOPS_PROVISION_TOKEN': TOKEN}), \
                patch.object(storage.WebStorage, 'request', new=AsyncMock(side_effect=AssertionError('startup used network'))) as request:
            async with bot_module.AsanAXBot() as bot:
                await asyncio.wait_for(bot.setup_hook(), timeout=3)
                self.assertIsNotNone(bot.get_cog('WorkspaceRuntime'))
                self.assertIsNotNone(bot.get_cog('Assignment'))
                self.assertIsNotNone(bot.get_cog('LMSProvision'))
                request.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
