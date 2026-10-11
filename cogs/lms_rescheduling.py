"""Participant-only mentoring coordination; the LMS owns state and authorization."""
import os

import discord
from discord import app_commands
from discord.ext import commands
from cogs.lms_provision import validate_provision_endpoint
from web_transport import WebTransport

PATTERN = r'lms:mc:(?P<guild>\d{17,20}):(?P<booking>[1-9]\d*):(?P<user>\d{17,20})'
LABELS = {'confirmed': '예약 확정', 'proposed': '변경 응답 대기', 'needs_coordination': '재조율 필요', 'cancelled': '취소'}
ACTIONS = {'propose': '다른 시간 제안', 'accept': '변경 수락', 'reject': '제안 거절', 'withdraw': '제안 철회', 'cancel': '예약 취소'}


def schedule(start, end):
    return f"{start[:16].replace('T', ' ')} – {end[:16].replace('T', ' ')} (한국시간)"


def error_text(status, data):
    if isinstance(data, dict) and isinstance(data.get('error'), str):
        return data['error'][:1800]
    return '처리 결과를 확인하지 못했습니다. LMS 또는 일정 조율 버튼에서 최신 상태를 확인해 주세요.'


def booking_embed(data):
    embed = discord.Embed(title='멘토링 일정 재조율', color=0x315C48,
                          description=f"{data['mentor']} · {data['student']}\n{LABELS.get(data['status'], data['status'])}\n"
                                      f"기존/확정 일정: {schedule(data['start'], data['end'])}")
    if data['unavailable']:
        embed.add_field(name='기존 일정 참석 불가', value=' · '.join('멘토' if role == 'mentor' else '수강생' for role in data['unavailable'])
                        + '\n새 일정에 합의해야 합니다. 거절·철회·만료가 되어도 기존 시간으로 자동 확정하지 않습니다.', inline=False)
    proposal = data.get('proposal')
    if proposal:
        embed.add_field(name='내가 보낸 제안' if proposal['by'] == data['role'] else '상대방의 제안',
                        value=schedule(proposal['start'], proposal['end']), inline=False)
        embed.add_field(name='사유', value=proposal['reason'][:1000], inline=False)
        embed.add_field(name='응답 기한', value=f"<t:{proposal['expiresAt'] // 1000}:F>", inline=False)
    embed.set_footer(text='조 담당 멘토와 수강생이 직접 조율합니다. 변경 수락 시 새 일정으로 확정됩니다.')
    return embed


async def show_booking(interaction, guild_id, booking_id, *, deferred=False):
    if not deferred:
        await interaction.response.defer(ephemeral=True, thinking=True)
    cog = interaction.client.get_cog('LMSRescheduling')
    status, data = await cog.request('read', guild_id, interaction.user.id, booking_id) if cog else (503, None)
    if status != 200:
        await interaction.followup.send(error_text(status, data), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        return
    await interaction.followup.send(embed=booking_embed(data), view=ActionsView(guild_id, interaction.user.id, data),
                                    ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


async def show_bookings(interaction):
    """Shared entry for channel panel buttons and /reschedule; the API checks the caller's role."""
    if interaction.guild_id is None:
        await interaction.response.send_message('해당 Discord 서버의 패널에서 이용해 주세요. DM에서는 예약 안내 버튼을 눌러 주세요.', ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True, thinking=True)
    cog = interaction.client.get_cog('LMSRescheduling')
    status, data = await cog.request('list', interaction.guild_id, interaction.user.id) if cog else (503, None)
    if status != 200:
        await interaction.followup.send(error_text(status, data), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
        return
    sessions = data['sessions']
    if not sessions:
        await interaction.followup.send('재조율할 승인 예약이 없습니다.', ephemeral=True)
        return
    await interaction.followup.send('본인의 승인된 예약을 선택하세요. 예약 선택 후 시간 제안 · 수락 · 거절 · 철회 · 취소를 진행할 수 있습니다.',
                                    view=BookingsView(interaction.guild_id, interaction.user.id, sessions), ephemeral=True,
                                    allowed_mentions=discord.AllowedMentions.none())


class EntryButton(discord.ui.DynamicItem[discord.ui.Button], template=PATTERN):
    def __init__(self, guild_id, booking_id, user_id):
        self.guild_id, self.booking_id, self.user_id = int(guild_id), str(booking_id), int(user_id)
        super().__init__(discord.ui.Button(label='일정 확인 · 재조율', style=discord.ButtonStyle.primary,
                                          custom_id=f'lms:mc:{self.guild_id}:{self.booking_id}:{self.user_id}'))

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls(match['guild'], match['booking'], match['user'])

    async def callback(self, interaction):
        if interaction.user.id != self.user_id or interaction.guild_id not in (None, self.guild_id):
            await interaction.response.send_message('본인의 예약 안내에서 이용해 주세요.', ephemeral=True)
            return
        await show_booking(interaction, self.guild_id, self.booking_id)


def coordination_view(guild_id, booking_id, user_id):
    view = discord.ui.View(timeout=None)
    view.add_item(EntryButton(guild_id, booking_id, user_id))
    return view


class ParticipantView(discord.ui.View):
    def __init__(self, guild_id, user_id):
        super().__init__(timeout=600)
        self.guild_id, self.user_id = int(guild_id), int(user_id)

    async def interaction_check(self, interaction):
        if interaction.user.id == self.user_id and interaction.guild_id in (None, self.guild_id):
            return True
        await interaction.response.send_message('본인의 예약 안내에서 이용해 주세요.', ephemeral=True)
        return False


class ChangeModal(discord.ui.Modal):
    def __init__(self, guild_id, user_id, data, action, slot_id=None):
        super().__init__(title=ACTIONS[action], timeout=600)
        self.guild_id, self.user_id, self.data, self.action, self.slot_id = int(guild_id), int(user_id), data, action, slot_id
        self.reason = discord.ui.TextInput(label='사유 (상대방에게 전달됩니다)', style=discord.TextStyle.paragraph, min_length=1, max_length=1000)
        self.add_item(self.reason)
        self.available = None
        if action != 'cancel':
            self.available = discord.ui.TextInput(label='기존 시간 참석 여부: 가능 / 불가', placeholder='가능 또는 불가를 입력하세요.', min_length=2, max_length=2)
            self.add_item(self.available)

    async def on_submit(self, interaction):
        if interaction.user.id != self.user_id or interaction.guild_id not in (None, self.guild_id):
            await interaction.response.send_message('본인의 예약에서 이용해 주세요.', ephemeral=True)
            return
        if self.available and self.available.value.strip() not in ('가능', '불가'):
            await interaction.response.send_message('기존 시간 참석 여부를 가능 또는 불가로 입력해 주세요.', ephemeral=True)
            return
        payload = {'action': self.action, 'reason': self.reason.value}
        if self.available:
            payload['originalAvailable'] = self.available.value.strip() == '가능'
        if self.slot_id:
            payload['slotId'] = self.slot_id
        await send_action(interaction, self.guild_id, self.data, payload)


async def send_action(interaction, guild_id, data, payload):
    await interaction.response.defer(ephemeral=True, thinking=True)
    cog = interaction.client.get_cog('LMSRescheduling')
    payload = {**payload, 'version': data['version'], 'eventId': str(interaction.id)}
    status, result = await cog.request('act', guild_id, interaction.user.id, data['id'], payload) if cog else (503, None)
    message = f"{ACTIONS[payload['action']]} 처리가 저장되었습니다. 상대방에게 Discord DM을 발송합니다." if status == 200 else error_text(status, result)
    await interaction.followup.send(message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
    if status == 200 and payload['action'] == 'cancel':
        return
    await show_booking(interaction, guild_id, data['id'], deferred=True)


class ActionsView(ParticipantView):
    def __init__(self, guild_id, user_id, data):
        super().__init__(guild_id, user_id)
        self.data = data
        actions = []
        if data['editable']:
            actions.append('propose')
            if data.get('proposal'):
                actions.extend(['withdraw'] if data['proposal']['by'] == data['role'] else ['accept', 'reject'])
            actions.append('cancel')
        for action in actions:
            button = discord.ui.Button(label=ACTIONS[action], style=discord.ButtonStyle.primary if action == 'accept' else discord.ButtonStyle.secondary)
            async def callback(interaction, selected=action):
                if selected == 'propose':
                    if not data['slots']:
                        await interaction.response.send_message('선택 가능한 시간이 없습니다. 조 담당 멘토가 시간 설정 패널에서 가능 시간을 추가해 주세요.', ephemeral=True)
                    else:
                        await interaction.response.send_message('변경할 시간을 선택하세요. 기존 시간으로 다시 합의할 수도 있습니다.', view=SlotsView(guild_id, user_id, data), ephemeral=True)
                elif selected == 'accept':
                    await send_action(interaction, guild_id, data, {'action': 'accept'})
                else:
                    await interaction.response.send_modal(ChangeModal(guild_id, user_id, data, selected))
            button.callback = callback
            self.add_item(button)
        refresh = discord.ui.Button(label='최신 상태 확인', style=discord.ButtonStyle.secondary)
        async def reload(interaction):
            await show_booking(interaction, guild_id, data['id'])
        refresh.callback = reload
        self.add_item(refresh)


class SlotsView(ParticipantView):
    def __init__(self, guild_id, user_id, data, page=0):
        super().__init__(guild_id, user_id)
        slots = data['slots']
        select = discord.ui.Select(placeholder=f'시간 선택 ({page + 1}/{(len(slots) + 24) // 25})', options=[
            discord.SelectOption(label=schedule(slot['start'], slot['end'])[:100], value=slot['id']) for slot in slots[page * 25:(page + 1) * 25]])
        async def choose(interaction):
            await interaction.response.send_modal(ChangeModal(guild_id, user_id, data, 'propose', select.values[0]))
        select.callback = choose
        self.add_item(select)
        for label, target in [('이전 시간', page - 1), ('다음 시간', page + 1)]:
            if target < 0 or target * 25 >= len(slots):
                continue
            button = discord.ui.Button(label=label)
            async def move(interaction, next_page=target):
                await interaction.response.edit_message(view=SlotsView(guild_id, user_id, data, next_page))
            button.callback = move
            self.add_item(button)


class BookingsView(ParticipantView):
    def __init__(self, guild_id, user_id, sessions, page=0):
        super().__init__(guild_id, user_id)
        select = discord.ui.Select(placeholder='조율할 예약 선택', options=[discord.SelectOption(
            label=f"{row['mentor']} · {row['student']} · {row['start'][:16].replace('T', ' ')}"[:100], value=row['id'],
            description=LABELS.get(row['status'], row['status'])) for row in sessions[page * 25:(page + 1) * 25]])
        async def choose(interaction):
            await show_booking(interaction, guild_id, select.values[0])
        select.callback = choose
        self.add_item(select)
        for label, target in [('이전 예약', page - 1), ('다음 예약', page + 1)]:
            if target < 0 or target * 25 >= len(sessions):
                continue
            button = discord.ui.Button(label=label)
            async def move(interaction, next_page=target):
                await interaction.response.edit_message(view=BookingsView(guild_id, user_id, sessions, next_page))
            button.callback = move
            self.add_item(button)


class LMSRescheduling(commands.Cog):
    def __init__(self, bot):
        self.bot, self.url = bot, ''
        self.transport = WebTransport(timeout=15, connections=4)
        self.token = os.getenv('LEARNINGOPS_PROVISION_TOKEN', '').strip()
        candidate = os.getenv('LEARNINGOPS_PROVISION_URL', '').strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_provision_endpoint(candidate).rsplit('/', 1)[0] + '/mentoring/coordination'
            except ValueError:
                pass

    async def cog_load(self):
        self.bot.add_dynamic_items(EntryButton)

    async def cog_unload(self):
        self.bot.remove_dynamic_items(EntryButton)
        await self.transport.close()

    async def request(self, operation, guild_id, user_id, booking_id=None, payload=None):
        if not self.url:
            return 503, None
        body = {'guildId': str(guild_id), 'discordId': str(user_id)}
        if booking_id is not None:
            body['bookingId'] = str(booking_id)
        if payload is not None:
            body['input'] = payload
        return await self.transport.post_json(f'{self.url}/{operation}', body=body, token=self.token, retry=True)

    @app_commands.command(name='reschedule', description='승인된 멘토링 일정을 담당 멘토·수강생과 다시 조율합니다.')
    @app_commands.guild_only()
    async def reschedule(self, interaction: discord.Interaction):
        await show_bookings(interaction)


async def setup(bot):
    await bot.add_cog(LMSRescheduling(bot))
