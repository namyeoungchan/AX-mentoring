import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from web_transport import WebTransport


def response(status, data=None):
    result = MagicMock(status=status)
    result.json = AsyncMock(return_value=data)
    result.__aenter__ = AsyncMock(return_value=result)
    result.__aexit__ = AsyncMock(return_value=False)
    return result


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_lost_response_replays_same_identity_and_payload_once(self):
        transport = WebTransport()
        session = MagicMock()
        lost = response(200)
        lost.json.side_effect = TimeoutError('private connection details')
        session.post.side_effect = [lost, response(200, {'alreadyRecorded': True})]
        body = {'code': '123456', 'discordId': '111', 'guildId': '222'}
        with patch.object(transport, 'session', return_value=session), patch('web_transport.asyncio.sleep', new=AsyncMock()):
            self.assertEqual(await transport.post_json('https://example.com', body=body, token='test', retry=True), (200, {'alreadyRecorded': True}))
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(session.post.call_args_list[0], session.post.call_args_list[1])
        self.assertFalse(session.post.call_args.kwargs['allow_redirects'])

    async def test_permanent_rejections_and_rate_limits_are_not_replayed(self):
        for status in [401, 403, 409, 410, 422, 429]:
            transport, session = WebTransport(), MagicMock()
            session.post.return_value = response(status, {'error': 'rejected'})
            with patch.object(transport, 'session', return_value=session):
                self.assertEqual(await transport.post_json('https://example.com', body={}, token='test', retry=True), (status, {'error': 'rejected'}))
            session.post.assert_called_once()

    async def test_malformed_success_and_gateway_errors_are_bounded_and_sanitized(self):
        for value in [response(200, []), response(200, None), response(502, {'error': 'private upstream'}), response(200, 'not an object')]:
            transport, session = WebTransport(), MagicMock()
            session.post.return_value = value
            with patch.object(transport, 'session', return_value=session), patch('web_transport.asyncio.sleep', new=AsyncMock()):
                status, data = await transport.post_json('https://example.com', body={}, token='test', retry=True)
            self.assertIn(status, [502, 503])
            self.assertIsNone(data)
            self.assertEqual(session.post.call_count, 2)

    async def test_unapproved_write_is_not_retried(self):
        transport, session = WebTransport(), MagicMock()
        session.post.return_value = response(503)
        with patch.object(transport, 'session', return_value=session):
            self.assertEqual(await transport.post_json('https://example.com', body={}, token='test'), (503, None))
        session.post.assert_called_once()
