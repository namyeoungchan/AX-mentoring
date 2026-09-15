import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
import discord
from cogs.lms_guides import ensure_guide


async def items(values):
    for value in values:
        yield value


class GuideTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_owned_pin_is_updated_without_touching_human_messages(self):
        embed = discord.Embed(description='old').set_footer(text='learningops:guide:123')
        human = SimpleNamespace(author=SimpleNamespace(id=8), embeds=[embed], edit=AsyncMock())
        owned = SimpleNamespace(author=SimpleNamespace(id=9), embeds=[embed], edit=AsyncMock(), pinned=True, pin=AsyncMock())
        channel = SimpleNamespace(id=123, name='공지', guild=SimpleNamespace(me=SimpleNamespace(id=9)), pins=lambda **_: items([human, owned]), send=AsyncMock())
        await ensure_guide(channel, '새 공지 안내')
        owned.edit.assert_awaited_once()
        human.edit.assert_not_awaited()
        channel.send.assert_not_awaited()
        owned.pin.assert_not_awaited()

    async def test_unpinned_message_is_recovered_after_partial_failure(self):
        embed = discord.Embed(description='old').set_footer(text='learningops:guide:123')
        owned = SimpleNamespace(author=SimpleNamespace(id=9), embeds=[embed], edit=AsyncMock(), pinned=False, pin=AsyncMock())
        channel = SimpleNamespace(id=123, name='공지', guild=SimpleNamespace(me=SimpleNamespace(id=9)), pins=lambda **_: items([]), history=lambda **_: items([owned]), send=AsyncMock())
        await ensure_guide(channel, '새 안내')
        owned.pin.assert_awaited_once()
        channel.send.assert_not_awaited()
