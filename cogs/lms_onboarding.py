"""Guild-scoped onboarding and team reconciliation driven by the LMS."""
import asyncio
import logging
import os
import time

import discord
from discord.ext import commands, tasks

import config
from cogs.lms_guides import ensure_guide, guide_text, GUIDES
from cogs.lms_onboarding_store import OnboardingStore
from cogs.lms_provision import validate_provision_endpoint

log = logging.getLogger("asanAX.lms_onboarding")
ROLE_NAMES = {"pending": "LMS 온보딩 대기", "student": "LMS 수강생", "instructor": "LMS 강사", "admin": "LMS 운영자", "complete": "LMS 온보딩 완료"}


class OnboardingError(Exception):
    pass


def desired_roles(participant, intro_done):
    if not participant:
        return {"pending"}
    if participant["role"] in {"admin", "instructor"}:
        return {participant["role"]}
    if not intro_done:
        return {"pending"}
    return {"student", "complete"} | ({f"team:{participant['teamId']}"} if participant.get("teamId") else set())


class StartView(discord.ui.View):
    def __init__(self, cog, guild_id):
        super().__init__(timeout=None)
        self.cog, self.guild_id = cog, int(guild_id)
        button = discord.ui.Button(label="자기소개 작성", style=discord.ButtonStyle.primary, custom_id=f"lms:onboarding:{guild_id}")
        button.callback = self.start
        self.add_item(button)

    async def start(self, interaction):
        cfg = self.cog.configs.get(str(self.guild_id))
        if not cfg or not cfg.get("enabled"):
            await interaction.response.send_message("온보딩이 아직 준비되지 않았습니다. 운영자에게 문의하세요.", ephemeral=True)
            return
        await interaction.response.send_modal(Introduction(self.cog, self.guild_id))


class Introduction(discord.ui.Modal, title="자기소개 작성"):
    name = discord.ui.TextInput(label="이름", max_length=30)
    introduction = discord.ui.TextInput(label="자기소개", style=discord.TextStyle.paragraph, max_length=1000, placeholder="현재 하는 일과 배우고 싶은 내용을 적어 주세요.")

    def __init__(self, cog, guild_id):
        super().__init__()
        self.cog, self.guild_id = cog, guild_id

    async def on_submit(self, interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            result = await self.cog.submit_intro(self.guild_id, interaction.user.id, self.name.value.strip(), self.introduction.value.strip())
            await interaction.followup.send(result, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
            await interaction.followup.send("처리하지 못했습니다. 잠시 후 다시 누르거나 운영자에게 봇 권한과 연결 상태 확인을 요청하세요.", ephemeral=True)
            log.warning("LMS introduction could not finish for guild %s", self.guild_id)


class LMSOnboarding(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.store = OnboardingStore(config.DB_PATH)
        self.configs, self.locks, self.views, self.resources_checked = {}, {}, {}, {}
        self.token = os.getenv("LEARNINGOPS_PROVISION_TOKEN", "").strip()
        self.url = ""
        candidate = os.getenv("LEARNINGOPS_PROVISION_URL", "").strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_provision_endpoint(candidate).rsplit("/", 1)[0] + "/onboarding"
            except ValueError:
                log.warning("LMS onboarding disabled: invalid LEARNINGOPS_PROVISION_URL")
        else:
            log.warning("LMS onboarding disabled: set the provision URL and token on the bot service")

    async def cog_load(self):
        await self.store.initialize()
        # Web configuration is polled after gateway readiness. A web outage must
        # not block setup_hook and prevent the common bot from connecting.
        if not config.managed_storage:
            self.configs = await self.store.all("0", "config")
        for guild_id in self.configs:
            self.view(guild_id)
        if self.url:
            self.worker.start()

    async def cog_unload(self):
        self.worker.cancel()

    def view(self, guild_id):
        key = str(guild_id)
        if key not in self.views:
            self.views[key] = StartView(self, key)
            self.bot.add_view(self.views[key])
        return self.views[key]

    def lock(self, guild_id):
        return self.locks.setdefault(str(guild_id), asyncio.Lock())

    async def request(self, operation, body):
        if not self.url:
            raise OnboardingError("api_error")
        import aiohttp
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
                async with session.post(f"{self.url}/{operation}", json=body, headers={"Authorization": f"Bearer {self.token}"}, allow_redirects=False) as response:
                    if response.status != 200:
                        log.warning("LMS onboarding %s rejected (HTTP %s)", operation, response.status)
                        raise OnboardingError("api_error")
                    return await response.json()
        except aiohttp.ClientError as error:
            raise OnboardingError("api_error") from error

    async def refresh(self, guild_ids):
        result = await self.request("poll", {"guildIds": [str(value) for value in guild_ids]})
        received = {value["guildId"]: value for value in result["configs"]}
        for guild_id in guild_ids:
            key = str(guild_id)
            if key in received:
                self.configs[key] = received[key]
                await self.store.put("0", "config", key, received[key])
                self.view(key)
            elif key in self.configs:
                self.configs[key] = {"guildId": key, "enabled": False}
                await self.store.put("0", "config", key, self.configs[key])

    async def owns_guild(self, guild_id):
        if not self.url:
            return str(guild_id) in self.configs
        if str(guild_id) not in self.configs:
            try:
                await self.refresh([guild_id])
            except (OnboardingError, asyncio.TimeoutError):
                return True  # Do not fall back to self-selected roles when LMS authority is unavailable.
        return str(guild_id) in self.configs

    async def role(self, guild, key, name):
        stored = await self.store.get(guild.id, "role", key)
        role = guild.get_role(stored["id"]) if stored else None
        if role is None:
            # Never adopt an existing privileged role merely because its name matches.
            role = await guild.create_role(name=name[:100], permissions=discord.Permissions.none(), reason="LMS managed role")
            await self.store.put(guild.id, "role", key, {"id": role.id})
        if role.managed or role >= guild.me.top_role or role.permissions.value != 0:
            raise OnboardingError("role_hierarchy")
        if role.name != name[:100]:
            role = await role.edit(name=name[:100], reason="LMS team name changed")
        return role

    async def ensure_roles(self, guild):
        if not guild.me or not guild.me.guild_permissions.manage_roles:
            raise OnboardingError("permissions")
        return {key: await self.role(guild, key, name) for key, name in ROLE_NAMES.items()}

    async def provision_roles(self, guild):
        # Building a server always creates its base roles. Granting membership
        # and team access still requires the separately enabled onboarding flow.
        async with self.lock(guild.id):
            roles = await self.ensure_roles(guild)
            log.info("LMS base roles ready for guild %s (%s roles)", guild.id, len(roles))
            return roles

    async def channel(self, guild, key, name, channel_type, overwrites=None, category=None, adopt=False):
        stored = await self.store.get(guild.id, "channel", key)
        channel = guild.get_channel(stored["id"]) if stored else None
        if channel is None and adopt:
            matches = [item for item in guild.text_channels if item.name == name]
            if len(matches) > 1:
                raise OnboardingError("conflict")
            channel = matches[0] if matches else None
        if channel is None:
            kwargs = {"reason": "LMS onboarding and teams"}
            if overwrites is not None:
                kwargs["overwrites"] = overwrites
            if category is not None:
                kwargs["category"] = category
            create = {"text": guild.create_text_channel, "voice": guild.create_voice_channel, "category": guild.create_category}[channel_type]
            channel = await create(name[:100], **kwargs)
        if channel.type != {"text": discord.ChannelType.text, "voice": discord.ChannelType.voice, "category": discord.ChannelType.category}[channel_type]:
            raise OnboardingError("conflict")
        await self.store.put(guild.id, "channel", key, {"id": channel.id})
        # Only managed team channels receive private permission overwrites; adopted general channels keep theirs.
        changes = {}
        if channel.name != name[:100]:
            changes["name"] = name[:100]
        if overwrites is not None and channel.overwrites != overwrites:
            changes["overwrites"] = overwrites
        if category is not None and channel.category_id != category.id:
            changes["category"] = category
        if changes:
            channel = await channel.edit(**changes, reason="LMS team configuration")
        return channel

    async def ensure_resources(self, guild, cfg):
        if cfg.get("error"):
            raise OnboardingError(cfg["error"])
        permissions = guild.me.guild_permissions if guild.me else None
        if not permissions or not all([permissions.manage_channels, permissions.manage_roles, permissions.view_channel, permissions.send_messages, permissions.read_message_history, permissions.embed_links, permissions.pin_messages]):
            raise OnboardingError("permissions")
        last = self.resources_checked.get(str(guild.id))
        if last and last[0] == cfg["revision"] and time.monotonic() - last[1] < 300:
            return
        roles = await self.ensure_roles(guild)
        start = await self.channel(guild, "start", cfg["onboardingChannel"], "text", adopt=True)
        intro = await self.channel(guild, "intro", cfg["introChannel"], "text", adopt=True)
        for channel in [start, intro]:
            for role in roles.values():
                overwrite = channel.overwrites_for(role)
                if overwrite.view_channel is not True or overwrite.send_messages is not True or overwrite.read_message_history is not True:
                    overwrite.update(view_channel=True, send_messages=True, read_message_history=True)
                    await channel.set_permissions(role, overwrite=overwrite, reason="LMS onboarding channel access")
        await ensure_guide(start, cfg["welcomeText"], self.view(guild.id))
        await ensure_guide(intro, GUIDES["intro"])
        for team in cfg["teams"]:
            team_role = await self.role(guild, f"team:{team['id']}", f"LMS 팀 · {team['name']}")
            allowed = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, connect=True, speak=True)
            overwrites = {guild.default_role: discord.PermissionOverwrite(view_channel=False), guild.me: allowed, roles["admin"]: allowed, roles["instructor"]: allowed, team_role: allowed}
            category = await self.channel(guild, f"team-category:{team['id']}", f"팀 · {team['name']}", "category", overwrites)
            chat = await self.channel(guild, f"team-text:{team['id']}", "팀-대화", "text", overwrites, category)
            await self.channel(guild, f"team-voice:{team['id']}", "팀 회의", "voice", overwrites, category)
            await ensure_guide(chat, f"{team['name']} 협업 공간\n" + GUIDES["team-text"])
        for item in cfg.get("channels", []):
            if item["type"] != "text":
                continue
            matches = [channel for channel in guild.text_channels if channel.name == item["name"]]
            if len(matches) == 1 and matches[0].id not in {start.id, intro.id}:
                await ensure_guide(matches[0], guide_text(item))
        self.resources_checked[str(guild.id)] = (cfg["revision"], time.monotonic())

    async def sync_member(self, member, cfg, welcome=True):
        if member.bot:
            return
        record = await self.store.get(member.guild.id, "member", member.id) or {"introDone": False, "welcomed": False}
        participant = next((person for person in cfg["participants"] if person["discordId"] == str(member.id)), None)
        desired = desired_roles(participant, record["introDone"])
        mappings = await self.store.all(member.guild.id, "role")
        wanted = {mappings[key]["id"] for key in desired if key in mappings}
        managed = {value["id"] for value in mappings.values()}
        old = {role.id for role in member.roles}
        # Revoke old team access first. Never modify roles outside our persisted registry.
        remove = [role for role in member.roles if role.id in managed and role.id not in wanted]
        add = [member.guild.get_role(role_id) for role_id in wanted - old]
        if any(role is None for role in add):
            self.resources_checked.pop(str(member.guild.id), None)
            raise OnboardingError("conflict")
        if any(role.permissions.value != 0 or role.managed or role >= member.guild.me.top_role for role in add):
            raise OnboardingError("role_hierarchy")
        if remove:
            await member.remove_roles(*remove, reason="LMS membership or team changed")
        if add:
            await member.add_roles(*add, reason="LMS onboarding and web team assignment")
        if record["introDone"] and participant:
            team = next((team for team in cfg["teams"] if team["id"] == participant.get("teamId")), None)
            nick = (participant["name"] + (f"_{team['name']}" if team else ""))[:32]
            if member.nick != nick and member.guild.me.guild_permissions.manage_nicknames and member.top_role < member.guild.me.top_role and member.id != member.guild.owner_id:
                await member.edit(nick=nick, reason="LMS web team assignment")
        if welcome and not record["welcomed"] and (not participant or participant["role"] == "student"):
            start_id = (await self.store.get(member.guild.id, "channel", "start"))["id"]
            team = next((t for t in cfg["teams"] if participant and t["id"] == participant.get("teamId")), None)
            text = f"{cfg['workspaceName']} 서버 안내\n{cfg['welcomeText']}\n배정 팀: {team['name'] if team else '미배정'}\n시작하기: https://discord.com/channels/{member.guild.id}/{start_id}"
            try:
                await member.send(text, view=self.view(member.guild.id), allowed_mentions=discord.AllowedMentions.none())
            except discord.Forbidden:
                channel = member.guild.get_channel(start_id)
                await channel.send(f"{member.mention} 서버 이용 안내를 확인하고 자기소개를 작성하세요.", view=self.view(member.guild.id), allowed_mentions=discord.AllowedMentions(users=[member], roles=False, everyone=False))
            record["welcomed"] = True
        if record["introDone"] and not record.get("reported"):
            await self.request("progress", {"guildId": str(member.guild.id), "discordId": str(member.id)})
            record["reported"] = True
        await self.store.put(member.guild.id, "member", member.id, record)

    async def submit_intro(self, guild_id, user_id, name, introduction):
        await self.refresh([guild_id])
        cfg = self.configs.get(str(guild_id))
        guild = self.bot.get_guild(guild_id)
        if not guild or not cfg or not cfg.get("enabled") or not name or not introduction:
            raise OnboardingError("conflict")
        member = guild.get_member(user_id) or await guild.fetch_member(user_id)
        async with self.lock(guild_id):
            await self.ensure_resources(guild, cfg)
            record = await self.store.get(guild_id, "member", user_id) or {"introDone": False, "welcomed": False}
            if not record["introDone"]:
                channel_id = (await self.store.get(guild_id, "channel", "intro"))["id"]
                channel = guild.get_channel(channel_id)
                embed = discord.Embed(title=f"{name} · 자기소개", description=introduction, color=0x315C48)
                embed.set_footer(text=f"Discord ID: {user_id}")
                await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
                record["introDone"] = True
                await self.store.put(guild_id, "member", user_id, record)
            await self.sync_member(member, cfg, welcome=False)
        participant = next((p for p in cfg["participants"] if p["discordId"] == str(user_id)), None)
        if not participant:
            return "자기소개를 저장했습니다. 웹 가입 승인·Discord 인증·과정 등록을 완료하면 역할과 배정 팀이 반영됩니다."
        team = next((t for t in cfg["teams"] if t["id"] == participant.get("teamId")), None)
        return f"온보딩을 완료했습니다. 배정 팀: {team['name'] if team else '미배정 · 운영자에게 확인하세요.'}"

    async def sync_guild(self, guild, cfg):
        if not cfg.get("enabled"):
            return
        async with self.lock(guild.id):
            error = ""
            try:
                await self.ensure_resources(guild, cfg)
                if not guild.chunked:
                    await guild.chunk(cache=True)
                for member in guild.members:
                    try:
                        await self.sync_member(member, cfg)
                    except discord.Forbidden:
                        error = "permissions"
                    except discord.HTTPException:
                        error = "discord_error"
                    except OnboardingError as failure:
                        error = str(failure)
                        if error == "api_error":
                            break
            except OnboardingError as failure:
                error = str(failure)
            except discord.Forbidden:
                error = "permissions"
            except discord.HTTPException:
                error = "discord_error"
            await self.request("report", {"guildId": str(guild.id), "revision": cfg["revision"], "state": "failed" if error else "ready", "error": error})

    @tasks.loop(seconds=30)
    async def worker(self):
        try:
            await self.refresh([guild.id for guild in self.bot.guilds])
            for guild in self.bot.guilds:
                cfg = self.configs.get(str(guild.id))
                if cfg:
                    try:
                        await self.sync_guild(guild, cfg)
                    except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
                        log.warning("LMS onboarding sync failed for guild %s", guild.id)
        except (OnboardingError, asyncio.TimeoutError):
            log.warning("LMS onboarding API connection failed")

    @worker.before_loop
    async def before_worker(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_member_join(self, member):
        if member.bot or not self.url:
            return
        try:
            await self.refresh([member.guild.id])
            cfg = self.configs.get(str(member.guild.id))
            if cfg and cfg.get("enabled"):
                async with self.lock(member.guild.id):
                    await self.ensure_resources(member.guild, cfg)
                    await self.sync_member(member, cfg)
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
            log.warning("LMS join onboarding pending for guild %s", member.guild.id)


async def setup(bot):
    await bot.add_cog(LMSOnboarding(bot))
