"""Lifecycle-owned, bounded connection pool for bot-to-web requests."""
import asyncio
import aiohttp

TRANSIENT_STATUSES = {408, 500, 502, 503, 504}


class WebTransport:
    def __init__(self, *, timeout=35, connections=8):
        self.timeout, self.connections = timeout, connections
        self._session = None
        self._closed = False

    def session(self):
        if self._closed:
            raise RuntimeError("Web transport is closed")
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self.timeout, connect=5),
                connector=aiohttp.TCPConnector(limit=self.connections, limit_per_host=self.connections),
            )
        return self._session

    async def close(self):
        self._closed = True
        if self._session is not None:
            await self._session.close()

    async def post_json(self, url, *, body, token, retry=False):
        """Retry only calls whose caller has established replay safety.

        Keep the same identity/payload, never follow credential-bearing redirects,
        and never expose infrastructure response bodies to Discord members.
        """
        for attempt in range(2 if retry else 1):
            status, data = 503, None
            try:
                async with self.session().post(url, json=body,
                                              headers={"Authorization": f"Bearer {token}"},
                                              allow_redirects=False) as response:
                    status = response.status
                    if status not in TRANSIENT_STATUSES:
                        try:
                            data = await response.json()
                        except (aiohttp.ClientError, ValueError):
                            if status == 200:
                                status = 503
                        if data is not None and not isinstance(data, dict):
                            data = None
                        if status == 200 and data is None:
                            status = 503
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                status, data = 503, None
            if status not in TRANSIENT_STATUSES or not retry or attempt == 1:
                return status, data
            await asyncio.sleep(0.5)
