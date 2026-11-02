"""Fresh, tool-free specialist sessions; never inherit a chat's credentials or history."""
from __future__ import annotations
import asyncio
from pathlib import Path
import tempfile
from acp import PROTOCOL_VERSION
from acp.schema import TextContentBlock
from app.acp_bridge import CaptureClient, approval_child_environment, approval_agent_process, _get_task_usage


class SpecialistClient(CaptureClient):
    async def session_update(self, session_id, update, **kwargs):
        await super().session_update(session_id, update, **kwargs)
        self.events.clear()
        if sum(map(len, self.text_chunks)) > 24000:
            raise ValueError('Specialist response exceeds the handoff limit')


async def complete(prompt: str, *, with_usage: bool = False) -> str | dict:
    client = SpecialistClient()
    usage = {}
    async with asyncio.timeout(90):
        with tempfile.TemporaryDirectory(prefix='buddy-app-agent-') as directory:
            root = Path(directory)
            work, home = root / 'work', root / 'home'
            work.mkdir(); home.mkdir()
            async with approval_child_environment(str(home), '') as environment:
                async with approval_agent_process(client, str(work), environment, disable_mcp=True) as (connection, _):
                    await connection.initialize(protocol_version=PROTOCOL_VERSION)
                    session = await connection.new_session(cwd=str(work), mcp_servers=[])
                    response = await connection.prompt(session_id=session.session_id,
                        prompt=[TextContentBlock(type='text', text=prompt)])
                    if getattr(response, 'stop_reason', None) in ('cancelled', 'refusal'):
                        raise RuntimeError('App specialist did not complete the request')
                    usage = await asyncio.to_thread(_get_task_usage, home / '.bob' / 'db' / 'bob.db', session.session_id)
    result = ''.join(client.text_chunks).strip()
    if not result or len(result) > 24000:
        raise RuntimeError('App specialist returned no usable result')
    return {'reply': result, 'usage': usage} if with_usage else result
