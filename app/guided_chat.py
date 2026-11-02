"""Gracefully pause a headless Buddy turn and resume with fresh user guidance."""
from __future__ import annotations

from app.branding import brand_text
import asyncio
import sqlite3
from pathlib import Path
from contextlib import suppress
from app import chat_guidance


def task_ids(database):
    if not database.is_file():
        return set()
    try:
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=1) as db:
            return {row[0] for row in db.execute('SELECT id FROM tasks')}
    except sqlite3.Error:
        return None  # Never select an older task when the baseline is unknown.


def resumed_task(database, prompt, workspace, baseline, known):
    if not database.is_file():
        return None
    try:
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=1) as db:
            if known and db.execute("SELECT 1 FROM tasks WHERE id=? AND directory=? AND parent_id IS NULL AND task_type='normal'", (known, str(workspace))).fetchone():
                return known
            if baseline is None:
                return None
            rows = db.execute("SELECT id FROM tasks WHERE first_message=? AND directory=? AND parent_id IS NULL AND task_type='normal'", (prompt, str(workspace))).fetchall()
        candidates = [row[0] for row in rows if row[0] not in baseline]
        return candidates[0] if len(candidates) == 1 else None
    except sqlite3.Error:
        return None


def guided_prompt(original, notes, partial=''):
    guidance = '\n'.join(f'{index + 1}. {note["instruction"]}' for index, note in enumerate(notes))
    return (original + '\n\n[New instructions from the user for this same task]\n' + guidance +
        '\nApply these instructions to the original request; newer instructions take priority when they conflict. '
        'Continue using the current workspace and inspect saved work before repeating any tool actions. '
        'Interrupted tools may already have made changes; do not repeat external actions blindly. '
        'Your earlier answer was provisional. Return a complete updated answer reflecting the guidance.\n' +
        ('Provisional answer before the interruption:\n' + partial[-12000:] if partial else ''))


async def stream_guided_chat(bridge, prompt, job, *, workspace, user_home, mode):
    job_id, token = str(job['id']), str(job['worker_token'])
    database = Path(user_home) / '.bob' / 'db' / 'bob.db'
    await asyncio.to_thread(chat_guidance.open_intake, job_id, token)
    all_notes = await asyncio.to_thread(chat_guidance.instructions, job_id)
    applied_ids = {note['id'] for note in all_notes}
    current_prompt = guided_prompt(prompt, all_notes) if all_notes else prompt
    resume_id = job['payload'].get('session_id')
    partial = ''
    while True:
        baseline = await asyncio.to_thread(task_ids, database)
        source = bridge.stream(current_prompt, resume_id, mode, workspace=str(workspace),
                               user_home=str(user_home), shutdown_grace=5, username=job['username'])
        next_event = asyncio.create_task(anext(source))
        notes_task = None
        incoming = []
        try:
            if all_notes:
                await asyncio.to_thread(chat_guidance.applied, job_id, token, list(applied_ids))
            notes_task = asyncio.create_task(asyncio.sleep(.5))
            while True:
                ready, _ = await asyncio.wait({next_event, notes_task}, return_when=asyncio.FIRST_COMPLETED)
                if notes_task in ready:
                    pending = await asyncio.to_thread(chat_guidance.instructions, job_id, pending=True)
                    incoming = [note for note in pending if note['id'] not in applied_ids]
                    if incoming:
                        break
                    notes_task = asyncio.create_task(asyncio.sleep(.5))
                if next_event in ready:
                    try:
                        event = next_event.result()
                    except StopAsyncIteration:
                        yield {'type': 'error', 'message': brand_text('Buddy stopped without a result')}
                        return
                    if event['type'] == 'done':
                        resume_id = event.get('session_id') or resume_id
                        if await asyncio.to_thread(chat_guidance.close_if_ready, job_id, token):
                            yield event
                            return
                        incoming = await asyncio.to_thread(chat_guidance.instructions, job_id, pending=True)
                        break
                    if event['type'] == 'error':
                        yield event
                        return
                    if event['type'] == 'delta':
                        partial = event.get('text', '') if event.get('replace') else partial + event.get('text', '')
                    yield event
                    next_event = asyncio.create_task(anext(source))
        finally:
            if notes_task is not None:
                notes_task.cancel()
                with suppress(asyncio.CancelledError):
                    await notes_task
            if not next_event.done():
                next_event.cancel()
            with suppress(asyncio.CancelledError, StopAsyncIteration):
                await next_event
            await source.aclose()  # Wait for Bob and tool processes before resuming.
        yield {'type': 'status', 'message': 'Applying your guidance…'}
        resume_id = await asyncio.to_thread(resumed_task, database, current_prompt, workspace, baseline, resume_id)
        # A second note may have arrived during graceful process shutdown.
        incoming = await asyncio.to_thread(chat_guidance.instructions, job_id, pending=True)
        all_notes.extend(note for note in incoming if note['id'] not in applied_ids)
        applied_ids.update(note['id'] for note in incoming)
        current_prompt = guided_prompt(prompt, all_notes, partial if not resume_id else '')
        for note in incoming:
            yield {'type': 'guidance', 'id': note['id'], 'text': note['instruction'], 'status': 'applied'}
        yield {'type': 'delta', 'text': '', 'replace': True}
        partial = ''
