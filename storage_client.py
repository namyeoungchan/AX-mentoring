"""Switch the legacy bot to web-owned storage after a verified, lossless import."""
import asyncio
import functools
import hashlib
import inspect
import json
import logging
import os
import sys
import uuid

import aiohttp
import aiosqlite
import config
from storage_codec import encode, decode, pack_runtime

log = logging.getLogger("asanAX.storage")
client = None
TABLES = ('mentors', 'slots', 'bookings', 'panels', 'slot_templates', 'blocked_dates', 'reminders', 'qa_alerts', 'blocked_weekdays', 'onboarding_progress', 'assignments', 'submissions', 'assignment_panels', 'assignment_reminders', 'peer_eval_rounds', 'peer_evaluations')
SETTING_NAMES = ('ADMIN_ROLE_ID', 'STUDENT_ROLE_ID', 'ONBOARDING_COMPLETE_ROLE_ID', 'ONBOARDING_CHANNEL_ID', 'INTRO_CHANNEL_ID', 'ASSIGNMENT_DASHBOARD_CHANNEL_ID', 'ASSIGNMENT_SUBMIT_CHANNEL_ID', 'MENTORING_CHANNEL_ID', 'QA_FORUM_CHANNEL_ID')


class StorageUnavailable(TimeoutError):
    pass


class WebStorage:
    def __init__(self, endpoint, token, guild_id):
        from cogs.lms_provision import validate_provision_endpoint
        self.url = validate_provision_endpoint(endpoint).rsplit('/', 1)[0] + '/storage'
        self.token, self.guild_id = token, str(guild_id)

    async def request(self, operation, body):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=35)) as session:
                async with session.post(f'{self.url}/{operation}', json=body, headers={'Authorization': f'Bearer {self.token}'}, allow_redirects=False) as response:
                    if response.status != 200:
                        raise StorageUnavailable(f'웹 데이터 연결 오류 (HTTP {response.status}). 웹의 봇 데이터 이관 상태를 확인하세요.')
                    return await response.json()
        except StorageUnavailable:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            raise StorageUnavailable('웹 데이터 저장소에 연결하지 못했습니다. 잠시 후 다시 시도하세요.') from error

    async def call(self, operation, args, kwargs):
        body = {'guildId': self.guild_id, 'operation': operation, 'args': encode(list(args)), 'kwargs': encode(kwargs), 'requestId': str(uuid.uuid4())}
        # If the response is lost after a commit, replay the same receipt ID.
        for attempt in range(2):
            try:
                return decode((await self.request('call', body))['result'])
            except StorageUnavailable:
                if attempt:
                    raise

    async def refresh_settings(self):
        status = await self.request('status', {'guildId': self.guild_id})
        config.TEAM_MEMBERS = status.get('teamMembers')
        settings = status.get('settings')
        if settings:
            for name, value in settings['channels'].items():
                if name in SETTING_NAMES:
                    setattr(config, name, int(value) if value else (None if name == 'ONBOARDING_COMPLETE_ROLE_ID' else 0))
            config.QA_UNANSWERED_HOURS = settings['qaUnansweredHours']
            if 'qaNotifyRoleIds' in settings:
                config.QA_NOTIFY_ROLE_IDS[:] = [int(value) for value in settings['qaNotifyRoleIds']]
            config.TEAM_CHANNELS.clear()
            config.TEAM_CHANNELS.update({t['name']: int(t['channelId']) if t['channelId'] else 0 for t in settings['teams']})
            for module_name in ('cogs.assignment', 'cogs.peer_eval', 'cogs.onboarding'):
                module = sys.modules.get(module_name)
                if module and hasattr(module, 'TEAMS'):
                    module.TEAMS[:] = config.TEAM_CHANNELS.keys()
            if 'cogs.admin' in sys.modules:
                sys.modules['cogs.admin'].ADMIN_ROLE_ID = config.ADMIN_ROLE_ID
        return status


async def export_archive(path, guild_id):
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        await db.execute('PRAGMA query_only=ON')
        await db.execute('BEGIN')
        tables = {}
        for table in TABLES:
            async with db.execute(f'SELECT * FROM {table} ORDER BY rowid') as rows:
                tables[table] = [dict(row) for row in await rows.fetchall()]
        async with db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lms_managed_onboarding'") as rows:
            present = await rows.fetchone()
        runtime = []
        if present:
            async with db.execute('SELECT * FROM lms_managed_onboarding') as rows:
                runtime = [dict(row) for row in await rows.fetchall()]
                for row in runtime:
                    row['data'] = json.dumps(pack_runtime(row['kind'], json.loads(row['data'])), ensure_ascii=False)
    data = {'version': 1, 'guildId': str(guild_id), 'tables': tables, 'runtime': runtime, 'settings': {
        'channels': {key: str(getattr(config, key, '') or '') for key in SETTING_NAMES},
        'teams': [{'name': name, 'channelId': str(channel_id or '')} for name, channel_id in config.TEAM_CHANNELS.items()],
        'qaUnansweredHours': config.QA_UNANSWERED_HOURS,
        'qaNotifyRoleIds': [str(value) for value in config.QA_NOTIFY_ROLE_IDS],
    }}
    archive = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    return {'guildId': str(guild_id), 'archive': archive, 'checksum': hashlib.sha256(archive.encode()).hexdigest()}


async def connect_web_storage():
    global client
    endpoint, token = os.getenv('LEARNINGOPS_PROVISION_URL', '').strip(), os.getenv('LEARNINGOPS_PROVISION_TOKEN', '').strip()
    if not endpoint or len(token) < 32:
        log.warning('Web storage not configured; set the provision URL and token to migrate the existing bot data')
        return
    candidate = WebStorage(endpoint, token, config.GUILD_ID)
    archive = None
    # This runs before loading cogs or connecting to Discord: no local writes race the import.
    while True:
        try:
            status = await candidate.request('status', {'guildId': candidate.guild_id})
            if not status['migrated']:
                archive = archive or await export_archive(config.DB_PATH, config.GUILD_ID)
                status = await candidate.request('bootstrap', archive)
                if not status['migrated'] or status['checksum'] != archive['checksum']:
                    raise StorageUnavailable('이관 원본 검증에 실패했습니다.')
            await candidate.refresh_settings()
            break
        except StorageUnavailable as error:
            log.warning('%s Local database is preserved; waiting before accepting new Discord writes.', error)
            await asyncio.sleep(30)
    import database
    for name, fn in inspect.getmembers(database, inspect.iscoroutinefunction):
        if name.startswith('_') or name == 'init_db' or fn.__module__ != 'database':
            continue
        def wrap(original, operation):
            @functools.wraps(original)
            async def remote(*args, **kwargs):
                return await candidate.call(operation, args, kwargs)
            return remote
        setattr(database, name, wrap(fn, name))
    client = candidate
    log.info('Bot storage migrated to web workspace %s; local database retained as backup', status['workspaceId'])
