"""Restart-safe, recipient-bound entry into online mentoring setup."""
import logging
import discord
import database
from workspace_context import enter_interaction

log = logging.getLogger('asanAX.mentor_availability')


class AvailabilityButton(discord.ui.DynamicItem[discord.ui.Button], template=r'lms:availability:(?P<guild>\d{17,20}):(?P<user>\d{17,20})'):
    def __init__(self, guild_id, user_id):
        self.guild_id, self.user_id = int(guild_id), int(user_id)
        super().__init__(discord.ui.Button(label='온라인 멘토링 가능 시간 입력', style=discord.ButtonStyle.primary,
                                          custom_id=f'lms:availability:{self.guild_id}:{self.user_id}'))

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls(match['guild'], match['user'])

    async def callback(self, interaction):
        if interaction.user.id != self.user_id:
            await interaction.response.send_message('본인에게 발송된 입력 버튼을 사용하세요.', ephemeral=True)
            return
        if not await enter_interaction(interaction, self.guild_id):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            guild = interaction.client.get_guild(self.guild_id)
            if guild is None:
                await interaction.followup.send('연결된 Discord 서버를 찾을 수 없습니다.', ephemeral=True)
                return
            await guild.fetch_member(self.user_id)
            mentor = await database.get_online_mentor_by_discord_id(str(self.user_id))
            if not mentor:
                await interaction.followup.send('이 서버에서 LMS 인증을 마친 조 담당 멘토만 가능 시간을 등록할 수 있습니다.', ephemeral=True)
                return
            from ui.mentor_setup import MentorSetupView, build_setup_embed
            template = await database.get_slot_template(mentor['id'])
            await interaction.followup.send('① 시간대 설정 → ② 예약 가능한 날짜 선택 · 한국 시간(KST) 기준입니다.',
                                            embed=await build_setup_embed(mentor, template),
                                            view=MentorSetupView(mentor, template, interaction.client), ephemeral=True)
        except discord.NotFound:
            await interaction.followup.send('먼저 해당 Discord 서버에 참여해 주세요.', ephemeral=True)
        except Exception as error:
            log.warning('Availability entry failed for guild %s (%s)', self.guild_id, type(error).__name__)
            await interaction.followup.send('가능 시간을 불러오지 못했습니다. 잠시 후 이 버튼을 다시 눌러 주세요.', ephemeral=True)


def availability_view(guild_id, user_id):
    view = discord.ui.View(timeout=None)
    view.add_item(AvailabilityButton(guild_id, user_id))
    return view
