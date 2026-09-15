"""Optional outbound, read-only LearningOps snapshot publisher for Render workers."""
import asyncio
import logging
import math
import os
from datetime import datetime, timezone
from urllib.parse import urlsplit

import aiohttp
import aiosqlite
from discord.ext import commands, tasks

import config

log = logging.getLogger("asanAX.learningops")
TABLE_LIMIT = 1000


async def read_snapshot(db_path: str) -> dict:
    """Read one consistent snapshot without modifying the bot's database."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA query_only=ON")
        await db.execute("BEGIN")
        queries = {
            "mentors": "SELECT id,name,discord_id,bio FROM mentors ORDER BY id DESC LIMIT ?",
            "bookings": """SELECT b.id,b.user_name,b.status,s.label,s.start_time,s.end_time,
                           m.name AS mentor_name FROM bookings b JOIN slots s ON b.slot_id=s.id
                           JOIN mentors m ON s.mentor_id=m.id ORDER BY b.id DESC LIMIT ?""",
            "assignments": """SELECT a.id,a.week,a.title,a.due_date,a.type,a.is_active,
                              (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id=a.id) AS submitted
                              FROM assignments a ORDER BY a.id DESC LIMIT ?""",
            "submissions": """SELECT s.id,s.assignment_id,s.user_name,s.team,s.content,s.link,s.submitted_at,
                              a.title AS assignment_title FROM submissions s JOIN assignments a
                              ON s.assignment_id=a.id ORDER BY s.id DESC LIMIT ?""",
        }
        result = {}
        for key, query in queries.items():
            async with db.execute(query, (TABLE_LIMIT,)) as cursor:
                result[key] = [dict(row) for row in await cursor.fetchall()]
        counts = {}
        for table in ("mentors", "bookings", "assignments", "submissions", "onboarding_progress"):
            async with db.execute(f"SELECT COUNT(*) FROM {table}") as cursor:
                counts[table] = (await cursor.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM bookings WHERE status='pending'") as cursor:
            counts["pending_bookings"] = (await cursor.fetchone())[0]
        result["counts"] = counts
        result["rowLimit"] = TABLE_LIMIT
        return result


def validate_endpoint(url: str) -> str:
    parsed = urlsplit(url)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("LEARNINGOPS_SYNC_URL must be an endpoint URL without credentials, query or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("LEARNINGOPS_SYNC_URL requires HTTPS (HTTP is allowed only on localhost)")
    if parsed.path != "/api/integrations/render/snapshot":
        raise ValueError("LEARNINGOPS_SYNC_URL path must be /api/integrations/render/snapshot")
    return url


class LearningOpsSync(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.url = validate_endpoint(os.environ["LEARNINGOPS_SYNC_URL"].strip())
        self.token = os.environ["LEARNINGOPS_SYNC_TOKEN"].strip()
        if len(self.token) < 32:
            raise ValueError("LEARNINGOPS_SYNC_TOKEN must contain at least 32 characters")
        self.interval = max(30, min(120, int(os.getenv("LEARNINGOPS_SYNC_INTERVAL", "60"))))
        self.publish.change_interval(seconds=self.interval)
        self.publish.start()

    async def cog_unload(self):
        self.publish.cancel()

    @tasks.loop(seconds=60)
    async def publish(self):
        try:
            # A reconnect does not create another publisher task.
            from storage_client import client
            snapshot = await client.request('snapshot', {'guildId': str(config.GUILD_ID)}) if client else await read_snapshot(config.DB_PATH)
            guild = self.bot.get_guild(config.GUILD_ID)
            latency = self.bot.latency
            snapshot.update({
                # The API routes by the bound Discord guild. No per-workspace bot setting.
                "name": os.getenv("LEARNINGOPS_SOURCE_NAME", "아산 AX"),
                "capturedAt": datetime.now(timezone.utc).isoformat(),
                "bot": {
                    "name": str(self.bot.user) if self.bot.user else "asanAX",
                    "ready": self.bot.is_ready(),
                    "latencyMs": round(latency * 1000) if math.isfinite(latency) else None,
                    "guildId": str(config.GUILD_ID),
                    "guildName": guild.name if guild else None,
                    "memberCount": guild.member_count if guild else None,
                },
            })
            timeout = aiohttp.ClientTimeout(total=20)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(self.url, json=snapshot,
                                        headers={"Authorization": f"Bearer {self.token}"},
                                        allow_redirects=False) as response:
                    if response.status != 200:
                        # Neither tokens, URLs nor private server response bodies enter logs.
                        log.warning("LearningOps snapshot rejected (HTTP %s)", response.status)
                    else:
                        log.info("LearningOps snapshot published")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            log.warning("LearningOps snapshot failed (%s); retrying next interval", type(error).__name__)

    @publish.before_loop
    async def before_publish(self):
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot):
    await bot.add_cog(LearningOpsSync(bot))
