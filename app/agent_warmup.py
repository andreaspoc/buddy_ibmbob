"""Single-job agent warmup handles; never share a process across users or attempts."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any


@dataclass
class AgentWarmup:
    identity: tuple
    client: Any
    prompt: asyncio.Future
    task: asyncio.Task | None = None

    def submit(self, identity: tuple, prompt: str) -> None:
        if identity != self.identity:
            raise RuntimeError('Prepared agent belongs to a different job or workspace')
        if self.prompt.done():
            raise RuntimeError('Prepared agent has already received a request')
        self.prompt.set_result(prompt)

    async def close(self) -> None:
        if self.task is None:
            return
        if not self.task.done():
            self.task.cancel()
        # Collect cancellation of the child, while allowing cancellation of
        # this close() caller to propagate normally.
        result, = await asyncio.gather(self.task, return_exceptions=True)
        if isinstance(result, Exception):
            logging.getLogger(__name__).warning('Prepared agent owner stopped unexpectedly (%s)', type(result).__name__)
