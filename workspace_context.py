"""Bind Discord commands, components, events and timers to a workspace."""
import functools
import logging

import discord
from discord import app_commands
import config

log = logging.getLogger('asanAX.workspace')


def ready_guild_ids(bot):
    from storage_client import client
    if config.managed_storage:
        return [gid for gid in getattr(client, 'ready', {}) if bot.get_guild(gid)]
    return [config.GUILD_ID] if config.GUILD_ID and bot.get_guild(config.GUILD_ID) else []


async def enter_interaction(interaction, bound_guild_id=None):
    guild_id = interaction.guild_id or bound_guild_id
    if bound_guild_id and interaction.guild_id and interaction.guild_id != bound_guild_id:
        message = '이 버튼은 다른 워크스페이스의 작업입니다.'
    else:
        from storage_client import client
        if guild_id and (not config.managed_storage or int(guild_id) in getattr(client, 'ready', {})):
            config.workspace_guild.set(int(guild_id))
            return True
        message = '이 서버의 웹 워크스페이스 연결을 준비 중입니다. 웹의 Discord 서버 연결을 확인한 뒤 다시 시도하세요.'
    if interaction.type == discord.InteractionType.autocomplete:
        await interaction.response.autocomplete([])
    else:
        await interaction.response.send_message(message, ephemeral=True)
    return False


class WorkspaceTree(app_commands.CommandTree):
    async def interaction_check(self, interaction):
        # Identity proof has its own web authorization and must remain available during import.
        if (interaction.data or {}).get('name') == 'lms인증':
            return True
        return await enter_interaction(interaction)


class WorkspaceView(discord.ui.View):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.workspace_guild_id = config.workspace_guild.get()

    async def interaction_check(self, interaction):
        return await enter_interaction(interaction, self.workspace_guild_id)


class WorkspaceModal(discord.ui.Modal):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.workspace_guild_id = config.workspace_guild.get()

    async def interaction_check(self, interaction):
        return await enter_interaction(interaction, self.workspace_guild_id)


def guild_event(callback):
    """Legacy event handlers only operate on a ready, explicitly bound guild."""
    @functools.wraps(callback)
    async def wrapped(self, event, *args, **kwargs):
        guild = getattr(event, 'guild', None) or event
        guild_id = getattr(guild, 'id', None)
        if guild_id not in ready_guild_ids(self.bot):
            return
        with config.guild_scope(guild_id):
            return await callback(self, event, *args, **kwargs)
    return wrapped


def each_workspace(callback):
    """A failed workspace does not abort another workspace's scheduled work."""
    @functools.wraps(callback)
    async def wrapped(self, *args, **kwargs):
        for guild_id in ready_guild_ids(self.bot):
            with config.guild_scope(guild_id):
                try:
                    await callback(self, *args, **kwargs)
                except Exception as error:
                    log.warning('Workspace job %s failed for guild %s (%s)', callback.__name__, guild_id, type(error).__name__)
    return wrapped
