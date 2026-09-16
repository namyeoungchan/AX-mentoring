import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from discord.ui.view import ViewStore

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only'}):
    participation = importlib.import_module('cogs.participation')
    entrypoint = importlib.import_module('bot')


class BotLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_gateway_message_updates_refresh_persistent_participation_buttons(self):
        view = participation.ParticipationPanelView(MagicMock())
        store = ViewStore(MagicMock())
        store.add_view(view, message_id=77)
        payload = view.to_components()
        payload[0]['components'][0]['disabled'] = True
        with patch.object(participation, 'refresh_participation_panel', new_callable=AsyncMock) as refresh:
            store.update_from_message(77, payload)
            self.assertTrue(view.children[0].disabled)
            payload[0]['components'][0]['disabled'] = False
            store.update_from_message(77, payload)
            self.assertFalse(view.children[0].disabled)
            refresh.assert_not_awaited()
        view.stop()

    async def test_participation_controls_still_invoke_the_requested_period(self):
        view = participation.ParticipationPanelView(MagicMock())
        interaction = SimpleNamespace(response=SimpleNamespace(defer=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
        with patch.object(participation, 'refresh_participation_panel', new_callable=AsyncMock, return_value=True) as refresh:
            await view.children[1].callback(interaction)
            refresh.assert_awaited_with(view.bot, 14)
            await view.children[-1].callback(interaction)
            refresh.assert_awaited_with(view.bot, None)
        view.stop()

    async def test_missing_token_exits_with_actionable_message_before_connecting(self):
        with patch.object(entrypoint.config, 'DISCORD_TOKEN', ''), patch.object(entrypoint, 'AsanAXBot') as bot:
            with self.assertRaisesRegex(SystemExit, 'DISCORD_TOKEN'):
                await entrypoint.main()
            bot.assert_not_called()
