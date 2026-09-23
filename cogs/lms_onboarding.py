"""Guild-scoped onboarding and team reconciliation driven by the LMS."""
import asyncio
import hashlib
import json
import logging
import os
import time
from weakref import WeakValueDictionary
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
from web_transport import WebTransport

log = logging.getLogger("asanAX.lms_onboarding")
ROLE_NAMES = {"pending": "LMS 온보딩 대기", "student": "LMS 수강생", "instructor": "LMS 강사", "admin": "LMS 운영자", "complete": "LMS 온보딩 완료"}


class OnboardingError(Exception):
    pass


def failure_code(error):
    if isinstance(error, discord.HTTPException):
        return f"discord_http_{error.status}_code_{error.code}"
    if isinstance(error, OnboardingError):
        return str(error)
    return "api_timeout"


def desired_roles(participant, intro_done):
    if not participant:
        return {"pending"}
    if participant["role"] in {"admin", "instructor"}:
        return {participant["role"], "complete"} | {f"team:{team_id}" for team_id in participant.get("teamIds", [])}
    if not intro_done or not participant.get("teamId"):
        return {"pending"}
    return {"student", "complete"} | ({f"team:{participant['teamId']}"} if participant.get("teamId") else set())


def resource_revision(cfg):
    # Membership proofs change frequently without changing channels or role definitions.
    resources = {key: value for key, value in cfg.items() if key not in {"revision", "participants", "retryDiscordIds"}}
    return hashlib.sha256(json.dumps(resources, sort_keys=True).encode()).hexdigest()


class StartView(discord.ui.View):
    def __init__(self, cog, guild_id, member_id=None, verified=False):
        super().__init__(timeout=900 if member_id is not None else None)
        self.cog, self.guild_id, self.member_id = cog, int(guild_id), member_id
        suffix = f":{member_id}" if member_id is not None else ""
        verify = discord.ui.Button(label="1 · LMS 인증", style=discord.ButtonStyle.success, custom_id=f"lms:verify:{guild_id}{suffix}")
        if verified:
            verify.label, verify.disabled = "1 · LMS 인증 완료", True
        verify.callback = self.verify
        self.add_item(verify)
        button = discord.ui.Button(label="2 · 자기소개 작성", style=discord.ButtonStyle.primary, custom_id=f"lms:onboarding:{guild_id}{suffix}")
        button.callback = self.start
        self.add_item(button)
        if cog.url:
            endpoint = urlsplit(cog.url)
            self.add_item(discord.ui.Button(label="LMS 열기" if verified else "LMS에서 인증 코드 받기", url=f"{endpoint.scheme}://{endpoint.netloc}"))

    async def interaction_check(self, interaction):
        if interaction.guild_id != self.guild_id:
            await interaction.response.send_message("서버의 시작하기 채널에서 진행하세요.", ephemeral=True)
            return False
        if self.member_id is not None and interaction.user.id != self.member_id:
            await interaction.response.send_message("본인의 인증 안내만 사용할 수 있습니다.", ephemeral=True)
            return False
        return True

    async def verify(self, interaction):
        auth = self.cog.bot.get_cog("LMSAuth")
        if not auth or not auth.url:
            await interaction.response.send_message("LMS 인증 연결을 준비 중입니다. 운영자에게 문의하세요.", ephemeral=True)
            return
        if self.member_id is None:
            await self.cog.open_panel(interaction)
            return
        await interaction.response.send_modal(VerificationModal(auth))

    async def start(self, interaction):
        if self.member_id is None:
            await self.cog.open_panel(interaction)
            return
        cfg = self.cog.configs.get(str(self.guild_id))
        if not cfg or not cfg.get("enabled"):
            await interaction.response.send_message("온보딩이 아직 준비되지 않았습니다. 운영자에게 문의하세요.", ephemeral=True)
            return
        participant = next((p for p in cfg.get("participants", []) if p["discordId"] == str(interaction.user.id)), None)
        if not participant or participant["role"] != "student":
            await interaction.response.send_message("멘토·운영자는 자기소개가 필요 없습니다. LMS의 업무 안내를 진행하세요." if participant else "시작하기 채널의 공용 버튼으로 현재 상태를 다시 확인하세요. 인증을 완료했다면 코드를 다시 받을 필요가 없습니다. 과정 등록과 팀 배정은 운영자에게 확인하세요.", ephemeral=True)
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
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError) as error:
            await interaction.followup.send("자기소개 처리를 완료하지 못했습니다. LMS 재인증은 필요 없습니다. 잠시 후 자기소개 버튼으로 다시 시도하세요.", ephemeral=True)
            log.warning("LMS introduction could not finish for guild %s (%s)", self.guild_id, failure_code(error))


class LMSOnboarding(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.store = OnboardingStore(config.DB_PATH)
        self.configs, self.locks, self.views, self.resources_checked = {}, {}, {}, {}
        self.member_locks = WeakValueDictionary()
        self.sync_locks = {}
        self.refresh_lock = asyncio.Lock()
        self.member_tasks = {}
        self.member_slots = asyncio.Semaphore(3)
        self.transport = WebTransport(timeout=20, connections=4)
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
        pending = list(self.member_tasks.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await self.transport.close()

    def view(self, guild_id):
        key = str(guild_id)
        if key not in self.views:
            self.views[key] = StartView(self, key)
            self.bot.add_view(self.views[key])
        return self.views[key]

    def lock(self, guild_id):
        return self.locks.setdefault(str(guild_id), asyncio.Lock())

    def member_lock(self, guild_id, user_id):
        key = (str(guild_id), str(user_id))
        lock = self.member_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self.member_locks[key] = lock
        return lock

    async def request(self, operation, body):
        if not self.url:
            raise OnboardingError("api_error")
        status, data = await self.transport.post_json(f"{self.url}/{operation}", body=body, token=self.token, retry=True)
        if status != 200:
            log.warning("LMS onboarding %s rejected (HTTP %s)", operation, status)
            raise OnboardingError("conflict" if status == 409 else "api_error")
        return data

    async def refresh(self, guild_ids):
        # A slow earlier poll must not overwrite a newer authentication snapshot.
        async with self.refresh_lock:
            await self._refresh(guild_ids)

    async def _refresh(self, guild_ids):
        result = await self.request("poll", {"guildIds": [str(value) for value in guild_ids]})
        if not isinstance(result.get("configs"), list) or any(not isinstance(value, dict) or not isinstance(value.get("guildId"), str) or not isinstance(value.get("enabled"), bool) for value in result["configs"]):
            raise OnboardingError("api_error")
        received = {value["guildId"]: value for value in result["configs"]}
        for guild_id in guild_ids:
            key = str(guild_id)
            if key in received:
                changed = self.configs.get(key) != received[key]
                self.configs[key] = received[key]
                if changed:
                    await self.store.put("0", "config", key, received[key])
                self.view(key)
            elif key in self.configs and self.configs[key].get("enabled"):
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
        revision = resource_revision(cfg)
        if last and last[0] == revision and time.monotonic() - last[1] < 300:
            return
        roles = await self.ensure_roles(guild)
        start = await self.channel(guild, "start", cfg["onboardingChannel"], "text", adopt=True)
        intro = await self.channel(guild, "intro", cfg["introChannel"], "text", adopt=True)
        await ensure_guide(start, cfg["welcomeText"] + "\n\n**1 · LMS 인증**\n아래 인증 버튼을 누르면 본인에게만 보이는 안내가 열립니다. 웹에서 발급받은 코드는 개인 안내 안의 인증 버튼에 입력하세요.\n**2 · 자기소개**\n수강생은 인증 후 자기소개를 작성하세요. 멘토·운영자는 생략합니다.\n**3 · 학습 시작**\n승인 시 배정된 팀과 학습 채널이 열립니다.", self.view(guild.id))
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
        self.resources_checked[str(guild.id)] = (revision, time.monotonic())

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
        channels = [channel for channel in await member.guild.fetch_channels() if channel.id != start["id"]]
        original = dict(saved)
        if restricted:
            for channel in channels:
                saved.setdefault(str(channel.id), channel.overwrites_for(member).view_channel)
            if saved != original:
                # Save the full recovery snapshot before changing any Discord permission.
                await self.store.put(member.guild.id, "access-gate", key, saved)
        for channel in channels:
            cid = str(channel.id)
            overwrite = channel.overwrites_for(member)
            if restricted:
                if overwrite.view_channel is not False:
                    overwrite.view_channel = False
                    await channel.set_permissions(member, overwrite=overwrite, reason="LMS onboarding incomplete")
            elif cid in saved:
                if overwrite.view_channel is False:
                    overwrite.view_channel = saved[cid]
                    await channel.set_permissions(member, overwrite=None if overwrite.is_empty() else overwrite, reason="LMS onboarding complete")
                del saved[cid]
        if not restricted and saved != original:
            # A partial failure retains the original snapshot for a safe retry.
            await self.store.put(member.guild.id, "access-gate", key, saved)

    def queue_member(self, guild_id, member_id):
        key = (int(guild_id), int(member_id))
        previous = self.member_tasks.get(key)
        if previous and not previous.done():
            return previous
        task = asyncio.create_task(self.reconcile_verified_member(*key))
        self.member_tasks[key] = task
        def finished(done):
            if self.member_tasks.get(key) is done:
                self.member_tasks.pop(key, None)
        task.add_done_callback(finished)
        return task

    async def reconcile_verified_member(self, guild_id, member_id):
        """Apply existing managed roles promptly; full resource repair remains periodic."""
        try:
            async with self.member_slots:
                async with asyncio.timeout(60):
                    async with self.member_lock(guild_id, member_id):
                        cfg = self.configs.get(str(guild_id))
                        guild = self.bot.get_guild(guild_id)
                        if not guild or not cfg or not cfg.get("enabled"):
                            return
                        # Interaction/cache roles may predate a just-completed transfer.
                        member = await guild.fetch_member(member_id)
                        await self.sync_member(member, cfg, welcome=False)
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError) as error:
            log.warning("LMS immediate role sync pending for guild %s (%s)", guild_id, failure_code(error))
        except Exception as error:
            # Keep the periodic repair alive without logging tokens or response bodies.
            log.error("LMS immediate role sync failed for guild %s (%s)", guild_id, type(error).__name__)

    async def open_panel(self, interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        auth = self.bot.get_cog("LMSAuth")
        status, data = await auth.verification_state(interaction.user.id, interaction.guild_id) if auth else (503, None)
        if status != 200 or not isinstance(data, dict) or not isinstance(data.get("verified"), bool):
            await interaction.followup.send("인증 상태를 확인하지 못했습니다. 코드를 재발급하지 말고 잠시 후 이 버튼을 다시 눌러 주세요.", ephemeral=True)
            return
        if data["verified"]:
            await self.after_verification(interaction)
            return
        await interaction.followup.send(
            "**나의 LMS 인증 안내**\n이 안내와 인증 결과는 본인에게만 보입니다.\n웹에서 발급받은 코드를 아래 **1 · LMS 인증** 버튼에 입력하세요.\n수강생은 인증 후 **2 · 자기소개 작성**까지 진행하세요. 멘토·운영자는 자기소개가 필요 없습니다.",
            view=StartView(self, interaction.guild_id, interaction.user.id), ephemeral=True,
            allowed_mentions=discord.AllowedMentions.none())

    async def after_verification(self, interaction):
        try:
            await self.refresh([interaction.guild_id])
            cfg = self.configs.get(str(interaction.guild_id))
            if not cfg or not cfg.get("enabled"):
                await interaction.followup.send("LMS 인증은 완료되어 있습니다. 온보딩 설정은 운영자에게 확인하세요. 재인증은 필요 없습니다.", ephemeral=True)
                return
            # Show the next step without waiting for guild-wide channel/role repairs.
            # The background reconciler applies permissions independently.
            participant = next((p for p in cfg["participants"] if p["discordId"] == str(interaction.user.id)), None)
            record = await self.store.get(interaction.guild_id, "member", interaction.user.id) or {}
            text = ("인증과 자기소개가 저장되어 있습니다. 채널이 아직 보이지 않으면 권한 반영을 기다려 주세요. 계속 지연되면 운영자에게 문의하세요." if participant and participant["role"] == "student" and record.get("introDone") else
                    "인증 완료 · 다음으로 **2 · 자기소개 작성**을 눌러 주세요." if participant and participant["role"] == "student" and participant.get("teamId") else
                    "인증 완료 · 멘토·운영자는 자기소개 없이 LMS 업무 안내를 진행하세요." if participant and participant["role"] != "student" else
                    "인증 완료 · 팀 배정과 과정 등록을 운영자에게 확인해 주세요. 학습 채널은 온보딩 완료 후 열립니다.")
            text += "\n인증 코드가 만료돼도 완료된 LMS 인증은 유지됩니다. 안내 버튼이 만료되면 시작하기 채널의 공용 버튼을 다시 누르세요."
            view = StartView(self, interaction.guild_id, interaction.user.id, verified=True)
            view.children[1].disabled = bool(record.get("introDone")) or not participant or participant["role"] != "student" or not participant.get("teamId")
            await interaction.followup.send(text, view=view, ephemeral=True)
            if participant and (participant["role"] != "student" or record.get("introDone")):
                self.queue_member(interaction.guild_id, interaction.user.id)
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError) as error:
            await interaction.followup.send("계정 인증은 완료됐습니다. 재인증하지 말고 잠시 후 시작하기 채널의 공용 버튼을 다시 눌러 자기소개를 이어가세요.", ephemeral=True)
            log.warning("LMS verified onboarding pending for guild %s (%s)", interaction.guild_id, failure_code(error))

    async def sync_member(self, member, cfg, welcome=True):
        if member.bot:
            return
        current = self.configs.get(str(member.guild.id))
        if current and current.get("revision") != cfg.get("revision"):
            raise OnboardingError("conflict")
        previous = await self.store.get(member.guild.id, "member", member.id)
        record = dict(previous) if previous else {"introDone": False, "welcomed": False}
        participant = next((person for person in cfg["participants"] if person["discordId"] == str(member.id)), None)
        staff = participant and participant["role"] in {"admin", "instructor"}
        # Staff finish onboarding through LMS verification, without a student intro.
        # Persist before Discord role/nickname retries so a stale/missing participant
        # snapshot cannot issue another student welcome, including after restart.
        if staff and not record.get("welcomed"):
            record["welcomed"] = True
            await self.store.put(member.guild.id, "member", member.id, record)
        desired = desired_roles(participant, record["introDone"])
        if participant and participant["role"] == "student" and not any(t["id"] == participant.get("teamId") for t in cfg["teams"]):
            desired = {"pending"}
        if "pending" in desired:
            await self.gate_member(member, True)
        mappings = await self.store.all(member.guild.id, "role")
        if any(key not in mappings for key in desired):
            self.resources_checked.pop(str(member.guild.id), None)
            raise OnboardingError("conflict")
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
            # Automatic welcomes have no interaction to attach an ephemeral reply to.
            # Use a DM with a server link; never fall back to a public personal panel.
            try:
                await member.send(embed=panel_embed(title="온보딩을 시작하세요", description=text, section="WELCOME"),
                                  allowed_mentions=discord.AllowedMentions.none())
            except discord.Forbidden:
                # The shared entry button still opens a private panel for this member.
                pass
            record["welcomed"] = True
            # Save delivery before any subsequent progress report can fail and retry.
            await self.store.put(member.guild.id, "member", member.id, record)
        if participant and participant["role"] == "student" and record["introDone"] and not record.get("reported"):
            await self.request("progress", {"guildId": str(member.guild.id), "discordId": str(member.id)})
            record["reported"] = True
        if record != previous:
            await self.store.put(member.guild.id, "member", member.id, record)
        return "waiting" if "pending" in desired else "ready"

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
            async with self.member_lock(guild_id, user_id):
                await self.sync_member(member, cfg, welcome=False)
            return "멘토·운영자는 자기소개가 필요 없습니다. LMS의 업무 안내를 진행하세요."
        if not participant or not any(t["id"] == participant.get("teamId") for t in cfg["teams"]):
            return "LMS 인증과 팀 배정을 먼저 완료하세요. 자기소개를 저장하지 않았습니다."
        async with self.lock(guild_id):
            await self.ensure_resources(guild, cfg)
        async with self.member_lock(guild_id, user_id):
            record = await self.store.get(guild_id, "member", user_id) or {"introDone": False, "welcomed": False}
            if not record["introDone"]:
                channel_id = (await self.store.get(guild_id, "channel", "intro"))["id"]
                channel = guild.get_channel(channel_id)
                embed = discord.Embed(title=f"{name} · 자기소개", description=introduction, color=0x315C48)
                embed.set_footer(text=f"Discord ID: {user_id}")
                await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
                record["introDone"] = True
                await self.store.put(guild_id, "member", user_id, record)
            try:
                await self.sync_member(member, cfg, welcome=False)
            except (OnboardingError, discord.HTTPException, asyncio.TimeoutError) as error:
                log.warning("LMS introduction saved; access sync pending for guild %s (%s)", guild_id, failure_code(error))
                return "자기소개를 저장했습니다. 역할과 채널 권한 반영을 자동으로 재시도합니다. LMS 재인증이나 자기소개 재작성은 필요 없습니다. 계속 지연되면 운영자에게 문의하세요."
        participant = next((p for p in cfg["participants"] if p["discordId"] == str(user_id)), None)
        if not participant:
            return "자기소개를 저장했습니다. 웹 가입 승인·Discord 인증·과정 등록을 완료하면 역할과 배정 팀이 반영됩니다."
        team = next((t for t in cfg["teams"] if t["id"] == participant.get("teamId")), None)
        return f"온보딩을 완료했습니다. 배정 팀: {team['name'] if team else '미배정 · 운영자에게 확인하세요.'}"

    async def sync_guild(self, guild, cfg):
        if not cfg.get("enabled"):
            return
        # A repair scan only excludes other scans; interactive members use their own locks.
        async with self.sync_locks.setdefault(str(guild.id), asyncio.Lock()):
            error = ""
            reports = []
            try:
                async with self.lock(guild.id):
                    await self.ensure_resources(guild, cfg)
                if not guild.chunked:
                    await guild.chunk(cache=True)
                async def reconcile(member):
                    failure_code = ""
                    try:
                        async with self.member_lock(guild.id, member.id):
                            state = await self.sync_member(member, cfg)
                    except discord.Forbidden:
                        failure_code = "permissions"
                    except discord.HTTPException:
                        failure_code = "discord_error"
                    except OnboardingError as failure:
                        failure_code = str(failure)
                    except asyncio.TimeoutError:
                        failure_code = "api_error"
                    return {"discordId": str(member.id), "state": "failed" if failure_code else state or "ready", "error": failure_code}
                members = [m for m in guild.members if not m.bot and (not cfg.get("retryDiscordIds") or str(m.id) in cfg["retryDiscordIds"])]
                for offset in range(0, len(members), 3):
                    batch = await asyncio.gather(*(reconcile(m) for m in members[offset:offset + 3]))
                    reports.extend(batch)
                    failures = [row["error"] for row in batch if row["error"]]
                    if failures:
                        error = failures[-1]
                    if "api_error" in failures:
                        break
                present = {str(member.id) for member in guild.members}
                for participant in cfg.get("participants", []):
                    if participant["discordId"] not in present and (not cfg.get("retryDiscordIds") or participant["discordId"] in cfg["retryDiscordIds"]):
                        reports.append({"discordId": participant["discordId"], "state": "failed", "error": "member_missing"})
            except OnboardingError as failure:
                error = str(failure)
            except discord.Forbidden:
                error = "permissions"
            except discord.HTTPException:
                error = "discord_error"
            await self.request("report", {"guildId": str(guild.id), "revision": cfg["revision"], "state": "failed" if error else "ready", "error": error, "members": reports})

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
                    except Exception as error:
                        log.error("LMS onboarding sync failed for guild %s (%s)", guild.id, type(error).__name__)
        except (OnboardingError, asyncio.TimeoutError):
            log.warning("LMS onboarding API connection failed")
        except Exception as error:
            log.error("LMS onboarding poll failed (%s)", type(error).__name__)

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
                async with self.member_lock(member.guild.id, member.id):
                    record = await self.store.get(member.guild.id, "member", member.id)
                    if record:
                        record["welcomed"] = False
                        await self.store.put(member.guild.id, "member", member.id, record)
                    await self.sync_member(member, cfg)
        except (OnboardingError, discord.HTTPException, asyncio.TimeoutError):
            log.warning("LMS join onboarding pending for guild %s", member.guild.id)


async def setup(bot):
    await bot.add_cog(LMSOnboarding(bot))
