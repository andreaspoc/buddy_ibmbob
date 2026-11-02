"""Coalesce tiny model text events without delaying the first text or status events."""
import asyncio
from contextlib import suppress
from typing import AsyncIterator


async def coalesce_text(stream: AsyncIterator[dict], interval: float = .016, max_chars: int = 4096):
    pending = None
    parts = []
    length = 0
    deadline = None
    first_text = True
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(anext(stream))
            if parts:
                remaining = max(0, deadline - asyncio.get_running_loop().time())
                ready, _ = await asyncio.wait({pending}, timeout=remaining)
                if not ready:
                    yield {'type': 'delta', 'text': ''.join(parts)}
                    parts, length, deadline = [], 0, None
                    continue
            try:
                event = await pending
            except StopAsyncIteration:
                if parts: yield {'type': 'delta', 'text': ''.join(parts)}
                return
            finally:
                pending = None
            if event.get('type') == 'delta' and isinstance(event.get('text'), str) and not event.get('replace'):
                if first_text:
                    first_text = False
                    yield event
                    continue
                if not parts: deadline = asyncio.get_running_loop().time() + interval
                parts.append(event['text'])
                length += len(event['text'])
                if length >= max_chars or asyncio.get_running_loop().time() >= deadline:
                    yield {'type': 'delta', 'text': ''.join(parts)}
                    parts, length, deadline = [], 0, None
            else:
                if parts:
                    yield {'type': 'delta', 'text': ''.join(parts)}
                    parts, length, deadline = [], 0, None
                yield event
    finally:
        if pending is not None:
            pending.cancel()
            with suppress(asyncio.CancelledError, StopAsyncIteration): await pending
