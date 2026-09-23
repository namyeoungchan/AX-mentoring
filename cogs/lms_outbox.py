"""Durable LMS deliveries. Ambiguous sends are reconciled, never blindly repeated."""
import asyncio
import datetime
import logging
import os

import aiohttp
import discord
from discord.ext import commands, tasks
from cogs.lms_provision import validate_provision_endpoint

log = logging.getLogger('asanAX.lms_outbox')


async def deliver(bot, job):
    result = {'workspaceId': job['workspaceId'], 'id': job['id'], 'claim': job['claim'], 'state': 'failed', 'messageId': '', 'error': ''}
    sending = False
    try:
        guild = bot.get_guild(int(job['guildId']))
        if guild is None:
            result['error'] = 'channel_missing'
            return result
        payload = job['payload']
        individual = job['kind'] in ('reminder', 'publication', 'mentor_availability') and payload.get('audience') == 'individual'
        if individual:
            member = await guild.fetch_member(int(payload['targetId']))
            channel = await member.create_dm()
        else:
            channel = await guild.fetch_channel(int(job['channelId']))
        if not individual and not isinstance(channel, discord.TextChannel):
            result['error'] = 'channel_missing'
            return result
        if job['kind'] in ('submission', 'attendance'):
            onboarding = bot.get_cog('LMSOnboarding')
            if not onboarding:
                result['error'] = 'private_channel_required'
                return result
            # Existing dashboard ownership repairs grants before publishing private metadata.
            channel = await onboarding.ensure_dashboard(guild, channel)
            if str(channel.id) != job['channelId']:
                result['error'] = 'private_channel_required'
                return result
        elif job['kind'] in ('reminder', 'publication') and not individual:
            onboarding = bot.get_cog('LMSOnboarding')
            admin = await onboarding.store.get(guild.id, 'role', 'admin') if onboarding else None
            allowed = {int(payload.get('roleId') or 0), guild.me.id, int((admin or {}).get('id') or 0)}
            if channel.permissions_for(guild.default_role).view_channel or any(overwrite.view_channel is True and target.id not in allowed for target, overwrite in channel.overwrites.items()):
                result['error'] = 'private_channel_required'
                return result
        marker = f"LMS:{job['id']}"
        if job['reconcile']:
            after = datetime.datetime.fromtimestamp(job['createdAt'] / 1000 - 5, datetime.timezone.utc)
            async for message in channel.history(limit=1000, after=after, oldest_first=False):
                if message.author.id == bot.user.id and any(embed.footer.text == marker for embed in message.embeds):
                    result.update(state='sent', messageId=str(message.id))
                    return result
            result.update(state='uncertain', error='not_found')
            return result
        embed = discord.Embed(title=payload['title'][:256], description=payload['description'][:4096], color=0x315C48)
        if payload.get('course'):
            embed.add_field(name='과정', value=payload['course'][:1024], inline=False)
        embed.set_footer(text=marker)
        components = {}
        if job['kind'] == 'mentor_availability':
            from ui.mentor_availability import availability_view
            components['view'] = availability_view(job['guildId'], payload['targetId'])
        sending = True
        message = await asyncio.wait_for(channel.send(embed=embed, nonce=job['nonce'], allowed_mentions=discord.AllowedMentions.none(), **components), timeout=45)
        result.update(state='sent', messageId=str(message.id))
    except discord.Forbidden:
        result['error'] = 'permissions'
    except discord.NotFound:
        result['error'] = 'channel_missing'
    except discord.HTTPException as error:
        result['error'] = 'rate_limit' if error.status == 429 else 'discord_error'
        if error.status != 429 and sending:
            result['state'] = 'uncertain'
    except (asyncio.TimeoutError, aiohttp.ClientError):
        result.update(state='uncertain' if sending or job['reconcile'] else 'failed', error='timeout')
    except Exception:
        log.exception('Outbox delivery failed for job %s', job['id'])
        result.update(state='uncertain' if sending or job['reconcile'] else 'failed', error='discord_error')
    finally:
        if job['reconcile'] and result['state'] != 'sent':
            result['state'] = 'uncertain'
    return result


class LMSOutbox(commands.Cog):
    def __init__(self, bot):
        self.bot, self.url = bot, ''
        self.token = os.getenv('LEARNINGOPS_PROVISION_TOKEN', '').strip()
        candidate = os.getenv('LEARNINGOPS_PROVISION_URL', '').strip()
        if candidate and len(self.token) >= 32:
            try:
                self.url = validate_provision_endpoint(candidate).rsplit('/', 1)[0] + '/outbox'
            except ValueError:
                log.warning('Outbox disabled: invalid provision endpoint')

    async def cog_load(self):
        from ui.mentor_availability import AvailabilityButton
        self.bot.add_dynamic_items(AvailabilityButton)
        if self.url:
            self.worker.start()

    async def cog_unload(self):
        from ui.mentor_availability import AvailabilityButton
        self.bot.remove_dynamic_items(AvailabilityButton)
        self.worker.cancel()

    async def request(self, operation, body):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
            async with session.post(f'{self.url}/{operation}', json=body, headers={'Authorization': f'Bearer {self.token}'}, allow_redirects=False) as response:
                response.raise_for_status()
                return await response.json()

    @tasks.loop(seconds=10)
    async def worker(self):
        try:
            # Bounded drain keeps backlog moving without a burst of parallel sends.
            for _ in range(10):
                job = (await self.request('poll', {'guildIds': [str(g.id) for g in self.bot.guilds], 'capabilities': ['mentor_availability']})).get('job')
                if not job:
                    break
                await self.request('complete', await deliver(self.bot, job))
        except (aiohttp.ClientError, asyncio.TimeoutError):
            log.warning('Outbox API unavailable; durable job will be reconciled after lease expiry')

    @worker.before_loop
    async def before_worker(self):
        await self.bot.wait_until_ready()


async def setup(bot):
    await bot.add_cog(LMSOutbox(bot))
