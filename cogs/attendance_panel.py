"""Code-gated classroom entry and exit using the invoking Discord identity."""
import datetime
import re
import discord


def clock(value):
    if not value:
        return '미등록'
    return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone(datetime.timedelta(hours=9))).strftime('%H:%M:%S')


def build_attendance_embed():
    return discord.Embed(title='입실 · 퇴실 출석', description=(
        '강사가 **시작 코드**를 생성하면 강의가 시작됩니다. **입실**을 눌러 코드를 입력하세요.\n'
        '강의가 끝나면 **퇴실**을 눌러 강사가 안내한 **종료 코드**를 입력하세요.\n'
        '두 코드를 등록하면 입실·퇴실 출석이 완료됩니다. 코드 없이 기록할 수 없습니다.\n'
        '**내 입퇴실**에서 강의 시간대와 기록을 확인하세요. 모든 시각은 한국시간입니다.\n'
        '웹 **나의 출결**에서도 같은 코드로 등록할 수 있습니다. 결과는 본인에게만 보입니다.'), color=0x315C48)


def result_text(data):
    label = '입실' if data.get('action') == 'in' else '퇴실'
    text = f"{'이미 기록된' if data.get('alreadyRecorded') else '기록한'} {label} 시각입니다.\n{data['date']} · {data['period']}차시\n입실 {clock(data.get('checkInAt'))} · 퇴실 {clock(data.get('checkOutAt'))} (한국시간)"
    text += '\n수업이 끝나면 종료 코드로 퇴실을 등록하세요.' if not data.get('checkOutAt') else '\n입실·퇴실 출석 기록 완료. 멘토가 정정한 출결 상태는 유지됩니다.'
    return text


class AttendanceCodeModal(discord.ui.Modal):
    def __init__(self, cog, action, member_id, guild_id):
        super().__init__(title='시작 코드로 입실' if action == 'in' else '종료 코드로 퇴실', timeout=180)
        self.cog, self.action, self.member_id, self.guild_id = cog, action, member_id, guild_id
        self.code = discord.ui.TextInput(label='6자리 시작 코드' if action == 'in' else '6자리 종료 코드', min_length=6, max_length=6, placeholder='강사가 안내한 코드를 입력하세요')
        self.add_item(self.code)

    async def on_submit(self, interaction):
        if interaction.user.id != self.member_id or interaction.guild_id != self.guild_id:
            await interaction.response.send_message('본인의 수업 서버에서 출석 패널을 다시 눌러 주세요.', ephemeral=True)
            return
        code = self.code.value.strip()
        if not re.fullmatch(r'[0-9]{6}', code):
            await interaction.response.send_message('숫자 6자리 코드를 입력하세요.', ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        status, data = await self.cog.presence('mark', interaction.user.id, interaction.guild_id, {'code': code, 'action': self.action})
        text = result_text(data) if status == 200 and isinstance(data, dict) and data.get('checkInAt') else (data or {}).get('error') or '처리 결과를 확인하지 못했습니다. 내 입퇴실에서 확인하거나 같은 코드로 다시 시도하세요.'
        await interaction.followup.send(text, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


class AttendancePanelView(discord.ui.View):
    def __init__(self, bot):
        super().__init__(timeout=None)
        self.bot = bot

    async def handle(self, interaction, action):
        cog = self.bot.get_cog('LMSAttendance')
        if not interaction.guild_id or not cog or not cog.url:
            await interaction.response.send_message('출석 봇이 연결된 수업 서버에서 사용하세요.', ephemeral=True)
            return
        if action != 'view':
            await interaction.response.send_modal(AttendanceCodeModal(cog, action, interaction.user.id, interaction.guild_id))
            return
        await interaction.response.defer(ephemeral=True)
        status, data = await cog.presence('view', interaction.user.id, interaction.guild_id)
        if status != 200 or not isinstance(data, dict) or 'rounds' not in data:
            text = (data or {}).get('error') or '출결을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'
        else:
            lines = []
            for r in data['rounds']:
                session = r.get('session') or {}
                planned = f" · 강의 {session['startTime']}–{session['endTime']}" if session else ''
                lines.append(f"{r['period']}차시{planned}\n입실 {clock(r.get('checkInAt'))} / 퇴실 {clock(r.get('checkOutAt'))}")
            text = '**오늘의 출석 (한국시간)**\n' + ('\n\n'.join(lines) or '오늘 시작된 강의가 없습니다. 강사에게 시작 코드를 확인하세요.')
        await interaction.followup.send(text[:1900], ephemeral=True, allowed_mentions=discord.AllowedMentions.none())

    @discord.ui.button(label='입실 · 시작 코드', style=discord.ButtonStyle.success, custom_id='lms:attendance:in')
    async def enter(self, interaction, _button):
        await self.handle(interaction, 'in')

    @discord.ui.button(label='퇴실 · 종료 코드', style=discord.ButtonStyle.primary, custom_id='lms:attendance:out')
    async def leave(self, interaction, _button):
        await self.handle(interaction, 'out')

    @discord.ui.button(label='내 입퇴실', style=discord.ButtonStyle.secondary, custom_id='lms:attendance:view')
    async def status(self, interaction, _button):
        await self.handle(interaction, 'view')
