"""Lifecycle-owned, bounded connection pool for bot-to-web requests."""
import aiohttp


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
