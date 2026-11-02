"""Stream bounded previews of changed generated files without publishing workspaces."""
from app.presentation import artifact_role
import asyncio
import hashlib
from pathlib import Path
from contextlib import aclosing, suppress
from itertools import chain

KINDS={'.bobdeck':'bobdeck','.html':'html','.htm':'html','.jsx':'react','.tsx':'react','.mmd':'mermaid','.mermaid':'mermaid','.md':'markdown'}
LIMIT=2_000_000

async def artifact_events(connection, job_id, read_events, after_id=0):
    """Follow durable events; notifications accelerate delivery but never gate it."""
    cursor_id = max(0, after_id)
    heartbeat_at = asyncio.get_running_loop().time() + 15
    while True:
        rows, status = await read_events(connection, job_id, cursor_id)
        for row in rows:
            cursor_id = row['id']
            if row['event'].get('type') in {'artifact', 'done', 'error'}:
                yield {**row['event'], 'event_id': cursor_id}
        if len(rows) >= 200:
            continue
        if status not in {'queued', 'running'}:
            # Status and events are separate reads. A worker can commit its final
            # events between them; drain once more after observing termination.
            final_rows, _ = await read_events(connection, job_id, cursor_id)
            if final_rows:
                for row in final_rows:
                    cursor_id = row['id']
                    if row['event'].get('type') in {'artifact', 'done', 'error'}:
                        yield {**row['event'], 'event_id': cursor_id}
                continue
            yield {'type': 'complete'}
            return
        # Notifications can be lost between a read and registering the listener,
        # or when the database reconnects. Recheck persisted events at least once
        # per second, even if no notification arrives.
        async with aclosing(connection.notifies(timeout=1.0)) as notifications:
            async for notice in notifications:
                if notice.payload == job_id:
                    break
        now = asyncio.get_running_loop().time()
        if now >= heartbeat_at:
            yield {'type': 'heartbeat'}
            heartbeat_at = now + 15

def snapshots(workspace,preferred_paths=None):
    root=Path(workspace).resolve()
    result={}
    preferred=[]
    for requested in preferred_paths or []:
        path=Path(requested)
        path=(root/path) if not path.is_absolute() else path
        if path.is_relative_to(root):preferred.append(path)
    for path in chain(preferred,root.rglob('*')):
        relative=path.relative_to(root)
        if str(relative) in result:continue
        if any(part.startswith('.') or part in {'node_modules','vendor'} for part in relative.parts):continue
        if path.name in {'AGENTS.md','README.md'} or path.suffix.lower() not in KINDS:continue
        try:
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):continue
            if path.stat().st_size>LIMIT:continue
            raw=path.read_bytes()
            text=raw.decode('utf-8')
            if not text.strip():continue
            is_research = str(relative) == 'research-report.md' or str(relative).startswith('research-')
            result[str(relative)]={'type':'artifact','path':str(relative),'kind':'research' if is_research else KINDS[path.suffix.lower()],'content':text,'sha256':hashlib.sha256(raw).hexdigest(),'live':True,'is_research':is_research,**artifact_role(str(relative),text)}
            if len(result)>=25:break
        except (OSError,UnicodeDecodeError):continue
    return result

async def stream_live_artifacts(source,workspace,initial_paths=None):
    initial=await asyncio.to_thread(snapshots,workspace,initial_paths)
    previous={key:item['sha256'] for key,item in initial.items()}
    requested=set()
    root=Path(workspace).resolve()
    for path in initial_paths or []:
        candidate=Path(path)
        candidate=(root/candidate).resolve() if not candidate.is_absolute() else candidate.resolve()
        if candidate.is_relative_to(root):requested.add(str(candidate.relative_to(root)))
    async with aclosing(source) as stream:
        for path,item in initial.items():
            if path in requested:yield item
        pending=asyncio.create_task(anext(stream))
        next_snapshot=asyncio.get_running_loop().time()+0.5
        try:
            while True:
                finished,_=await asyncio.wait({pending},timeout=0.5)
                event=None
                ended=False
                if finished:
                    try:event=pending.result()
                    except StopAsyncIteration:ended=True
                now=asyncio.get_running_loop().time()
                # Text chunks can arrive hundreds of times per second. Scan on
                # the polling cadence, tool updates, and completion instead.
                if now>=next_snapshot or ended or (event and event.get('type') in {'tool','done','error'}):
                    current=await asyncio.to_thread(snapshots,workspace,initial_paths)
                    next_snapshot=asyncio.get_running_loop().time()+0.5
                    for path,item in current.items():
                        if previous.get(path)!=item['sha256']:
                            previous[path]=item['sha256'];yield item
                if ended:break
                if not finished:continue
                yield event
                if event.get('type') in {'done','error'}:break
                pending=asyncio.create_task(anext(stream))
        finally:
            pending.cancel()
            with suppress(asyncio.CancelledError,StopAsyncIteration):await pending
