import unittest
from types import SimpleNamespace

import discord
from cogs.lms_provision import apply_channels, ProvisionError, validate_provision_endpoint


class Guild:
    def __init__(self, allowed=True):
        self.me = SimpleNamespace(guild_permissions=SimpleNamespace(manage_channels=allowed))
        self.channels = []
        self.created = 0

    async def fetch_channels(self):
        return list(self.channels)

    def create(self, name, channel_type, category=None):
        self.created += 1
        channel = SimpleNamespace(id=223456789012345678 + self.created, name=name, type=channel_type, category_id=category.id if category else None)
        self.channels.append(channel)
        return channel

    async def create_category(self, name, **_kwargs):
        return self.create(name, discord.ChannelType.category)

    async def create_text_channel(self, name, category=None, **_kwargs):
        return self.create(name, discord.ChannelType.text, category)

    async def create_voice_channel(self, name, category=None, **_kwargs):
        return self.create(name, discord.ChannelType.voice, category)


class ProvisionTests(unittest.IsolatedAsyncioTestCase):
    def items(self):
        return [{"id": "t", "name": "공지", "type": "text", "parentId": "c"},
                {"id": "c", "name": "학습", "type": "category", "parentId": ""},
                {"id": "v", "name": "멘토링", "type": "voice", "parentId": "c"}]

    async def test_creates_categories_first_and_reuses_channels_on_retry(self):
        guild = Guild()
        results = []
        await apply_channels(guild, self.items(), results)
        self.assertEqual(guild.created, 3)
        self.assertEqual(results[0]["id"], "c")
        self.assertEqual(guild.channels[1].category_id, guild.channels[0].id)
        again = []
        await apply_channels(guild, self.items(), again)
        self.assertEqual(guild.created, 3)
        self.assertTrue(all(item["action"] == "reused" for item in again))

    async def test_missing_permission_or_ambiguous_category_fails_without_creating(self):
        guild = Guild(allowed=False)
        with self.assertRaises(ProvisionError) as raised:
            await apply_channels(guild, self.items(), [])
        self.assertEqual(raised.exception.code, "forbidden")
        self.assertEqual(guild.created, 0)
        guild = Guild()
        guild.create("학습", discord.ChannelType.category)
        guild.create("학습", discord.ChannelType.category)
        with self.assertRaises(ProvisionError) as raised:
            await apply_channels(guild, self.items(), [])
        self.assertEqual(raised.exception.code, "conflict")
        self.assertEqual(guild.created, 2)

    async def test_unrelated_channels_remain_and_invalid_parent_is_rejected(self):
        guild = Guild()
        unrelated = guild.create("기존-채널", discord.ChannelType.text)
        await apply_channels(guild, self.items(), [])
        self.assertIn(unrelated, guild.channels)
        invalid = self.items()
        invalid[0]["parentId"] = "missing"
        with self.assertRaises(ProvisionError):
            await apply_channels(guild, invalid, [])

    def test_endpoint_rejects_untrusted_url_shapes(self):
        for value in ["http://example.com/api/integrations/discord/provision", "https://user:pass@example.com/api/integrations/discord/provision", "https://example.com/other"]:
            with self.assertRaises(ValueError):
                validate_provision_endpoint(value)


if __name__ == "__main__":
    unittest.main()
