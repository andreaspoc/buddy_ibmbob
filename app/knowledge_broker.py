"""Per-run shared-knowledge capability; database credentials stay in the service.

This limits the protocol, not the OS privileges of a Buddy process running as the
same user. Production runners still require filesystem and process isolation.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

MAX_QUERY_BYTES = 8192
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_REQUESTS = 32


async def search_shared(query: str, username: str | None = None) -> str:
    from app import rag
    if not username:
        raise PermissionError('Authenticated knowledge user required')
    passages = await rag.retrieve(username, 'shared', query)
    return rag.attach_context('', passages, 'shared') if passages else 'No relevant passages found in the ready shared knowledge sources.'


@asynccontextmanager
async def knowledge_broker(events: asyncio.Queue | None = None, *, username: str | None = None, budget=None):
    """Offer bounded shared search only, with no caller-selected tenant or action."""
    tasks = set()
    requests = 0
    from app.agent_budget import RunBudget
    budget = budget or RunBudget(username)
    if budget.username != username:
        raise PermissionError('Knowledge budget owner mismatch')

    async def handle(reader, writer):
        nonlocal requests
        task = asyncio.current_task()
        tasks.add(task)
        tool_id = None
        try:
            requests += 1
            if requests > MAX_REQUESTS:
                raise ValueError('Knowledge request limit exceeded')
            raw = await asyncio.wait_for(reader.readline(), 5)
            payload = json.loads(raw)
            if not isinstance(payload, dict) or set(payload) != {'query'}:
                raise ValueError('Invalid knowledge request')
            query = payload['query']
            if not isinstance(query, str) or not query.strip() or len(query.encode()) > MAX_QUERY_BYTES:
                raise ValueError('Invalid knowledge query')
            await budget.consume('tool')
            tool_id = uuid.uuid4().hex
            if events is not None:
                await events.put({'type': 'tool', 'id': tool_id, 'name': 'knowledge_search',
                                  'status': 'started', 'input': {'query': query}})
            result = await asyncio.wait_for(search_shared(query, username), 90)
            response = json.dumps({'text': result}).encode() + b'\n'
            if len(response) > MAX_RESPONSE_BYTES:
                raise ValueError('Knowledge response too large')
            if events is not None:
                await events.put({'type': 'tool', 'id': tool_id, 'name': 'knowledge_search',
                                  'status': 'completed', 'output': result})
        except Exception:
            response = b'{"error":"Knowledge search failed or request limit exceeded"}\n'
            if events is not None and tool_id is not None:
                await events.put({'type': 'tool', 'id': tool_id, 'name': 'knowledge_search',
                                  'status': 'failed', 'output': 'Knowledge search failed. Check source readiness and the embedding service.'})
        finally:
            try:
                if 'response' in locals():
                    writer.write(response)
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
                tasks.discard(task)

    with tempfile.TemporaryDirectory(prefix='bob-knowledge-') as directory:
        path = str(Path(directory) / 'search.sock')
        server = await asyncio.start_unix_server(handle, path=path, limit=MAX_QUERY_BYTES + 128)
        os.chmod(path, 0o600)
        try:
            yield path
        finally:
            server.close()
            await server.wait_closed()
            active = list(tasks)
            for task in active:
                task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
