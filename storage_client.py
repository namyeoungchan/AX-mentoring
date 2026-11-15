"""Route each Discord guild to web-owned storage and import its legacy DB once."""
import asyncio
import functools
import hashlib
import inspect
import json
import logging
import os
import random
import uuid

import aiohttp
import aiosqlite
import config
from storage_codec import encode, decode, pack_runtime
from web_transport import WebTransport

log = logging.getLogger("asanAX.storage")
client = None
TABLES = ('mentors', 'slots', 'bookings', 'panels', 'slot_templates', 'blocked_dates', 'reminders', 'qa_alerts', 'blocked_weekdays', 'onboarding_progress', 'assignments', 'submissions', 'assignment_panels', 'assignment_reminders', 'peer_eval_rounds', 'peer_evaluations')
SETTING_NAMES = ('ADMIN_ROLE_ID', 'STUDENT_ROLE_ID', 'ONBOARDING_COMPLETE_ROLE_ID', 'ONBOARDING_CHANNEL_ID', 'INTRO_CHANNEL_ID', 'ASSIGNMENT_DASHBOARD_CHANNEL_ID', 'ASSIGNMENT_SUBMIT_CHANNEL_ID', 'MENTORING_CHANNEL_ID', 'QA_FORUM_CHANNEL_ID')


class StorageUnavailable(TimeoutError):
    def __init__(self, message, *, retryable=True):
        super().__init__(message)
        self.retryable = retryable


class WebStorage:
    def __init__(self, endpoint, token, guild_id, *, transport=None):
        from cogs.lms_provision import validate_provision_endpoint
        self.url = validate_provision_endpoint(endpoint).rsplit('/', 1)[0] + '/storage'
        self.token, self.guild_id = token, str(guild_id)
        self.transport = transport or WebTransport()

    async def close(self):
        await self.transport.close()

    async def request(self, operation, body):
        try:
            async with self.transport.session().post(f'{self.url}/{operation}', json=body, headers={'Authorization': f'Bearer {self.token}'}, allow_redirects=False) as response:
                if response.status != 200:
                    guidance = '웹의 봇 데이터 이관 상태를 확인하세요.'
                    if response.status == 403:
                        guidance = (
                            '웹에서 이 Discord 서버와 워크스페이스의 1:1 연결을 확인하세요. '
                            '웹 서비스의 NODE_ENV=production 및 봇의 LEARNINGOPS_PROVISION_URL도 확인하세요.'
                        )
                    elif response.status == 401:
                        guidance = '봇과 웹 서비스의 LEARNINGOPS_PROVISION_TOKEN이 같은지 확인하세요.'
                    elif response.status == 409 and operation == 'call':
                        guidance = '워크스페이스 보관 상태 또는 요청 충돌을 확인하세요.'
                        try:
                            body = await response.json()
                            if isinstance(body, dict) and body.get('error') == '보관된 워크스페이스입니다.':
                                guidance = '보관된 워크스페이스의 자동 작업이 중지될 때까지 기다리세요.'
                        except (aiohttp.ClientError, ValueError):
                            pass
                    raise StorageUnavailable(f'웹 데이터 연결 오류 (HTTP {response.status}, 작업={operation}). {guidance}', retryable=response.status in {408, 429, 500, 502, 503, 504})
                return await response.json()
        except StorageUnavailable:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
            raise StorageUnavailable('웹 데이터 저장소에 연결하지 못했습니다. 잠시 후 다시 시도하세요.') from error

    async def call(self, operation, args, kwargs):
        body = {'guildId': self.guild_id, 'operation': operation, 'args': encode(list(args)), 'kwargs': encode(kwargs), 'requestId': str(uuid.uuid4())}
        # If the response is lost after a commit, replay the same receipt ID.
        for attempt in range(2):
            try:
                return decode((await self.request('call', body))['result'])
            except StorageUnavailable as error:
                if attempt or not error.retryable:
                    raise
                await asyncio.sleep(random.uniform(0.2, 0.6))

    async def refresh_settings(self):
        status = await self.request('status', {'guildId': self.guild_id})
        config.install_workspace(self.guild_id, status)
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


async def legacy_source_guild(path):
    """Identify the old DB's owner once; never copy it to each discovered server."""
    async with aiosqlite.connect(path) as db:
        await db.execute('PRAGMA query_only=ON')
        has_data = False
        for table in TABLES:
            async with db.execute(f'SELECT 1 FROM {table} LIMIT 1') as rows:
                has_data = has_data or await rows.fetchone() is not None
        if not has_data:
            return None
        owners = set()
        for table in ('panels', 'onboarding_progress'):
            async with db.execute(f'SELECT DISTINCT guild_id FROM {table}') as rows:
                owners.update(int(row[0]) for row in await rows.fetchall() if row[0])
    explicit = config.LEGACY_IMPORT_GUILD_ID
    if explicit and (not owners or owners == {explicit}):
        return explicit
    if not explicit and len(owners) == 1:
        return owners.pop()
    # Old deployments can still identify an otherwise unlabelled local archive.
    if not explicit and not owners and config.GUILD_ID:
        return config.GUILD_ID
    raise StorageUnavailable('기존 로컬 DB의 원본 서버를 확정할 수 없습니다. LEGACY_IMPORT_GUILD_ID로 일회성 이관 대상을 지정하세요.')


class WorkspaceStorage:
    def __init__(self, endpoint, token):
        self.transport = None
        self.ready = {}
        self.clients = {}
        self.legacy_guild_id = None
        self.legacy_checked = False
        self.archive = None
        if endpoint and len(token) >= 32:
            try:
                self.transport = WebStorage(endpoint, token, 0)
            except ValueError:
                log.error('Invalid LEARNINGOPS_PROVISION_URL; Discord can connect but workspace storage is unavailable')
        else:
            log.warning('Set LEARNINGOPS_PROVISION_URL and LEARNINGOPS_PROVISION_TOKEN to enable workspace storage')

    async def request(self, operation, body):
        if not self.transport:
            raise StorageUnavailable('웹 저장소 연결 설정이 필요합니다.')
        return await self.transport.request(operation, body)

    async def close(self):
        if self.transport:
            await self.transport.close()

    async def refresh(self, guild_ids):
        if not self.legacy_checked:
            try:
                self.legacy_guild_id = await legacy_source_guild(config.DB_PATH)
            except StorageUnavailable as error:
                # The archive is preserved for an explicit import; never guess its destination.
                log.warning('%s 공통 봇의 다른 워크스페이스 연결은 계속합니다.', error)
            self.legacy_checked = True
        try:
            result = await self.request('registry', {'guildIds': [str(gid) for gid in guild_ids]})
        except Exception:
            self.ready = {}
            raise
        self.ready = {}
        allowed = set(map(int, guild_ids))
        states = {int(row['guildId']): row for row in result['workspaces'] if int(row['guildId']) in allowed}
        ready = {}
        for guild_id, status in states.items():
            if guild_id == self.legacy_guild_id and not status['migrated']:
                continue
            config.install_workspace(guild_id, status)
            ready[guild_id] = status
        self.ready = ready
        for failure in result.get('unavailable', []):
            log.warning('Workspace storage unavailable: guild=%s reason=%s', failure['guildId'], failure['code'])
        # Publish other ready workspaces before attempting the one legacy import.
        if self.legacy_guild_id in states and self.legacy_guild_id not in ready:
            try:
                self.archive = self.archive or await export_archive(config.DB_PATH, self.legacy_guild_id)
                status = await self.request('bootstrap', self.archive)
                if not status['migrated'] or status['checksum'] != self.archive['checksum']:
                    raise StorageUnavailable('이관 원본 검증에 실패했습니다.')
                status = await self.request('status', {'guildId': str(self.legacy_guild_id)})
                config.install_workspace(self.legacy_guild_id, status)
                self.ready[self.legacy_guild_id] = status
                log.info('Legacy bot data imported into workspace %s', status['workspaceId'])
            except Exception as error:
                reason = str(error) if isinstance(error, StorageUnavailable) else type(error).__name__
                log.warning('Legacy import pending for guild %s (%s); other workspaces remain available', self.legacy_guild_id, reason)

    async def refresh_settings(self, guild_id):
        status = await self.request('status', {'guildId': str(guild_id)})
        config.install_workspace(guild_id, status)
        if int(guild_id) in self.ready:
            self.ready[int(guild_id)] = status
        return status

    async def call(self, operation, args, kwargs):
        guild_id = config.workspace_guild.get()
        if guild_id not in self.ready:
            raise StorageUnavailable('이 Discord 서버의 워크스페이스 저장소가 준비되지 않았습니다.')
        if guild_id not in self.clients:
            self.clients[guild_id] = WebStorage(self.transport.url.rsplit('/', 1)[0] + '/provision', self.transport.token, guild_id, transport=self.transport.transport)
        return await self.clients[guild_id].call(operation, args, kwargs)


async def connect_web_storage():
    """Install routing immediately. Network checks run only after Discord connects."""
    global client
    config.managed_storage = True
    client = WorkspaceStorage(os.getenv('LEARNINGOPS_PROVISION_URL', '').strip(), os.getenv('LEARNINGOPS_PROVISION_TOKEN', '').strip())
    import database
    for name, fn in inspect.getmembers(database, inspect.iscoroutinefunction):
        if name.startswith('_') or name == 'init_db' or fn.__module__ != 'database':
            continue
        def wrap(original, operation):
            @functools.wraps(original)
            async def remote(*args, **kwargs):
                return await client.call(operation, args, kwargs)
            return remote
        setattr(database, name, wrap(fn, name))
    return client
