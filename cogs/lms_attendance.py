"""Register attendance using the invoking student's verified Discord identity."""
import logging
import os
import re

import discord
from discord import app_commands
from discord.ext import commands
from cogs.lms_auth import validate_auth_endpoint
from web_transport import WebTransport

log = logging.getLogger('asanAX.lms_attendance')
MESSAGES = {
    401: '출석 봇 연결을 확인해 주세요. 운영자에게 문의하세요.',
    403: '이 서버에서 학생 계정의 Discord 인증과 수강 등록을 확인하세요. 담당 멘토의 코드만 사용할 수 있습니다.',
    409: '출석 등록이 마감되었거나 중단된 회차입니다. 멘토에게 확인하세요.',
    410: '만료되었거나 사용할 수 없는 코드입니다. 멘토에게 새 출석 코드를 확인하세요.',
    422: '멘토가 안내한 6자리 출석 코드를 입력하세요.',
    429: '출석 요청이 많습니다. 1분 뒤 다시 시도하세요.',
}


class LMSAttendance(commands.Cog):
    def __init__(self, bot):
        self.bot, self.url = bot, ''
        self.transport = WebTransport(timeout=15, connections=8)
        self.token = os.getenv('LEARNINGOPS_AUTH_TOKEN', '').strip()
        candidate = os.getenv('LEARNINGOPS_AUTH_URL', '').strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_auth_endpoint(candidate).rsplit('/', 1)[0] + '/attendance/checkin'
            except ValueError:
                log.warning('Attendance disabled: invalid endpoint configuration')

    async def cog_load(self):
        from cogs.attendance_panel import AttendancePanelView
        self.bot.add_view(AttendancePanelView(self.bot))

    async def presence(self, operation, member_id, guild_id, extra=None):
        if not self.url:
            return 503, None
        return await self.transport.post_json(self.url.rsplit('/', 1)[0] + '/presence/' + operation,
                                             body={**(extra or {}), 'discordId': str(member_id), 'guildId': str(guild_id)},
                                             token=self.token, retry=True)

    async def cog_unload(self):
        await self.transport.close()

    async def request(self, code, member_id, guild_id):
        if not self.url:
            return 503, None
        return await self.transport.post_json(self.url, body={'code': code, 'discordId': str(member_id), 'guildId': str(guild_id)},
                                             token=self.token, retry=True)

    @app_commands.command(name='출석', description='시작·종료 코드로 강의 입실·퇴실 출석을 기록합니다.')
    @app_commands.describe(코드='강사가 안내한 6자리 시작 또는 종료 코드')
    @app_commands.guild_only()
    async def check_in(self, interaction: discord.Interaction, 코드: str):
        if interaction.guild_id is None or not self.url:
            await interaction.response.send_message('출석 봇이 연결된 수업 서버에서 사용하세요.', ephemeral=True)
            return
        code = 코드.strip()
        if not re.fullmatch(r'[0-9]{6}', code):
            await interaction.response.send_message(MESSAGES[422], ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        status, data = await self.request(code, interaction.user.id, interaction.guild_id)
        if status == 200 and isinstance(data, dict) and data.get('checkInAt'):
            from cogs.attendance_panel import result_text
            message = result_text(data)
        elif status == 200 and isinstance(data, dict) and data.get('status') in ('출석', '지각', '결석', '공결'):
            prefix = '이미 출결 기록이 있습니다' if data.get('alreadyRecorded') else '출석이 등록됐습니다'
            message = f"{prefix}.\n{data.get('date')} · {data.get('period')}차시 · {data['status']}"
            if data.get('alreadyRecorded'):
                message += '\n정정이 필요하면 멘토에게 요청하세요.'
        else:
            message = MESSAGES.get(status, '출석 처리 결과를 확인하지 못했습니다. 같은 코드로 다시 시도하거나 멘토에게 명단 확인을 요청하세요.')
        await interaction.followup.send(message, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


async def setup(bot):
    await bot.add_cog(LMSAttendance(bot))
