"""Discover server/workspace bindings without holding up the Discord gateway."""
import logging
import discord
from discord.ext import commands, tasks
import config
import database
import storage_client
from ui.mentor_panel import MentorPanelView

log = logging.getLogger('asanAX.workspace')


class WorkspaceRuntime(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.synced = set()
        self.restored = set()
        self.global_synced = False

    async def cog_load(self):
        self.discover.start()
        self.sync_commands.start()

    async def cog_unload(self):
        self.discover.cancel()
        self.sync_commands.cancel()

    @tasks.loop(seconds=30)
    async def discover(self):
        try:
            await storage_client.client.refresh([guild.id for guild in self.bot.guilds])
        except Exception as error:
            reason = str(error) if isinstance(error, storage_client.StorageUnavailable) else type(error).__name__
            log.warning('Workspace discovery pending (%s); Discord remains connected', reason)
            return
        for guild_id in list(storage_client.client.ready):
            if guild_id in self.restored:
                continue
            with config.guild_scope(guild_id):
                try:
                    mentors = await database.get_mentors()
                    for panel in await database.get_panels():
                        if int(panel['guild_id']) == guild_id:
                            self.bot.add_view(MentorPanelView(mentors), message_id=int(panel['message_id']))
                    self.restored.add(guild_id)
                    log.info('Workspace ready for guild %s', guild_id)
                except Exception as error:
                    log.warning('Workspace panel restoration pending for guild %s (%s)', guild_id, type(error).__name__)

    @tasks.loop(seconds=60)
    async def sync_commands(self):
        if config.SYNC_GLOBALLY and not self.global_synced:
            try:
                await self.bot.tree.sync()
                self.global_synced = True
            except discord.HTTPException:
                log.warning('Global command sync pending')
        for guild in self.bot.guilds:
            if guild.id in self.synced:
                continue
            try:
                target = discord.Object(id=guild.id)
                self.bot.tree.copy_global_to(guild=target)
                await self.bot.tree.sync(guild=target)
                self.synced.add(guild.id)
            except discord.HTTPException:
                log.warning('Command sync pending for guild %s', guild.id)

    @discover.before_loop
    async def before_discover(self):
        await self.bot.wait_until_ready()

    @sync_commands.before_loop
    async def before_sync_commands(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_guild_remove(self, guild):
        self.synced.discard(guild.id)
        self.restored.discard(guild.id)
        storage_client.client.ready.pop(guild.id, None)


async def setup(bot):
    await bot.add_cog(WorkspaceRuntime(bot))
