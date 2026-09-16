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
        self.assertTrue(private[roles['instructor']].view_channel)
        self.assertNotIn(roles['student'], private)
        self.assertNotIn(roles['pending'], private)

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
        self.cog.configs['123'] = {'enabled': True, 'participants': [{'discordId': '7', 'teamId': 't1'}], 'teams': [{'id': 't1', 'name': '1팀'}]}
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
