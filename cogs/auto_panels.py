from workspace_context import each_workspace, guild_event
"""Restore and refresh the existing bot's declared channel dashboards."""
import asyncio
import datetime
import logging
import time

import discord
from discord.ext import commands, tasks

import config
import database
from cogs.lms_onboarding_store import OnboardingStore
from cogs.panel_messages import ensure_panel
from cogs.panel_objects import PANEL_OBJECTS

log = logging.getLogger("asanAX.auto_panels")


class AutoPanels(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.store = OnboardingStore(config.DB_PATH)
        self.locks, self.last_refresh = {}, {}

    async def cog_load(self):
        await self.store.initialize()
        self.worker.start()

    async def cog_unload(self):
        self.worker.cancel()

    async def legacy_id(self, guild, channel, kind):
        if kind == "mentoring":
            rows = await database.get_panels()
            row = next((p for p in reversed(rows) if p["guild_id"] == str(guild.id) and p["channel_id"] == str(channel.id)), None)
        else:
            row = await database.get_assignment_panel(kind)
        return row["message_id"] if row and row["channel_id"] == str(channel.id) else None

    async def resolve_channel(self, guild, kind):
        spec = PANEL_OBJECTS[kind]
        binding = await self.store.get(guild.id, "panel-channel", spec.template_id)
        # Live channels come from this workspace's web settings.
        from storage_client import client
        configured = getattr(config.current(), spec.channel_setting, 0) if client else (binding["id"] if binding else getattr(config.current(), spec.channel_setting, 0))
        channel = guild.get_channel(int(configured)) if configured else None
        if configured:
            return channel if isinstance(channel, discord.TextChannel) else None
        if kind == "mentoring":
            rows = [p for p in await database.get_panels() if p["guild_id"] == str(guild.id)]
            for row in reversed(rows):
                channel = guild.get_channel(int(row["channel_id"]))
                if isinstance(channel, discord.TextChannel):
                    return channel
        matches = [ch for ch in guild.text_channels if ch.name in spec.channel_names]
        if len(matches) > 1:
            log.warning("Automatic panel channel is ambiguous: guild=%s object=%s", guild.id, kind)
        return matches[0] if len(matches) == 1 else None

    async def bind_channels(self, guild, items, results):
        actual = {row["id"]: int(row["discordId"]) for row in results}
        changed = {}
        for spec in PANEL_OBJECTS.values():
            matches = [item for item in items if item["type"] == "text" and item["id"] == spec.template_id]
            if matches and spec.template_id in actual:
                await self.store.put(guild.id, "panel-channel", spec.template_id, {"id": actual[spec.template_id]})
                changed[spec.channel_setting] = str(actual[spec.template_id])
        from storage_client import client
        if client and changed:
            await client.request('bind-panels', {'guildId': str(guild.id), 'channels': changed})
            await client.refresh_settings(guild.id)
        if not config.managed_storage or guild.id in getattr(client, 'ready', {}):
            with config.guild_scope(guild.id):
                await self.sync_once(force=True)

    async def build(self, guild, kind, days=None):
        if kind == "dashboard":
            from cogs.assignment import build_dashboard_embeds, AdminDashboardView
            return await build_dashboard_embeds(), AdminDashboardView(self.bot)
        if kind == "submit":
            from cogs.assignment import SubmitPanelView, build_submit_embed
            return [build_submit_embed()], SubmitPanelView(self.bot)
        if kind == "mentoring":
            from ui.mentor_panel import build_panel_embed, MentorPanelView
            mentors = await database.get_mentors()
            return [await build_panel_embed(mentors)], MentorPanelView(mentors)
        if kind == "participation":
            from cogs.participation import collect_participation, build_participation_embed, ParticipationPanelView, DEFAULT_DAYS
            state = await self.store.get(guild.id, "panel-options", kind) or {}
            days = state.get("days", DEFAULT_DAYS) if days is None else days
            if days not in {0, 7, 14, 30}:
                raise ValueError("Unsupported participation period")
            after = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days) if days else None
            stats = await collect_participation(guild, after)
            await self.store.put(guild.id, "panel-options", kind, {"days": days})
            return [build_participation_embed(stats, days)], ParticipationPanelView(self.bot)
        if kind == "peer_eval":
            from cogs.peer_eval import build_panel_embed, build_roster, PeerEvalPanelView
            active = await database.get_active_peer_round()
            if not active:
                return None  # Publishing a dashboard must never start a new evaluation round.
            roster = build_roster(guild)
            evaluations = await database.get_peer_evaluations(active["id"])
            return [build_panel_embed(active, roster, evaluations)], PeerEvalPanelView(self.bot)
        raise ValueError("Unknown panel object")

    async def publish(self, kind, channel=None, force=True, days=None):
        guild = self.bot.get_guild(config.current().GUILD_ID)
        if not guild or (channel and channel.guild.id != guild.id):
            return None
        if kind not in PANEL_OBJECTS:
            raise ValueError("Unknown panel object")
        channel = channel or await self.resolve_channel(guild, kind)
        if PANEL_OBJECTS[kind].template_id == "assignment-dashboard":
            onboarding = self.bot.get_cog("LMSOnboarding")
            if not onboarding:
                raise ValueError("Staff dashboard permissions cannot be verified")
            from cogs.lms_onboarding import OnboardingError
            try:
                channel = await onboarding.ensure_dashboard(guild, channel)
            except OnboardingError as error:
                raise ValueError(f"Staff dashboard unavailable: {error}") from error
        if not channel:
            log.warning("Automatic panel channel not found: guild=%s object=%s", guild.id, kind)
            return None
        key = (guild.id, channel.id, kind)
        async with self.locks.setdefault(key, asyncio.Lock()):
            if not force and time.monotonic() - self.last_refresh.get(key, float('-inf')) < PANEL_OBJECTS[kind].refresh_seconds:
                return None
            payload = await self.build(guild, kind, days)
            if payload is None:
                self.last_refresh[key] = time.monotonic()
                return None
            embeds, view = payload
            message = await ensure_panel(channel, kind, embeds, view, self.store, await self.legacy_id(guild, channel, kind))
            self.bot.add_view(view, message_id=message.id)
            if kind == "mentoring":
                await database.upsert_panel(str(guild.id), str(channel.id), str(message.id))
            else:
                await database.save_assignment_panel(kind, str(channel.id), str(message.id))
            self.last_refresh[key] = time.monotonic()
            return message

    async def sync_once(self, force=False):
        if not self.bot.get_guild(config.current().GUILD_ID):
            return
        for kind in PANEL_OBJECTS:
            try:
                await self.publish(kind, force=force)
            except discord.Forbidden:
                log.warning("Automatic panel permission denied: object=%s; check view/send/history/embed/pin permissions", kind)
            except (discord.HTTPException, asyncio.TimeoutError, ValueError):
                log.exception("Automatic panel update failed: object=%s", kind)

    @tasks.loop(seconds=60)
    @each_workspace
    async def worker(self):
        await self.sync_once()

    @worker.before_loop
    async def before_worker(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    @guild_event
    async def on_guild_join(self, guild):
        if guild.id == config.current().GUILD_ID:
            await self.sync_once(force=True)

    @commands.Cog.listener()
    @guild_event
    async def on_guild_channel_create(self, channel):
        if channel.guild.id == config.current().GUILD_ID:
            await self.sync_once()


async def setup(bot):
    await bot.add_cog(AutoPanels(bot))
