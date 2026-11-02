"""Owner-scoped views of durable jobs; task results survive browser disconnects."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from starlette.concurrency import run_in_threadpool

from app.auth import current_user
from app import job_queue
from app.chat_guidance import supported as guidance_supported

router = APIRouter(prefix='/tasks', tags=['tasks'])

SUMMARY_SQL = """SELECT j.id,j.workspace_id,j.status,j.created_at,j.updated_at,
    left(j.payload->>'prompt',240) AS title, j.payload->>'mode' AS mode,
    j.payload->>'cancel_requested' AS cancel_requested,
    j.payload AS guidance_payload,
    CASE WHEN j.payload->>'research' IS NOT NULL THEN 'research'
         WHEN j.payload->>'workflow' IS NOT NULL THEN 'workflow'
         ELSE 'chat' END AS kind,
    activity.event AS activity, terminal.id AS terminal_event_id, terminal.event AS terminal
    FROM bob_jobs j
    LEFT JOIN LATERAL (SELECT event FROM bob_job_events WHERE job_id=j.id
        AND event->>'type' IN ('status','skill','tool','done','error') ORDER BY id DESC LIMIT 1) activity ON true
    LEFT JOIN LATERAL (SELECT id,event FROM bob_job_events WHERE job_id=j.id
        AND event->>'type' IN ('done','error') ORDER BY id DESC LIMIT 1) terminal ON true
    WHERE j.username=%s"""


def summary(row):
    terminal = row.get('terminal') or {}
    status = row['status']
    if status == 'failed' and (terminal.get('cancelled') or row.get('cancel_requested') == 'true'):
        status = 'stopped'
    activity = row.get('activity') or {}
    message = activity.get('message')
    if activity.get('type') == 'skill':
        message = 'Using skill ' + str(activity.get('name', ''))
    elif activity.get('type') == 'tool':
        message = ('Using ' if activity.get('status') == 'started' else 'Finished ') + str(activity.get('name', '')).replace('_', ' ')
    elif activity.get('type') == 'done' or status == 'completed':
        message = 'Completed'
    return {'id': str(row['id']), 'session_id': row['workspace_id'],
            'title': row.get('title') or 'Untitled task', 'mode': row.get('mode') or 'agent',
            'kind': row.get('kind') or 'chat',
            'guidance_supported': guidance_supported(row.get('guidance_payload') or {}),
            'status': status, 'progress': message or status.capitalize(),
            'created_at': row['created_at'].isoformat(), 'updated_at': row['updated_at'].isoformat(),
            'duration_ms': terminal.get('duration_ms'),
            'cost': terminal.get('cost'), 'tokens': terminal.get('tokens'),
            'terminal_event_id': row.get('terminal_event_id') if status in {'completed','failed','stopped'} else None}


def recover_task_usage(username, rows):
    from app.task_usage import recover_usage
    groups = {}
    for row in rows:
        groups.setdefault(row['workspace_id'], []).append(row)
    for session_id, group in groups.items():
        recovered = recover_usage(username, session_id, [row.get('terminal') or {} for row in group])
        for row, terminal in zip(group, recovered):
            row['terminal'] = terminal
    return rows


def list_tasks(username, limit=100):
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        rows = db.execute(SUMMARY_SQL + ' ORDER BY j.created_at DESC LIMIT %s', (username, limit)).fetchall()
    return [summary(row) for row in recover_task_usage(username, rows)]


def task_detail(username, task_id):
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        row = db.execute(SUMMARY_SQL + ' AND j.id=%s', (username, task_id)).fetchone()
        if not row:
            return None
        # A replace event starts a new answer; do not concatenate discarded text.
        result = db.execute("""SELECT left(string_agg(event->>'text','' ORDER BY id),1000000) AS text
            FROM bob_job_events WHERE job_id=%s AND event->>'type'='delta' AND id >= coalesce(
                (SELECT max(id) FROM bob_job_events WHERE job_id=%s AND event->>'type'='delta'
                 AND event->>'replace'='true'),0)""", (task_id, task_id)).fetchone()
        steps = db.execute("""SELECT id,event,created_at FROM bob_job_events
            WHERE job_id=%s AND event->>'type' IN ('start','status','skill','tool','done','error')
            ORDER BY id DESC LIMIT 100""", (task_id,)).fetchall()
    recover_task_usage(username, [row])
    return {**summary(row), 'result': result['text'] or '',
            'steps': [{'id': step['id'], 'type': step['event']['type'],
                       'message': summary({**row, 'activity': step['event'], 'status': 'running'})['progress'],
                       'timestamp': step['created_at'].isoformat()} for step in reversed(steps)]}


@router.get('')
async def get_tasks(response: Response, limit: int = Query(100, ge=1, le=200), user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return await run_in_threadpool(list_tasks, user['username'], limit)


@router.get('/{task_id}')
async def get_task(task_id: uuid.UUID, response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    detail = await run_in_threadpool(task_detail, user['username'], str(task_id))
    if detail is None:
        raise HTTPException(404, 'Task not found')
    return detail
