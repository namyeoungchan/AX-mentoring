"""Apply web-managed channel templates through outbound requests from the bot."""
import asyncio
import logging
import os
from urllib.parse import urlsplit

import aiohttp
import discord
from discord.ext import commands, tasks
from cogs.lms_guides import ensure_guide, guide_text

log = logging.getLogger("asanAX.lms_provision")


class ProvisionError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def worker_status(bot):
    """The one Render worker reports every server it has joined."""
    return {"bot": {"id": str(bot.user.id), "name": str(bot.user), "ready": bot.is_ready()},
            "guilds": [{"id": str(guild.id), "name": guild.name,
                        "manageChannels": bool(guild.me and guild.me.guild_permissions.manage_channels),
                        "memberCount": guild.member_count} for guild in bot.guilds]}


def validate_provision_endpoint(url: str) -> str:
    parsed = urlsplit(url)
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path != "/api/integrations/discord/provision"
            or (parsed.scheme != "https" and not local_http)):
        raise ValueError("Invalid LEARNINGOPS_PROVISION_URL")
    return url


async def apply_channels(guild, items: list[dict], results: list[dict]) -> None:
    """Create missing channels only; preserve existing channels and permission overwrites."""
    if not guild.me or not guild.me.guild_permissions.manage_channels:
        raise ProvisionError("forbidden")
    types = {"category": discord.ChannelType.category, "text": discord.ChannelType.text, "voice": discord.ChannelType.voice}
    ids = [item.get("id") for item in items]
    categories = {item.get("id") for item in items if item.get("type") == "category"}
    if (not 1 <= len(items) <= 30 or len(set(ids)) != len(ids)
            or any(item.get("type") not in types or not item.get("name")
                   or (item.get("parentId") and item["parentId"] not in categories)
                   or (item["type"] == "category" and item.get("parentId")) for item in items)):
        raise ProvisionError("conflict")
    channels = list(await guild.fetch_channels())
    parents = {}
    ordered = [item for item in items if item["type"] == "category"] + [item for item in items if item["type"] != "category"]
    for item in ordered:
        parent = parents.get(item.get("parentId", ""))
        parent_id = parent.id if parent else None
        matches = [channel for channel in channels
                   if channel.type == types[item["type"]] and channel.name == item["name"]
                   and (item["type"] == "category" or channel.category_id == parent_id)]
        if len(matches) > 1:
            raise ProvisionError("conflict")
        if matches:
            target, action = matches[0], "reused"
        else:
            reason = "LMS channel template requested by workspace administrator"
            if item["type"] == "category":
                target = await guild.create_category(item["name"], reason=reason)
            elif item["type"] == "text":
                target = await guild.create_text_channel(item["name"], category=parent, reason=reason)
            else:
                target = await guild.create_voice_channel(item["name"], category=parent, reason=reason)
            channels.append(target)
            action = "created"
        if item["type"] == "category":
            parents[item["id"]] = target
        results.append({"id": item["id"], "discordId": str(target.id), "action": action})
        if item["type"] == "text":
            await ensure_guide(target, guide_text(item))


class LMSProvision(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.url = ""
        self.token = os.getenv("LEARNINGOPS_PROVISION_TOKEN", "").strip()
        self.lock = asyncio.Lock()
        self.pending_result = None
        candidate = os.getenv("LEARNINGOPS_PROVISION_URL", "").strip()
        if not candidate or len(self.token) < 32:
            log.warning("LMS provisioning disabled: set LEARNINGOPS_PROVISION_URL and a token of at least 32 characters on the bot service")
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_provision_endpoint(candidate)
                self.worker.start()
                self.heartbeat.start()
            except ValueError:
                log.warning("LMS channel provisioning disabled: invalid endpoint configuration")

    async def cog_unload(self):
        self.worker.cancel()
        self.heartbeat.cancel()

    async def post(self, session, operation, body):
        async with session.post(f"{self.url}/{operation}", json=body,
                                headers={"Authorization": f"Bearer {self.token}"}, allow_redirects=False) as response:
            if response.status == 200:
                return await response.json()
            if operation == "complete" and response.status == 409:
                return {"expired": True}
            log.warning("LMS provisioning %s rejected (HTTP %s)", operation, response.status)
            raise ProvisionError("api_error")

    async def run_once(self):
        if not self.url or self.lock.locked():
            return
        async with self.lock:
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
                    if self.pending_result:
                        await self.post(session, "complete", self.pending_result)
                        self.pending_result = None
                    response = await self.post(session, "poll", worker_status(self.bot))
                    job = response.get("job")
                    if not job:
                        return
                    results = []
                    error_code = None
                    guild = self.bot.get_guild(int(job["plan"]["guildId"]))
                    try:
                        if not guild:
                            raise ProvisionError("missing_guild")
                        await asyncio.wait_for(apply_channels(guild, job["plan"]["channels"], results), timeout=180)
                    except ProvisionError as error:
                        error_code = error.code
                    except discord.Forbidden:
                        error_code = "forbidden"
                    except asyncio.TimeoutError:
                        error_code = "timeout"
                    except discord.HTTPException:
                        error_code = "api_error"
                    self.pending_result = {"id": job["id"], "claim": job["claim"], "success": error_code is None,
                                           "errorCode": error_code, "results": results}
                    await self.post(session, "complete", self.pending_result)
                    self.pending_result = None
                    log.info("LMS channel job finished (%s)", error_code or "success")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log.warning("LMS channel job transport failed (%s)", type(error).__name__)

    @tasks.loop(seconds=30)
    async def worker(self):
        await self.run_once()

    @worker.before_loop
    async def before_worker(self):
        await self.bot.wait_until_ready()

    @tasks.loop(seconds=30)
    async def heartbeat(self):
        # Channel creation can take minutes; status delivery must stay independent.
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
                await self.post(session, "heartbeat", worker_status(self.bot))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning("LMS bot status delivery failed (%s)", type(error).__name__)

    @heartbeat.before_loop
    async def before_heartbeat(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_guild_join(self, _guild):
        await self.run_once()


async def setup(bot: commands.Bot):
    await bot.add_cog(LMSProvision(bot))
