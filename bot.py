import asyncio
import logging
import os

import discord
from discord.ext import commands

import config
import database
from workspace_context import WorkspaceTree

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("asanAX")

COGS = [
    "cogs.workspace_runtime",
    "cogs.error_handler",
    "cogs.booking",
    "cogs.admin",
    "cogs.mentor",
    "cogs.reminder",
    "cogs.lms_onboarding",
    "cogs.onboarding",
    "cogs.qa",
    "cogs.assignment",
    "cogs.participation",
    "cogs.peer_eval",
    "cogs.lms_auth",
    "cogs.lms_attendance",
    "cogs.lms_provision",
    "cogs.lms_admissions",
    "cogs.lms_outbox",
    "cogs.auto_panels",
]


class AsanAXBot(commands.Bot):
    def __init__(self) -> None:
        intents = discord.Intents.default()
        intents.members = True          # on_member_join (onboarding)
        intents.message_content = True  # on_message (self-intro detection)
        super().__init__(command_prefix="!", intents=intents, tree_cls=WorkspaceTree)
        self.manages_workspace_commands = True

    async def setup_hook(self) -> None:
        db_dir = os.path.dirname(config.DB_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        await database.init_db()
        log.info("Database initialised at %s", config.DB_PATH)
        from storage_client import connect_web_storage
        await connect_web_storage()

        for cog in COGS:
            await self.load_extension(cog)
            log.info("Loaded cog: %s", cog)

        # Optional outbound sync; a configuration error must not stop the bot.
        if os.getenv("LEARNINGOPS_SYNC_URL") and os.getenv("LEARNINGOPS_SYNC_TOKEN"):
            try:
                await self.load_extension("cogs.learningops_sync")
            except Exception:
                log.error("LearningOps sync could not start; check LEARNINGOPS_* settings")

    async def on_ready(self) -> None:
        log.info("Logged in as %s (ID: %s)", self.user, self.user.id)  # type: ignore[union-attr]

    async def close(self) -> None:
        try:
            await super().close()
        finally:
            from storage_client import client
            if client:
                await client.close()


async def main() -> None:
    if not config.DISCORD_TOKEN:
        raise SystemExit(
            "DISCORD_TOKEN이 설정되지 않았습니다. Render에서 실제 운영 중인 봇 서비스의 "
            "Environment에 DISCORD_TOKEN을 설정하고 다시 배포하세요. "
            "웹 서비스의 환경변수는 봇 서비스에 자동 전달되지 않습니다."
        )
    bot = AsanAXBot()
    async with bot:
        await bot.start(config.DISCORD_TOKEN)


if __name__ == "__main__":
    asyncio.run(main())
