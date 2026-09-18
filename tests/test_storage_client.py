import importlib
import json
import os
import tempfile
import unittest
from datetime import date
from unittest.mock import AsyncMock, patch

with patch.dict(os.environ, {'DISCORD_TOKEN': 'test-only', 'GUILD_ID': '123456789012345678', 'ADMIN_ROLE_ID': '123456789012345679', 'ONBOARDING_CHANNEL_ID': '123456789012345680', 'INTRO_CHANNEL_ID': '123456789012345681'}):
    module = importlib.import_module('storage_client')
from storage_codec import encode, decode
from cogs.lms_onboarding_store import OnboardingStore


class StorageClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_permanent_errors_are_not_retried(self):
        client = module.WebStorage('https://example.com/api/integrations/discord/provision', 'x' * 32, 123456789012345678)
        client.request = AsyncMock(side_effect=module.StorageUnavailable('conflict', retryable=False))
        with self.assertRaises(module.StorageUnavailable):
            await client.call('add_mentor', ('555456789012345678', 'name'), {})
        self.assertEqual(client.request.await_count, 1)

    async def test_transport_reuses_a_bounded_session_and_cannot_reopen_after_close(self):
        from web_transport import WebTransport
        transport = WebTransport(connections=3)
        session = transport.session()
        self.assertIs(transport.session(), session)
        self.assertEqual(session.connector.limit, 3)
        await transport.close()
        self.assertTrue(session.closed)
        with self.assertRaises(RuntimeError):
            transport.session()

    def test_typed_results_and_discord_ids_survive_json_transport(self):
        value = {123456789012345678: ({'student'}, date(2026, 9, 16), 123456789012345678)}
        self.assertEqual(decode(json.loads(json.dumps(encode(value)))), value)

    async def test_retry_keeps_receipt_id_and_does_not_fall_back_to_local_storage(self):
        client = module.WebStorage('https://example.com/api/integrations/discord/provision', 'x' * 32, 123456789012345678)
        client.request = AsyncMock(side_effect=[module.StorageUnavailable('offline'), {'result': 42}])
        self.assertEqual(await client.call('add_mentor', ('555456789012345678', '이름'), {}), 42)
        calls = client.request.call_args_list
        self.assertEqual(calls[0].args[1]['requestId'], calls[1].args[1]['requestId'])
        client.request = AsyncMock(side_effect=module.StorageUnavailable('offline'))
        with self.assertRaises(module.StorageUnavailable):
            await client.call('add_mentor', ('555456789012345678', '이름'), {})

    async def test_runtime_storage_uses_web_and_preserves_exact_snowflakes(self):
        rows = {}
        async def request(_operation, body):
            if body['operation'] == 'put':
                rows[body['key']] = json.loads(json.dumps(body['value']))
                return {'ok': True}
            return rows.get(body['key'])
        client = type('Client', (), {'request': staticmethod(request)})()
        with patch.object(module, 'client', client):
            store = OnboardingStore('must-not-be-created.db')
            await store.initialize()
            await store.put('123456789012345678', 'channel', 'start', {'id': 1507392706647822438})
            self.assertEqual(rows['start']['id'], '1507392706647822438')
            self.assertEqual((await store.get('123456789012345678', 'channel', 'start'))['id'], 1507392706647822438)
        self.assertFalse(os.path.exists('must-not-be-created.db'))

    async def test_export_includes_all_tables_without_row_limit_and_does_not_change_source(self):
        import aiosqlite
        import database
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'source.db')
            with patch.object(database, 'DB_PATH', path):
                await database.init_db()
            async with aiosqlite.connect(path) as db:
                await db.executemany('INSERT INTO qa_alerts(thread_id) VALUES(?)', [(str(123456789012345000 + i),) for i in range(1005)])
                await db.commit()
            result = await module.export_archive(path, module.config.GUILD_ID)
            archive = json.loads(result['archive'])
            self.assertEqual(set(archive['tables']), set(module.TABLES))
            self.assertEqual(len(archive['tables']['qa_alerts']), 1005)
            self.assertNotIn('DISCORD_TOKEN', result['archive'])
            async with aiosqlite.connect(path) as db:
                async with db.execute('SELECT COUNT(*) FROM qa_alerts') as rows:
                    self.assertEqual((await rows.fetchone())[0], 1005)


if __name__ == '__main__':
    unittest.main()
