"""Recipient-bound mentoring reports, submitted from persistent DM buttons or replies."""
import logging
import os
import re

import discord
from discord.ext import commands
from cogs.lms_provision import validate_provision_endpoint
from web_transport import WebTransport

log = logging.getLogger('asanAX.lms_mentoring')
BUTTON_PATTERN = r'lms:mf:(?P<guild>\d{17,20}):(?P<request>[a-f0-9-]{36}):(?P<user>\d{17,20})'


def result_text(status, data):
    if status == 200 and data and data.get('ok'):
        return '멘토링 내용이 저장되었습니다. 웹에서 관리자와 담당 멘토가 확인할 수 있습니다.'
    return {
        403: '본인에게 발송된 멘토링 안내에서 작성해 주세요.',
        404: '이 멘토링 요청은 더 이상 사용할 수 없습니다.',
        409: '취소되었거나 사용할 수 없는 요청입니다. 담당자에게 확인해 주세요.',
        422: '멘토링 내용을 1~4,000자 텍스트로 입력해 주세요.',
    }.get(status, '저장 결과를 확인하지 못했습니다. 작성한 내용을 보관하고 같은 안내에 다시 답장해 주세요.')


class FeedbackModal(discord.ui.Modal, title='멘토링 내용 작성'):
    def __init__(self, guild_id, request_id, user_id):
        super().__init__(timeout=900)
        self.guild_id, self.request_id, self.user_id = guild_id, request_id, user_id
        self.content = discord.ui.TextInput(label='다룬 주제 · 주요 피드백 · 다음 할 일', style=discord.TextStyle.paragraph,
                                            placeholder='이번 멘토링에서 진행한 내용을 적어 주세요.', min_length=1, max_length=4000)
        self.add_item(self.content)

    async def on_submit(self, interaction):
        if interaction.user.id != self.user_id:
            await interaction.response.send_message('본인에게 발송된 안내에서 작성해 주세요.', ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        cog = interaction.client.get_cog('LMSMentoring')
        status, data = await cog.submit(self.guild_id, self.request_id, self.user_id, interaction.id, self.content.value) if cog else (503, None)
        await interaction.followup.send(result_text(status, data), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


class FeedbackButton(discord.ui.DynamicItem[discord.ui.Button], template=BUTTON_PATTERN):
    def __init__(self, guild_id, request_id, user_id):
        self.guild_id, self.request_id, self.user_id = int(guild_id), request_id, int(user_id)
        super().__init__(discord.ui.Button(label='멘토링 내용 작성', style=discord.ButtonStyle.primary,
                                          custom_id=f'lms:mf:{self.guild_id}:{request_id}:{self.user_id}'))

    @classmethod
    async def from_custom_id(cls, interaction, item, match, /):
        return cls(match['guild'], match['request'], match['user'])

    async def callback(self, interaction):
        if interaction.user.id != self.user_id or interaction.guild_id is not None:
            await interaction.response.send_message('본인 DM으로 받은 안내에서 작성해 주세요.', ephemeral=True)
            return
        await interaction.response.send_modal(FeedbackModal(self.guild_id, self.request_id, self.user_id))


def feedback_view(guild_id, request_id, user_id):
    view = discord.ui.View(timeout=None)
    view.add_item(FeedbackButton(guild_id, request_id, user_id))
    return view


class LMSMentoring(commands.Cog):
    def __init__(self, bot):
        self.bot, self.url = bot, ''
        self.transport = WebTransport(timeout=15, connections=4)
        self.token = os.getenv('LEARNINGOPS_PROVISION_TOKEN', '').strip()
        candidate = os.getenv('LEARNINGOPS_PROVISION_URL', '').strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_provision_endpoint(candidate).rsplit('/', 1)[0] + '/mentoring/response'
            except ValueError:
                log.warning('Mentoring reports disabled: invalid endpoint')

    async def cog_load(self):
        self.bot.add_dynamic_items(FeedbackButton)

    async def cog_unload(self):
        self.bot.remove_dynamic_items(FeedbackButton)
        await self.transport.close()

    async def submit(self, guild_id, request_id, user_id, event_id, content):
        if not self.url:
            return 503, None
        return await self.transport.post_json(self.url, body={'guildId': str(guild_id), 'requestId': request_id,
                                             'discordId': str(user_id), 'eventId': str(event_id), 'content': content}, token=self.token, retry=True)

    @commands.Cog.listener()
    async def on_message(self, message):
        # Ordinary DMs are not records. Explicit replies identify the exact appointment.
        if message.guild is not None or message.author.bot or not message.reference or not message.reference.message_id:
            return
        try:
            parent = await message.channel.fetch_message(message.reference.message_id)
            if parent.author.id != self.bot.user.id:
                return
            match = next((match for row in parent.components for item in row.children
                          if (match := re.fullmatch(BUTTON_PATTERN, getattr(item, 'custom_id', '') or ''))), None)
            if not match:
                return
            if int(match['user']) != message.author.id:
                status, data = 403, None
            else:
                status, data = await self.submit(match['guild'], match['request'], message.author.id, message.id, message.content)
            await message.reply(result_text(status, data), mention_author=False, allowed_mentions=discord.AllowedMentions.none())
        except discord.HTTPException:
            log.warning('Could not read or acknowledge mentoring DM reply %s', message.id)


async def setup(bot):
    await bot.add_cog(LMSMentoring(bot))
