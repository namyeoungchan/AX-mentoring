"""Verify LMS registration from the invoking Discord member's identity."""
import asyncio
import logging
import os
import re
from urllib.parse import urlsplit

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

import config

log = logging.getLogger("asanAX.lms_auth")

MESSAGES = {
    200: "LMS 가입 인증이 완료됐습니다. 웹에서 아이디와 비밀번호로 로그인해 주세요.",
    403: "연결된 Discord 계정과 인증을 진행하는 서버를 확인해 주세요.",
    409: "이미 가입된 아이디 또는 Discord 계정입니다. 기존 계정으로 로그인해 주세요.",
    410: "사용했거나 만료된 코드입니다. 웹에서 인증 코드를 다시 발급받아 주세요.",
    429: "인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
}


class VerificationView(discord.ui.View):
    def __init__(self, cog, code, member_id, guild_id):
        super().__init__(timeout=120)
        self.cog = cog
        self.code = code
        self.member_id = member_id
        self.guild_id = guild_id

    @discord.ui.button(label="내 계정 가입 인증", style=discord.ButtonStyle.success)
    async def confirm(self, interaction: discord.Interaction, _button: discord.ui.Button):
        if interaction.user.id != self.member_id or interaction.guild_id != self.guild_id:
            await interaction.response.send_message("본인의 가입 요청만 인증할 수 있습니다.", ephemeral=True)
            return
        self.stop()
        await interaction.response.edit_message(content="가입 인증 처리 중…", view=None)
        status, _ = await self.cog.api_request(self.code, self.member_id, self.guild_id, "verify")
        await interaction.edit_original_response(content=MESSAGES.get(status, "가입 인증을 처리하지 못했습니다. 웹에서 인증 상태를 확인한 후 다시 시도해 주세요."), view=None)


def validate_auth_endpoint(url: str) -> str:
    parsed = urlsplit(url)
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path != "/api/integrations/discord/verify"
            or (parsed.scheme != "https" and not local_http)):
        raise ValueError("Invalid LEARNINGOPS_AUTH_URL")
    return url


class LMSAuth(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.url = ""
        self.synced_guilds = set()
        self.token = os.getenv("LEARNINGOPS_AUTH_TOKEN", "").strip()
        candidate = os.getenv("LEARNINGOPS_AUTH_URL", "").strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_auth_endpoint(candidate)
            except ValueError:
                # Never log URLs, credentials, codes, or private response bodies.
                log.warning("LMS verification disabled: invalid endpoint configuration")

    async def api_request(self, code, member_id, guild_id, operation):
        try:
            url = self.url.rsplit("/", 1)[0] + "/" + operation
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
                async with session.post(url, json={"code": code, "discordId": str(member_id), "guildId": str(guild_id)},
                                        headers={"Authorization": f"Bearer {self.token}"}, allow_redirects=False) as response:
                    if response.status == 200:
                        return response.status, await response.json()
                    log.warning("LMS verification rejected (HTTP %s)", response.status)
                    return response.status, None
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            return 503, None

    @app_commands.command(name="lms인증", description="웹에서 발급받은 코드로 본인의 LMS 회원가입을 인증합니다.")
    @app_commands.describe(코드="LMS 회원가입 화면에 표시된 본인의 일회용 코드")
    @app_commands.guild_only()
    @app_commands.checks.cooldown(5, 60, key=lambda interaction: interaction.user.id)
    async def verify_registration(self, interaction: discord.Interaction, 코드: str):
        if interaction.guild_id is None:
            await interaction.response.send_message("가입 인증이 허용된 Discord 서버에서 실행해 주세요.", ephemeral=True)
            return
        if not self.url:
            await interaction.response.send_message("LMS 가입 인증이 아직 준비되지 않았습니다. 운영자에게 문의해 주세요.", ephemeral=True)
            return
        code = 코드.strip().upper().replace("-", "")
        if not re.fullmatch(r"[A-F0-9]{16}", code):
            await interaction.response.send_message("웹 회원가입 화면의 인증 코드를 그대로 입력해 주세요.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        status, data = await self.api_request(code, interaction.user.id, interaction.guild_id, "preview")
        if status != 200 or not isinstance(data, dict) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{3,31}", data.get("username", "")):
            message = MESSAGES.get(status) if status != 200 else None
            await interaction.followup.send(message or "LMS에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.", ephemeral=True)
            return
        message = f"LMS 아이디: `{data['username']}`\n본인이 웹에서 직접 만든 계정인지 확인한 후 인증해 주세요. 다른 사람이 보내준 코드는 인증하지 마세요."
        await interaction.followup.send(message, view=VerificationView(self, code, interaction.user.id, interaction.guild_id),
                                        ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

    async def sync_verification(self, guild):
        if getattr(self.bot, 'manages_workspace_commands', False) or not self.url or guild.id in self.synced_guilds:
            return
        try:
            target = discord.Object(id=guild.id)
            self.bot.tree.add_command(self.verify_registration, guild=target, override=True)
            await self.bot.tree.sync(guild=target)
            self.synced_guilds.add(guild.id)
        except discord.HTTPException:
            log.warning("LMS verification command synchronization failed")

    @commands.Cog.listener()
    async def on_ready(self):
        for guild in self.bot.guilds:
            await self.sync_verification(guild)

    @commands.Cog.listener()
    async def on_guild_join(self, guild):
        await self.sync_verification(guild)


async def setup(bot: commands.Bot):
    await bot.add_cog(LMSAuth(bot))
