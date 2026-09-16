import contextlib
import io
import json
import unittest
import urllib.error
from unittest.mock import Mock

from diagnose_storage import diagnose, NoRedirect


class StorageDiagnosticsTests(unittest.TestCase):
    def run_diagnostic(self, status, payload):
        token = 'secret-must-not-be-printed' * 2
        env = {'GUILD_ID': '123456789012345678', 'LEARNINGOPS_PROVISION_TOKEN': token,
               'LEARNINGOPS_PROVISION_URL': 'https://example.com/api/integrations/discord/provision'}
        response = urllib.error.HTTPError('https://example.com', status, '', {}, io.BytesIO(json.dumps(payload).encode()))
        opener = Mock()
        opener.open.side_effect = response
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = diagnose(env, opener, guild_id=env['GUILD_ID'])
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://example.com/api/integrations/discord/storage/status')
        self.assertEqual(json.loads(request.data), {'guildId': env['GUILD_ID']})
        self.assertNotIn(token, output.getvalue())
        return result, output.getvalue()

    def test_distinguishes_missing_guild_from_development_mode(self):
        result, output = self.run_diagnostic(403, {'error': '웹 워크스페이스에 Discord 서버 ID를 먼저 등록하세요.'})
        self.assertEqual(result, 1)
        self.assertIn('웹 워크스페이스의 Discord 서버 연결', output)
        _, output = self.run_diagnostic(403, {'error': '로컬 개발 서버는 localhost로만 접근할 수 있습니다.'})
        self.assertIn('NODE_ENV', output)

    def test_does_not_log_arbitrary_response_data(self):
        _, output = self.run_diagnostic(403, {'error': 'secret-must-not-be-printed' * 2})
        self.assertIn('알려진 저장소 응답이 아닙니다', output)
        result, _ = self.run_diagnostic(200, {'migrated': True, 'settings': {'private': 'not printed'}})
        self.assertEqual(result, 0)

    def test_rejects_credentials_in_url_and_disables_redirects(self):
        output, opener = io.StringIO(), Mock()
        with contextlib.redirect_stdout(output):
            self.assertEqual(diagnose({'LEARNINGOPS_PROVISION_URL': 'https://user:secret@example.com/api/integrations/discord/provision'}, opener), 2)
        self.assertNotIn('secret', output.getvalue())
        opener.open.assert_not_called()
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example'))


if __name__ == '__main__':
    unittest.main()
