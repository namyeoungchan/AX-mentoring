import asyncio
import importlib
import inspect
import json
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

    async def test_assignment_modal_refreshes_its_guild_and_saves_with_current_team(self):
        from cogs import assignment
        self.activate()
        user_id = 333456789012345678
        calls, saved, replies = [], {}, {}

        async def request(operation, body):
            calls.append((operation, body))
            await asyncio.sleep(0)
            if operation == 'status':
                value = state(int(body['guildId']))
                value['teamMembers'] = {str(user_id): 'current-' + body['guildId']}
                return value
            self.assertEqual(operation, 'call')
            self.assertEqual(body['operation'], 'create_submission')
            saved[body['guildId']] = storage.decode(body['kwargs'])
            return {'result': True}

        async def submit(gid, kind):
            with config.guild_scope(gid):
                modal = assignment.DynamicSubmitModal(SimpleNamespace(), {'id': 1, 'week': 1, 'title': 'Test', 'type': kind}, 'old-team')
                modal._field_inputs[0]._value = 'saved content'
                modal._link_input._value = 'https://example.com/work'
                interaction = SimpleNamespace(guild_id=gid, type=contexts.discord.InteractionType.modal_submit,
                    user=SimpleNamespace(id=user_id, display_name='Student'),
                    response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
                self.assertTrue(await modal.interaction_check(interaction))
                await modal.on_submit(interaction)
                replies[gid] = interaction.followup.send.call_args.kwargs['embed'].title

        with patch.object(storage.WebStorage, 'request', new=AsyncMock(side_effect=request)), \
                patch.object(database, 'create_submission', new=AsyncMock()) as create, \
                patch.object(assignment, 'refresh_dashboard', new=AsyncMock()) as dashboard:
            async def remote(**kwargs):
                return await self.router.call('create_submission', (), kwargs)
            create.side_effect = remote
            await asyncio.gather(submit(GUILD_A, 'team'), submit(GUILD_B, 'individual'))
            self.assertEqual(dashboard.await_count, 2)
        self.assertEqual({b['guildId'] for op, b in calls if op == 'status'}, {str(GUILD_A), str(GUILD_B)})
        self.assertEqual(saved[str(GUILD_A)]['team'], 'current-' + str(GUILD_A))
        self.assertEqual(saved[str(GUILD_B)]['team'], '개인')
        for row in saved.values():
            self.assertEqual(row['user_id'], str(user_id))
            self.assertEqual(list(json.loads(row['content']).values()), ['saved content'])
            self.assertEqual(row['link'], 'https://example.com/work')
        self.assertTrue(all('제출 완료' in title for title in replies.values()))

    async def test_assignment_modal_rejects_removed_members_and_reports_storage_failures(self):
        from cogs import assignment
        self.activate()
        user_id = 333456789012345678
        for failure in ('removed', 'refresh', 'save', 'duplicate'):
            with self.subTest(failure=failure), config.guild_scope(GUILD_A):
                value = state(GUILD_A)
                value['teamMembers'] = {} if failure == 'removed' else {str(user_id): 'Team 1'}
                status = AsyncMock(return_value=value, side_effect=storage.StorageUnavailable('unavailable') if failure == 'refresh' else None)
                create = AsyncMock(return_value=False, side_effect=storage.StorageUnavailable('unavailable') if failure == 'save' else None)
                modal = assignment.DynamicSubmitModal(SimpleNamespace(), {'id': 1, 'week': 1, 'title': 'Test', 'type': 'team'}, 'old-team')
                interaction = SimpleNamespace(user=SimpleNamespace(id=user_id, display_name='Student'),
                    response=SimpleNamespace(defer=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
                with patch.object(self.router, 'request', status), patch.object(database, 'create_submission', create), \
                        patch.object(assignment, 'refresh_dashboard', new=AsyncMock()) as dashboard:
                    await modal.on_submit(interaction)
                    status.assert_awaited_once_with('status', {'guildId': str(GUILD_A)})
                    if failure in ('removed', 'refresh'):
                        create.assert_not_awaited()
                    else:
                        create.assert_awaited_once()
                    dashboard.assert_not_awaited()
                reply = interaction.followup.send.call_args
                if failure == 'duplicate':
                    self.assertIn('이미 제출', reply.kwargs['embed'].title)
                else:
                    self.assertIn({'removed': '승인', 'refresh': '시작하지 못했습니다', 'save': '결과를 확인하지 못했습니다'}[failure], reply.args[0])

    async def test_assignment_creation_automatically_passes_the_only_course_before_reporting_success(self):
        from cogs import assignment
        self.activate()
        value = state(GUILD_A)
        value['assignmentCourses'] = [{'id': 'course-a', 'title': 'Course A'}]
        config.install_workspace(GUILD_A, value)
        interaction = SimpleNamespace(response=SimpleNamespace(send_modal=AsyncMock(), defer=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
        with config.guild_scope(GUILD_A):
            await assignment.start_assignment_creation(SimpleNamespace(), interaction, 'individual')
            modal = interaction.response.send_modal.call_args.args[0]
            self.assertEqual(modal.course['id'], 'course-a')
            modal.week_input._value = '1'
            modal.title_input._value = 'New assignment'
            modal.due_date_input._value = '2099-10-01'
            with patch.object(database, 'create_assignment', new=AsyncMock(return_value=12)) as create, patch.object(assignment, 'refresh_dashboard', new=AsyncMock()):
                await modal.on_submit(interaction)
                self.assertEqual(create.call_args.kwargs['course_id'], 'course-a')
                self.assertEqual(create.call_args.kwargs['type_'], 'individual')
                interaction.response.defer.assert_awaited_once_with(ephemeral=True)
                self.assertIn('대상 자동 연결', interaction.followup.send.call_args.kwargs['embed'].description)

    async def test_assignment_creation_selects_multiple_courses_and_never_defaults_to_another_course(self):
        from cogs import assignment
        self.activate()
        value = state(GUILD_A)
        value['assignmentCourses'] = [{'id': f'c{i}', 'title': f'Course {i}'} for i in range(26)]
        config.install_workspace(GUILD_A, value)
        interaction = SimpleNamespace(response=SimpleNamespace(send_modal=AsyncMock(), send_message=AsyncMock(), edit_message=AsyncMock()), data={'values':['c25']})
        with config.guild_scope(GUILD_A):
            await assignment.start_assignment_creation(SimpleNamespace(), interaction, 'team')
            interaction.response.send_modal.assert_not_awaited()
            view = interaction.response.send_message.call_args.kwargs['view']
            self.assertEqual(len(view.children[0].options),25)
            await view.next(interaction)
            last = interaction.response.edit_message.call_args.kwargs['view']
            self.assertEqual([o.value for o in last.children[0].options],['c25'])
            await last.choose(interaction)
            self.assertEqual(interaction.response.send_modal.call_args.args[0].course['id'],'c25')
            self.assertEqual(last.workspace_guild_id,GUILD_A)

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
