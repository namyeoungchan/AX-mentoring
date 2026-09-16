"""Guild-scoped onboarding and team reconciliation driven by the LMS."""
import asyncio
import logging
import os
import time
from urllib.parse import urlsplit

import discord
from discord.ext import commands, tasks

import config
from cogs.lms_guides import ensure_guide, guide_text, GUIDES
from cogs.lms_onboarding_store import OnboardingStore
from cogs.lms_provision import validate_provision_endpoint
from cogs.panel_objects import PANEL_OBJECTS
from cogs.lms_auth import VerificationModal
from ui.embeds import panel_embed

log = logging.getLogger("asanAX.lms_onboarding")
ROLE_NAMES = {"pending": "LMS 온보딩 대기", "student": "LMS 수강생", "instructor": "LMS 강사", "admin": "LMS 운영자", "complete": "LMS 온보딩 완료"}


class OnboardingError(Exception):
    pass


def desired_roles(participant, intro_done):
    if not participant:
        return {"pending"}
    if participant["role"] in {"admin", "instructor"}:
        return {participant["role"]} | {f"team:{team_id}" for team_id in participant.get("teamIds", [])}
    if not intro_done or not participant.get("teamId"):
        return {"pending"}
    return {"student", "complete"} | ({f"team:{participant['teamId']}"} if participant.get("teamId") else set())


class StartView(discord.ui.View):
    def __init__(self, cog, guild_id):
        super().__init__(timeout=None)
        self.cog, self.guild_id = cog, int(guild_id)
        verify = discord.ui.Button(label="1 · LMS 인증", style=discord.ButtonStyle.success, custom_id=f"lms:verify:{guild_id}")
        verify.callback = self.verify
        self.add_item(verify)
        button = discord.ui.Button(label="2 · 자기소개 작성", style=discord.ButtonStyle.primary, custom_id=f"lms:onboarding:{guild_id}")
        button.callback = self.start
        self.add_item(button)
        if cog.url:
            endpoint = urlsplit(cog.url)
            self.add_item(discord.ui.Button(label="LMS에서 인증 코드 받기", url=f"{endpoint.scheme}://{endpoint.netloc}"))

    async def interaction_check(self, interaction):
        if interaction.guild_id != self.guild_id:
            await interaction.response.send_message("서버의 시작하기 채널에서 진행하세요.", ephemeral=True)
            return False
        return True

    async def verify(self, interaction):
        auth = self.cog.bot.get_cog("LMSAuth")
        if not auth or not auth.url:
            await interaction.response.send_message("LMS 인증 연결을 준비 중입니다. 운영자에게 문의하세요.", ephemeral=True)
            return
        await interaction.response.send_modal(VerificationModal(auth))

    async def start(self, interaction):
        cfg = self.cog.configs.get(str(self.guild_id))
        if not cfg or not cfg.get("enabled"):
            await interaction.response.send_message("온보딩이 아직 준비되지 않았습니다. 운영자에게 문의하세요.", ephemeral=True)
            return
        participant = next((p for p in cfg.get("participants", []) if p["discordId"] == str(interaction.user.id)), None)
        if not participant or participant["role"] != "student":
            await interaction.response.send_message("멘토·운영자는 자기소개가 필요 없습니다. LMS의 업무 안내를 진행하세요." if participant else "LMS에서 Discord 인증을 먼저 완료하세요. 인증 직후라면 잠시 후 다시 눌러 주세요. 멘토는 자기소개가 필요 없습니다.", ephemeral=True)
            return
        if not participant.get("teamId"):
            await interaction.response.send_message("담당자가 팀을 배정해야 다음 단계로 진행할 수 있습니다.", ephemeral=True)
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

    async def ensure_dashboard(self, guild, channel=None, name=None, category=None):
        """Repair the staff dashboard before any private panel content is published."""
        async with self.lock(guild.id):
            if not guild.me or not guild.me.guild_permissions.manage_channels:
                raise OnboardingError("permissions")
            roles = await self.ensure_roles(guild)
            spec = PANEL_OBJECTS["dashboard"]
            channels = list(await guild.fetch_channels())
            if channel is not None:
                channel = next((c for c in channels if c.id == channel.id), None)
            if channel is None:
                stored = await self.store.get(guild.id, "channel", spec.template_id) or await self.store.get(guild.id, "panel-channel", spec.template_id)
                channel = next((c for c in channels if stored and c.id == stored["id"]), None)
            if channel is None:
                matches = [c for c in channels if c.type == discord.ChannelType.text and c.name in {*spec.channel_names, name}]
                if len(matches) > 1:
                    raise OnboardingError("conflict")
                channel = matches[0] if matches else None
            if channel is not None and channel.type != discord.ChannelType.text:
                raise OnboardingError("conflict")
            allowed = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True)
            overwrites = {guild.default_role: discord.PermissionOverwrite(view_channel=False), guild.me: allowed,
                          roles["admin"]: allowed, roles["instructor"]: allowed}
            if channel is None:
                channel = await guild.create_text_channel(name or "과제-대시보드", category=category, overwrites=overwrites, reason="LMS staff-only assignment dashboard")
            else:
                changes = {}
                if channel.overwrites != overwrites:
                    changes["overwrites"] = overwrites
                if name and channel.name != name:
                    changes["name"] = name
                if changes:
                    channel = await channel.edit(**changes, reason="LMS staff-only assignment dashboard")
            await self.store.put(guild.id, "channel", spec.template_id, {"id": channel.id})
            await self.store.put(guild.id, "panel-channel", spec.template_id, {"id": channel.id})
            return channel

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
        await ensure_guide(start, cfg["welcomeText"] + "\n\n**1 · LMS 인증**\nLMS 가입 신청 현황에서 코드를 발급받고 아래 인증 버튼에 입력하세요.\n**2 · 자기소개**\n수강생은 인증 후 자기소개를 작성하세요. 멘토·운영자는 생략합니다.\n**3 · 학습 시작**\n승인 시 배정된 팀과 학습 채널이 열립니다.", self.view(guild.id))
        await ensure_guide(intro, GUIDES["intro"])
        for team in cfg["teams"]:
            team_role = await self.role(guild, f"team:{team['id']}", f"LMS 팀 · {team['name']}")
            allowed = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True, connect=True, speak=True)
            overwrites = {guild.default_role: discord.PermissionOverwrite(view_channel=False), guild.me: allowed, roles["admin"]: allowed, team_role: allowed}
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
        await self.gate_channels(guild, cfg, roles, start.id, intro.id)
        self.resources_checked[str(guild.id)] = (cfg["revision"], time.monotonic())

    async def gate_channels(self, guild, cfg, roles, start_id, intro_id):
        """Deny access before a member is verified, including voice and unmanaged channels."""
        general_names = {item["name"] for item in cfg.get("channels", [])}
        stored = await self.store.all(guild.id, "channel")
        private_ids = {value["id"] for key, value in stored.items() if key.startswith("team-") or key == PANEL_OBJECTS["dashboard"].template_id}
        for channel in await guild.fetch_channels():
            overwrites = dict(channel.overwrites)
            entrance = channel.id == start_id
            for role, visible in [(guild.default_role, entrance), (roles["pending"], entrance)]:
                overwrite = channel.overwrites_for(role)
                overwrite.update(view_channel=visible, send_messages=False if entrance else None,
                                 read_message_history=True if entrance else None)
                overwrites[role] = overwrite
            # Staff-only dashboards and team channels retain their narrower grants.
            if entrance or (channel.id not in private_ids and channel.name not in PANEL_OBJECTS["dashboard"].channel_names and (channel.name in general_names or channel.id == intro_id)):
                for key in ["student", "instructor", "admin"]:
                    overwrite = channel.overwrites_for(roles[key])
                    overwrite.update(view_channel=True, read_message_history=True,
                                     send_messages=not entrance, connect=True, speak=True)
                    overwrites[roles[key]] = overwrite
            bot_access = channel.overwrites_for(guild.me)
            bot_access.update(view_channel=True, send_messages=True, read_message_history=True, connect=True)
            overwrites[guild.me] = bot_access
            if overwrites != channel.overwrites:
                await channel.edit(overwrites=overwrites, reason="LMS verification required before channel access")

    async def gate_member(self, member, restricted):
        # A role denial cannot override another role's allowance. Member-specific
        # overwrites close that bypass while preserving prior custom permissions.
        start = await self.store.get(member.guild.id, "channel", "start")
        if not start:
            return
        key = str(member.id)
        saved = await self.store.get(member.guild.id, "access-gate", key) or {}
        if not restricted and not saved:
            return
        for channel in await member.guild.fetch_channels():
            if channel.id == start["id"]:
                continue
            cid = str(channel.id)
            overwrite = channel.overwrites_for(member)
            if restricted:
                if cid not in saved:
                    saved[cid] = overwrite.view_channel
                    await self.store.put(member.guild.id, "access-gate", key, saved)
                if overwrite.view_channel is not False:
                    overwrite.view_channel = False
                    await channel.set_permissions(member, overwrite=overwrite, reason="LMS onboarding incomplete")
            elif cid in saved:
                if overwrite.view_channel is False:
                    overwrite.view_channel = saved[cid]
                    await channel.set_permissions(member, overwrite=None if overwrite.is_empty() else overwrite, reason="LMS onboarding complete")
                del saved[cid]
                await self.store.put(member.guild.id, "access-gate", key, saved)

    async def after_verification(self, interaction):
        try:
            await self.refresh([interaction.guild_id])
            cfg = self.configs.get(str(interaction.guild_id))
            if not cfg or not cfg.get("enabled"):
                return
            async with self.lock(interaction.guild_id):
                await self.ensure_resources(interaction.guild, cfg)
                await self.sync_member(interaction.user, cfg, welcome=False)
            participant = next((p for p in cfg["participants"] if p["discordId"] == str(interaction.user.id)), None)
            text = ("인증 완료 · 다음으로 **2 · 자기소개 작성**을 눌러 주세요." if participant and participant["role"] == "student" and participant.get("teamId") else
                    "인증 완료 · 멘토·운영자는 자기소개 없이 LMS 업무 안내를 진행하세요." if participant and participant["role"] != "student" else
                    "인증 완료 · 팀 배정과 과정 등록을 운영자에게 확인해 주세요. 학습 채널은 온보딩 완료 후 열립니다.")
            await interaction.followup.send(text, view=self.view(interaction.guild_id), ephemeral=True)
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
            await interaction.followup.send("계정 인증은 완료됐습니다. 역할 반영을 재시도 중이니 잠시 후 시작하기 패널을 확인하세요.", ephemeral=True)

    async def sync_member(self, member, cfg, welcome=True):
        if member.bot:
            return
        record = await self.store.get(member.guild.id, "member", member.id) or {"introDone": False, "welcomed": False}
        participant = next((person for person in cfg["participants"] if person["discordId"] == str(member.id)), None)
        desired = desired_roles(participant, record["introDone"])
        if participant and participant["role"] == "student" and not any(t["id"] == participant.get("teamId") for t in cfg["teams"]):
            desired = {"pending"}
        if "pending" in desired:
            await self.gate_member(member, True)
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
        if "pending" not in desired:
            await self.gate_member(member, False)
        mentor = participant and participant["role"] == "instructor"
        if participant and (mentor or record["introDone"]):
            team = next((team for team in cfg["teams"] if team["id"] == participant.get("teamId")), None)
            nick = (f"멘토_{participant['name']}" if mentor else participant["name"] + (f"_{team['name']}" if team else ""))[:32]
            if member.nick != nick:
                if mentor and not member.guild.me.guild_permissions.manage_nicknames:
                    raise OnboardingError("permissions")
                if mentor and (member.top_role >= member.guild.me.top_role or member.id == member.guild.owner_id):
                    raise OnboardingError("role_hierarchy")
                if member.guild.me.guild_permissions.manage_nicknames and member.top_role < member.guild.me.top_role and member.id != member.guild.owner_id:
                    await member.edit(nick=nick, reason="LMS mentor identity" if mentor else "LMS web team assignment")
        if welcome and not record["welcomed"] and (not participant or participant["role"] == "student"):
            start_id = (await self.store.get(member.guild.id, "channel", "start"))["id"]
            team = next((t for t in cfg["teams"] if participant and t["id"] == participant.get("teamId")), None)
            student = participant and participant["role"] == "student"
            text = (f"{cfg['workspaceName']} 서버 안내\n{cfg['welcomeText']}\n배정 팀: {team['name'] if team else '미배정'}" if student else f"{cfg['workspaceName']} 서버 안내\nLMS에서 초대 수락 또는 가입 승인을 확인하고 Discord 인증을 완료하세요. 멘토는 자기소개가 필요 없습니다.") + f"\n시작하기: https://discord.com/channels/{member.guild.id}/{start_id}"
            channel = member.guild.get_channel(start_id)
            await channel.send(member.mention, embed=panel_embed(title="온보딩을 시작하세요", description=text, section="WELCOME"),
                               view=self.view(member.guild.id), allowed_mentions=discord.AllowedMentions(users=[member], roles=False, everyone=False))
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
        participant = next((p for p in cfg["participants"] if p["discordId"] == str(user_id)), None)
        if participant and participant["role"] in {"instructor", "admin"}:
            async with self.lock(guild_id):
                await self.ensure_resources(guild, cfg)
                await self.sync_member(member, cfg, welcome=False)
            return "멘토·운영자는 자기소개가 필요 없습니다. LMS의 업무 안내를 진행하세요."
        if not participant or not any(t["id"] == participant.get("teamId") for t in cfg["teams"]):
            return "LMS 인증과 팀 배정을 먼저 완료하세요. 자기소개를 저장하지 않았습니다."
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
    async def on_guild_channel_create(self, channel):
        cfg = self.configs.get(str(channel.guild.id))
        if cfg and cfg.get("enabled"):
            self.resources_checked.pop(str(channel.guild.id), None)
            try:
                await self.sync_guild(channel.guild, cfg)
            except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
                log.warning("LMS new channel access sync pending for guild %s", channel.guild.id)

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
                    record = await self.store.get(member.guild.id, "member", member.id)
                    if record:
                        record["welcomed"] = False
                        await self.store.put(member.guild.id, "member", member.id, record)
                    await self.sync_member(member, cfg)
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
            log.warning("LMS join onboarding pending for guild %s", member.guild.id)


async def setup(bot):
    await bot.add_cog(LMSOnboarding(bot))
