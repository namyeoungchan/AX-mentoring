"""Persistent entry/exit controls; all identities and timestamps are verified by the LMS."""
import datetime
import discord


def clock(value):
    if not value:
        return '미등록'
    return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone(datetime.timedelta(hours=9))).strftime('%H:%M:%S')


def build_attendance_embed():
    return discord.Embed(title='입실 · 퇴실 출석', description=(
        '수업을 시작할 때 **입실**, 수업을 마칠 때 **퇴실**을 눌러 주세요.\n'
        '멘토가 시작한 오늘의 회차에 서버 시각(한국시간)으로 기록됩니다.\n'
        '입실·퇴실을 모두 기록하면 출석으로 처리합니다. 누락·정정은 멘토에게 요청하세요.\n'
        '웹 **나의 출결**에서도 같은 기록으로 처리됩니다. 결과는 본인에게만 보입니다.'), color=0x315C48)


async def mark(cog, interaction, selected, action):
    status, data = await cog.presence('mark', interaction.user.id, interaction.guild_id,
                                      {k: selected[k] for k in ('courseId', 'date', 'period')} | {'action': action})
    if status == 200 and isinstance(data, dict) and data.get('checkInAt'):
        label = '입실' if action == 'in' else '퇴실'
        text = f"{'이미 기록된' if data.get('alreadyRecorded') else '기록한'} {label} 시각입니다.\n{data['date']} · {data['period']}차시\n입실 {clock(data['checkInAt'])} · 퇴실 {clock(data.get('checkOutAt'))} (한국시간)"
        text += '\n수업이 끝나면 퇴실도 눌러 주세요.' if not data.get('checkOutAt') else '\n입실·퇴실 기록 완료. 멘토가 정정한 출결 상태는 유지됩니다.'
    else:
        text = (data or {}).get('error') or '처리 결과를 확인하지 못했습니다. 내 입퇴실에서 확인하거나 같은 버튼으로 다시 시도하세요.'
    await interaction.followup.send(text, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


class AttendanceRoundView(discord.ui.View):
    def __init__(self, cog, rows, action, member_id, guild_id, page=0):
        super().__init__(timeout=180)
        self.cog, self.rows, self.action, self.member_id, self.guild_id, self.page = cog, rows, action, member_id, guild_id, page
        options = [discord.SelectOption(label=f"{row['date']} · {row['period']}차시", value=str(index)) for index, row in enumerate(rows) if page * 25 <= index < (page + 1) * 25]
        select = discord.ui.Select(placeholder='입실·퇴실할 회차를 선택하세요', options=options)
        select.callback = self.choose
        self.add_item(select)
        for offset, label in [(-1, '이전 회차'), (1, '다음 회차')]:
            if 0 <= page + offset < (len(rows) + 24) // 25:
                button = discord.ui.Button(label=label, custom_id=f'attendance:page:{offset}')
                async def paginate(interaction, offset=offset):
                    await interaction.response.edit_message(view=AttendanceRoundView(cog, rows, action, member_id, guild_id, page + offset))
                button.callback = paginate
                self.add_item(button)

    async def interaction_check(self, interaction):
        if interaction.user.id == self.member_id and interaction.guild_id == self.guild_id:
            return True
        await interaction.response.send_message('본인의 수업 서버에서 출석 패널을 다시 눌러 주세요.', ephemeral=True)
        return False

    async def choose(self, interaction):
        await interaction.response.defer(ephemeral=True)
        index = int(interaction.data['values'][0])
        if self.page * 25 <= index < min(len(self.rows), (self.page + 1) * 25):
            await mark(self.cog, interaction, self.rows[index], self.action)


class AttendancePanelView(discord.ui.View):
    def __init__(self, bot):
        super().__init__(timeout=None)
        self.bot = bot

    async def handle(self, interaction, action):
        cog = self.bot.get_cog('LMSAttendance')
        if not interaction.guild_id or not cog or not cog.url:
            await interaction.response.send_message('출석 봇이 연결된 수업 서버에서 사용하세요.', ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        status, data = await cog.presence('view', interaction.user.id, interaction.guild_id)
        if status != 200 or not isinstance(data, dict) or 'rounds' not in data:
            await interaction.followup.send((data or {}).get('error') or '출결을 불러오지 못했습니다. 잠시 후 다시 시도하세요.', ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
            return
        if action == 'view':
            text = '\n'.join(f"{r['period']}차시 · 입실 {clock(r.get('checkInAt'))} / 퇴실 {clock(r.get('checkOutAt'))}" for r in data['rounds']) or '오늘 시작된 수업 회차가 없습니다. 멘토에게 확인하세요.'
            await interaction.followup.send(f"**오늘의 입퇴실 (한국시간)**\n{text}"[:1900], ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
            return
        rows = [r for r in data['rounds'] if r['state'] == '진행 중']
        if action == 'out':
            rows = [r for r in rows if r.get('checkInAt')]
        if not rows:
            await interaction.followup.send('오늘 진행 중인 회차와 입실 여부를 확인하세요. 회차가 마감됐다면 멘토에게 정정을 요청하세요.', ephemeral=True)
        elif len(rows) == 1:
            await mark(cog, interaction, rows[0], action)
        else:
            await interaction.followup.send('기록할 수업 회차를 선택하세요.', view=AttendanceRoundView(cog, rows, action, interaction.user.id, interaction.guild_id), ephemeral=True)

    @discord.ui.button(label='입실', style=discord.ButtonStyle.success, custom_id='lms:attendance:in')
    async def enter(self, interaction, _button):
        await self.handle(interaction, 'in')

    @discord.ui.button(label='퇴실', style=discord.ButtonStyle.primary, custom_id='lms:attendance:out')
    async def leave(self, interaction, _button):
        await self.handle(interaction, 'out')

    @discord.ui.button(label='내 입퇴실', style=discord.ButtonStyle.secondary, custom_id='lms:attendance:view')
    async def status(self, interaction, _button):
        await self.handle(interaction, 'view')
