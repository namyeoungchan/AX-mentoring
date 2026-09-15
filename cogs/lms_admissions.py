"""Issue private, single-use guild invites after LMS staff approval."""
import asyncio
import logging
import os

import aiohttp
import discord
from discord.ext import commands, tasks

from cogs.lms_provision import validate_provision_endpoint

log = logging.getLogger("asanAX.lms_admissions")


async def create_student_invite(guild):
    if not guild or not guild.me:
        raise ValueError("missing_guild")
    channels = await guild.fetch_channels()
    candidates = [channel for channel in channels if isinstance(channel, discord.TextChannel)
                  and channel.permissions_for(guild.me).create_instant_invite
                  and channel.permissions_for(guild.default_role).view_channel]
    if not candidates:
        raise ValueError("missing_invite_channel")
    invite = await candidates[0].create_invite(max_age=86400, max_uses=1, unique=True,
                                             reason="Approved LMS student admission")
    return invite.code


class LMSAdmissions(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.url = ""
        self.token = os.getenv("LEARNINGOPS_PROVISION_TOKEN", "").strip()
        self.lock = asyncio.Lock()
        self.pending_result = None
        candidate = os.getenv("LEARNINGOPS_PROVISION_URL", "").strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_provision_endpoint(candidate).rsplit("/", 1)[0] + "/admissions"
                self.worker.start()
            except ValueError:
                log.warning("LMS admission invites disabled: invalid endpoint configuration")

    async def cog_unload(self):
        self.worker.cancel()

    async def post(self, session, operation, body):
        async with session.post(f"{self.url}/{operation}", json=body,
                                headers={"Authorization": f"Bearer {self.token}"}, allow_redirects=False) as response:
            if response.status == 200:
                return await response.json()
            if operation == "complete" and response.status == 409:
                return {"expired": True}
            raise ValueError("api_error")

    async def run_once(self):
        if not self.url or self.lock.locked():
            return
        async with self.lock:
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
                    if self.pending_result:
                        await self.post(session, "complete", self.pending_result)
                        self.pending_result = None
                    response = await self.post(session, "poll", {"guildIds": [str(guild.id) for guild in self.bot.guilds[:100]]})
                    job = response.get("job")
                    if not job:
                        return
                    code = None
                    try:
                        guild = self.bot.get_guild(int(job["guildId"]))
                        code = await asyncio.wait_for(create_student_invite(guild), timeout=60)
                    except (discord.HTTPException, ValueError, asyncio.TimeoutError):
                        log.warning("LMS admission invite could not be issued")
                    self.pending_result = {"id": job["id"], "claim": job["claim"], "success": code is not None, "code": code}
                    await self.post(session, "complete", self.pending_result)
                    self.pending_result = None
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log.warning("LMS admission transport failed (%s)", type(error).__name__)

    @tasks.loop(seconds=30)
    async def worker(self):
        await self.run_once()

    @worker.before_loop
    async def before_worker(self):
        await self.bot.wait_until_ready()


async def setup(bot):
    await bot.add_cog(LMSAdmissions(bot))
