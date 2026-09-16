import importlib
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import discord
from cogs.lms_onboarding_store import OnboardingStore

with patch.dict(os.environ, {"DISCORD_TOKEN": "test-only", "GUILD_ID": "123456789012345678", "ADMIN_ROLE_ID": "1", "ONBOARDING_CHANNEL_ID": "2", "INTRO_CHANNEL_ID": "3"}):
    module = importlib.import_module("cogs.lms_onboarding")


class Role:
    def __init__(self, role_id, name="role", permissions=0):
        self.id, self.name, self.managed = role_id, name, False
        self.permissions = discord.Permissions(permissions)

    def __lt__(self, other):
        return self.id < other.id

    def __ge__(self, other):
        return self.id >= other.id


class OnboardingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = OnboardingStore(os.path.join(self.directory.name, 'bot.db'))
        await self.store.initialize()
        with patch.dict(os.environ, {"LEARNINGOPS_PROVISION_URL": "", "LEARNINGOPS_PROVISION_TOKEN": ""}):
            self.cog = module.LMSOnboarding(MagicMock())
        self.cog.store = self.store

    async def test_state_is_isolated_by_guild_and_persists_after_restart(self):
        await self.store.put(1, "member", 7, {"introDone": True})
        reopened = OnboardingStore(self.store.path)
        self.assertTrue((await reopened.get(1, "member", 7))["introDone"])
        self.assertIsNone(await reopened.get(2, "member", 7))

    async def test_base_roles_are_created_without_enabled_onboarding_and_reused_per_guild(self):
        for gid in [123, 456]:
            roles = {}
            async def create_role(name, **_):
                role = Role(len(roles) + 1, name)
                roles[role.id] = role
                return role
            guild = SimpleNamespace(id=gid, get_role=roles.get, create_role=AsyncMock(side_effect=create_role),
                                    me=SimpleNamespace(top_role=Role(100), guild_permissions=SimpleNamespace(manage_roles=True)))
            self.assertEqual(self.cog.configs, {})
            first = await self.cog.provision_roles(guild)
            again = await self.cog.provision_roles(guild)
            self.assertEqual(set(first), set(module.ROLE_NAMES))
            self.assertEqual(first, again)
            self.assertEqual(guild.create_role.await_count, 5)
            saved = await self.store.all(gid, 'role')
            self.assertEqual(len(saved), 5)
            self.assertTrue(all(role.permissions.value == 0 for role in first.values()))

    async def test_base_roles_require_manage_roles_even_if_channels_are_allowed(self):
        guild = SimpleNamespace(id=123, me=SimpleNamespace(guild_permissions=SimpleNamespace(manage_roles=False)), create_role=AsyncMock())
        with self.assertRaisesRegex(module.OnboardingError, 'permissions'):
            await self.cog.provision_roles(guild)
        guild.create_role.assert_not_awaited()

    def test_only_verified_web_assignment_and_intro_completion_unlock_student_team_roles(self):
        student = {"role": "student", "teamId": "team-2"}
        self.assertEqual(module.desired_roles(None, True), {"pending"})
        self.assertEqual(module.desired_roles(student, False), {"pending"})
        self.assertEqual(module.desired_roles(student, True), {"student", "complete", "team:team-2"})
        self.assertEqual(module.desired_roles({"role": "instructor"}, False), {"instructor"})

    async def test_team_transfer_removes_old_managed_role_and_keeps_unrelated_roles(self):
        roles = {i: Role(i) for i in range(1, 8)}
        mapping = {"pending": 1, "student": 2, "complete": 3, "team:old": 4, "team:new": 5}
        for key, role_id in mapping.items():
            await self.store.put(123, "role", key, {"id": role_id})
        await self.store.put(123, "member", 7, {"introDone": True, "welcomed": True, "reported": True})
        member = SimpleNamespace(id=7, bot=False, nick=None, roles=[roles[2], roles[3], roles[4], roles[6]], add_roles=AsyncMock(), remove_roles=AsyncMock())
        member.guild = SimpleNamespace(id=123, get_role=roles.get, me=SimpleNamespace(top_role=Role(100), guild_permissions=SimpleNamespace(manage_nicknames=False)))
        cfg = {"participants": [{"discordId": "7", "name": "학생", "role": "student", "teamId": "new"}], "teams": [{"id": "new", "name": "새 팀"}]}
        await self.cog.sync_member(member, cfg)
        self.assertEqual([role.id for role in member.remove_roles.call_args.args], [4])
        self.assertEqual([role.id for role in member.add_roles.call_args.args], [5])
        member.remove_roles.reset_mock()
        member.add_roles.reset_mock()
        await self.cog.sync_member(member, {"participants": [], "teams": []})
        self.assertEqual({role.id for role in member.remove_roles.call_args.args}, {2, 3, 4})
        self.assertEqual([role.id for role in member.add_roles.call_args.args], [1])

    async def test_an_existing_role_with_admin_permissions_is_never_granted(self):
        dangerous = Role(1, permissions=discord.Permissions(administrator=True).value)
        await self.store.put(123, "role", "pending", {"id": 1})
        member = SimpleNamespace(id=7, bot=False, roles=[], add_roles=AsyncMock())
        member.guild = SimpleNamespace(id=123, get_role=lambda _: dangerous, me=SimpleNamespace(top_role=Role(100)))
        with self.assertRaisesRegex(module.OnboardingError, "role_hierarchy"):
            await self.cog.sync_member(member, {"participants": [], "teams": []})
        member.add_roles.assert_not_awaited()

    async def test_mentor_gets_nickname_without_intro_or_student_welcome(self):
        instructor = Role(3)
        await self.store.put(123, "role", "instructor", {"id": 3})
        member = SimpleNamespace(id=7, bot=False, nick=None, top_role=instructor, roles=[instructor], edit=AsyncMock(), send=AsyncMock())
        member.guild = SimpleNamespace(id=123, owner_id=99, get_role=lambda _: instructor,
                                       me=SimpleNamespace(top_role=Role(100), guild_permissions=SimpleNamespace(manage_nicknames=True)))
        cfg = {"participants": [{"discordId": "7", "role": "instructor", "name": "홍길동", "teamIds": []}], "teams": []}
        await self.cog.sync_member(member, cfg)
        self.assertEqual(member.edit.call_args.kwargs["nick"], "멘토_홍길동")
        member.send.assert_not_awaited()
        self.assertFalse((await self.store.get(123, "member", 7))["introDone"])
        member.nick = "멘토_홍길동"
        member.edit.reset_mock()
        await self.cog.sync_member(member, cfg)
        member.edit.assert_not_awaited()
        member.nick = None
        member.guild.me.guild_permissions.manage_nicknames = False
        with self.assertRaisesRegex(module.OnboardingError, "permissions"):
            await self.cog.sync_member(member, cfg)
        member.guild.me.guild_permissions.manage_nicknames = True
        member.guild.owner_id = member.id
        with self.assertRaisesRegex(module.OnboardingError, "role_hierarchy"):
            await self.cog.sync_member(member, cfg)

    async def test_mentor_never_opens_or_posts_a_student_introduction(self):
        self.cog.configs['123'] = {"enabled": True, "participants": [{"discordId": "7", "role": "instructor"}]}
        response = SimpleNamespace(send_message=AsyncMock(), send_modal=AsyncMock())
        await module.StartView(self.cog, 123).start(SimpleNamespace(user=SimpleNamespace(id=7), response=response))
        response.send_modal.assert_not_awaited()
        self.assertIn("자기소개가 필요 없습니다", response.send_message.call_args.args[0])
        member = SimpleNamespace(id=7)
        guild = SimpleNamespace(get_member=lambda _: member, get_channel=MagicMock())
        self.cog.bot.get_guild.return_value = guild
        self.cog.refresh = AsyncMock()
        self.cog.ensure_resources = AsyncMock()
        self.cog.sync_member = AsyncMock()
        result = await self.cog.submit_intro(123, 7, "이전 모달", "작성하지 않아도 됨")
        self.assertIn("자기소개가 필요 없습니다", result)
        guild.get_channel.assert_not_called()
        self.assertIsNone(await self.store.get(123, "member", 7))

    async def test_dashboard_is_private_on_creation_and_repairs_existing_grants_without_duplicates(self):
        everyone, bot, admin, instructor, student = [Role(i) for i in [0, 100, 1, 2, 3]]
        bot.guild_permissions = SimpleNamespace(manage_channels=True)
        self.cog.ensure_roles = AsyncMock(return_value={"admin": admin, "instructor": instructor})
        channels = []
        async def create(name, **kwargs):
            channel = SimpleNamespace(id=11, name=name, type=discord.ChannelType.text, overwrites=kwargs['overwrites'])
            async def edit(**changes):
                for key, value in changes.items():
                    if key != 'reason': setattr(channel, key, value)
                return channel
            channel.edit = AsyncMock(side_effect=edit)
            channels.append(channel)
            return channel
        guild = SimpleNamespace(id=123, me=bot, default_role=everyone, fetch_channels=AsyncMock(side_effect=lambda: list(channels)), create_text_channel=AsyncMock(side_effect=create))
        channel = await self.cog.ensure_dashboard(guild)
        first = guild.create_text_channel.call_args.kwargs['overwrites']
        self.assertFalse(first[everyone].view_channel)
        self.assertTrue(first[bot].view_channel)
        self.assertTrue(first[admin].view_channel)
        self.assertTrue(first[instructor].view_channel)
        self.assertNotIn(student, first)
        channel.overwrites = {everyone: discord.PermissionOverwrite(view_channel=True), student: discord.PermissionOverwrite(view_channel=True)}
        self.assertIs(await self.cog.ensure_dashboard(guild), channel)
        self.assertFalse(channel.overwrites[everyone].view_channel)
        self.assertNotIn(student, channel.overwrites)
        guild.create_text_channel.assert_awaited_once()
        self.assertEqual((await self.store.get(123, 'panel-channel', 'assignment-dashboard'))['id'], channel.id)
        await self.cog.ensure_dashboard(guild)
        channel.edit.assert_awaited_once()

    async def test_team_channels_are_private_to_assigned_team_and_staff(self):
        everyone, bot = Role(0), Role(100)
        bot.guild_permissions = SimpleNamespace(manage_channels=True, manage_roles=True, view_channel=True, send_messages=True, read_message_history=True, embed_links=True, pin_messages=True)
        guild = SimpleNamespace(id=123, me=bot, default_role=everyone, text_channels=[])
        roles = {key: Role(i + 1) for i, key in enumerate([*module.ROLE_NAMES, "team:t1"])}
        async def role(_guild, key, _name):
            return roles[key]
        async def channel(_guild, key, _name, _type, *args, **kwargs):
            return SimpleNamespace(id=hash(key), overwrites_for=lambda _: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True))
        self.cog.role = AsyncMock(side_effect=role)
        self.cog.channel = AsyncMock(side_effect=channel)
        cfg = {"revision": "r1", "onboardingChannel": "start", "introChannel": "intro", "welcomeText": "안내", "teams": [{"id": "t1", "name": "1팀"}], "channels": []}
        with patch.object(module, "ensure_guide", new_callable=AsyncMock):
            await self.cog.ensure_resources(guild, cfg)
        private = next(call for call in self.cog.channel.call_args_list if call.args[1] == 'team-category:t1').args[4]
        self.assertFalse(private[everyone].view_channel)
        self.assertTrue(private[roles['team:t1']].view_channel)
        self.assertTrue(private[roles['admin']].view_channel)
        self.assertNotIn(roles['instructor'], private)
        self.assertNotIn(roles['student'], private)
        self.assertNotIn(roles['pending'], private)

    async def test_mentor_reassignment_replaces_team_access_without_granting_admin(self):
        old = module.desired_roles({"role": "instructor", "teamIds": ["t1"]}, False)
        new = module.desired_roles({"role": "instructor", "teamIds": ["t2", "t3"]}, False)
        self.assertEqual(old, {"instructor", "team:t1"})
        self.assertEqual(new, {"instructor", "team:t2", "team:t3"})
        self.assertNotIn("admin", new)

    async def test_dm_blocked_uses_the_onboarding_channel_and_does_not_repeat(self):
        roles = {1: Role(1)}
        await self.store.put(123, "role", "pending", {"id": 1})
        await self.store.put(123, "channel", "start", {"id": 11})
        fallback = SimpleNamespace(send=AsyncMock())
        denied = discord.Forbidden(SimpleNamespace(status=403, reason='Forbidden'), 'DM blocked')
        member = SimpleNamespace(id=7, bot=False, roles=[roles[1]], mention='<@7>', send=AsyncMock(side_effect=denied))
        member.guild = SimpleNamespace(id=123, get_role=roles.get, get_channel=lambda _: fallback, me=SimpleNamespace(top_role=Role(100)))
        cfg = {"participants": [], "teams": [], "workspaceName": "교육", "welcomeText": "시작 안내"}
        await self.cog.sync_member(member, cfg)
        await self.cog.sync_member(member, cfg)
        member.send.assert_awaited_once()
        fallback.send.assert_awaited_once()

    async def test_server_join_starts_onboarding_without_a_command(self):
        self.cog.url = 'https://test.example/api/integrations/discord/onboarding'
        self.cog.configs['123'] = {'guildId': '123', 'enabled': True}
        self.cog.refresh = AsyncMock()
        self.cog.ensure_resources = AsyncMock()
        self.cog.sync_member = AsyncMock()
        member = SimpleNamespace(bot=False, guild=SimpleNamespace(id=123))
        await self.cog.on_member_join(member)
        self.cog.refresh.assert_awaited_once_with([123])
        self.cog.sync_member.assert_awaited_once_with(member, self.cog.configs['123'])

    async def test_intro_retry_keeps_one_post_and_retries_role_completion(self):
        channel = SimpleNamespace(send=AsyncMock())
        member = SimpleNamespace(id=7)
        guild = SimpleNamespace(get_member=lambda _: member, get_channel=lambda _: channel)
        self.cog.bot.get_guild.return_value = guild
        self.cog.configs['123'] = {'enabled': True, 'participants': [{'discordId': '7', 'teamId': 't1', 'role': 'student'}], 'teams': [{'id': 't1', 'name': '1팀'}]}
        self.cog.refresh = AsyncMock()
        self.cog.ensure_resources = AsyncMock()
        self.cog.sync_member = AsyncMock(side_effect=[module.OnboardingError('permissions'), None])
        await self.store.put(123, 'channel', 'intro', {'id': 11})
        with self.assertRaises(module.OnboardingError):
            await self.cog.submit_intro(123, 7, '학생', '자기소개입니다.')
        result = await self.cog.submit_intro(123, 7, '학생', '자기소개입니다.')
        self.assertIn('1팀', result)
        channel.send.assert_awaited_once()
        self.assertEqual(self.cog.sync_member.await_count, 2)


if __name__ == '__main__':
    unittest.main()
