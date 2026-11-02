"""Owner-scoped notifications derived from actual durable task and feedback state."""
from threading import Lock
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from app import job_queue
from app.auth import current_user

router = APIRouter(prefix='/notifications', tags=['notifications'])
_lock = Lock()
_ready = False


def ensure_schema():
    global _ready
    job_queue.ensure_schema()
    from app.answer_feedback import ensure_schema as feedback_schema
    feedback_schema()
    from app.toolbar_reminders import ensure_schema as reminder_schema
    reminder_schema()
    from app import rag
    rag.ensure_schema()
    from app.plugin_client import enabled
    import os
    if enabled('people') and not os.getenv('BUDDY_PEOPLE_PLUGIN_URL', '').strip():
        from app.community import ensure_schema as community_schema
        community_schema()
    with _lock:
        if not _ready:
            with job_queue._connect() as db:
                db.execute('''CREATE TABLE IF NOT EXISTS bob_notification_reads (
                    username TEXT NOT NULL, notification_id TEXT NOT NULL,
                    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY(username,notification_id))''')
            _ready = True


# Each branch scopes to the authenticated owner before any rows are returned.
ITEMS_SQL = '''WITH items AS (
    SELECT 'task:' || j.id::text || ':' || j.updated_at::text AS id,
        CASE WHEN j.payload ? 'research' THEN 'research' ELSE 'task' END AS kind,j.status,
        left(COALESCE(NULLIF(j.payload#>>'{research,title}',''),j.payload->>'prompt','Task'),240) AS title,
        j.updated_at AS occurred_at,j.id::text AS job_id,j.workspace_id AS session_id
        FROM bob_jobs j WHERE j.username=%s AND j.status IN ('completed','failed')
        AND (NOT j.payload ? 'research' OR j.payload->>'cancel_requested' IS DISTINCT FROM 'true')
    UNION ALL
    SELECT 'approval:' || a.id::text,'approval','pending',
        left(COALESCE(j.payload->>'prompt','Task approval required'),240),a.created_at,
        j.id::text,j.workspace_id FROM bob_job_approvals a JOIN bob_jobs j ON j.id=a.job_id
        WHERE j.username=%s AND a.decision IS NULL AND j.status='running'
        AND a.worker_token=j.worker_token
    UNION ALL
    SELECT 'feedback:' || f.id::text || ':' || f.updated_at::text,'feedback',f.status,
        'Answer feedback ' || f.status,f.updated_at,NULL,f.session_id
        FROM bob_answer_feedback f WHERE f.username=%s AND f.updated_at>f.created_at
) SELECT items.*,r.read_at FROM items LEFT JOIN bob_notification_reads r
ON r.username=%s AND r.notification_id=items.id ORDER BY occurred_at DESC LIMIT 500'''


def knowledge_notifications(db, username):
    """Use the current retrieval policy; audit history never grants source access."""
    from app import rag
    scope, params = rag.access_filter(username, alias='d')
    sql = f"""WITH items AS (
        SELECT 'knowledge-change:' || a.id::text AS id,'knowledge'::text AS kind,
            a.action AS status,d.filename AS title,a.created_at AS occurred_at,
            NULL::text AS job_id,NULL::text AS session_id,d.id::text AS document_id,
            '/knowledge/' || d.id::text || '/file' AS source_url,d.owner,d.review_due
        FROM bob_access_audit a JOIN bob_knowledge_documents d ON a.target=d.id::text
        WHERE d.visibility='shared' AND {scope} AND a.created_at>=now()-interval '30 days'
            AND a.action IN ('replace-document','describe-document','classify-document','review-document')
        UNION ALL
        SELECT 'knowledge-review:' || d.id::text || ':' || d.review_due::text,
            'knowledge',CASE WHEN d.review_due<CURRENT_DATE THEN 'review_overdue' ELSE 'review_due' END,
            d.filename,d.review_due::timestamptz,NULL,NULL,d.id::text,
            '/knowledge/' || d.id::text || '/file',d.owner,d.review_due
        FROM bob_knowledge_documents d
        WHERE d.visibility='shared' AND {scope} AND d.review_due<=CURRENT_DATE+7
    ) SELECT items.*,r.read_at FROM items LEFT JOIN bob_notification_reads r
      ON r.username=%s AND r.notification_id=items.id ORDER BY occurred_at DESC LIMIT 200"""
    return db.execute(sql, (*params, *params, username)).fetchall()



def community_notifications(db,username):
    from app.plugin_client import enabled
    if not enabled('people'):
        return []
    # Core-only installs have no people tables. The plugin initializes them before readiness.
    if not db.execute("SELECT to_regclass('people_chat.bob_chat_members') AS relation").fetchone()['relation']:
        return []
    return db.execute('''WITH items AS (
        SELECT 'community:' || r.id::text || ':' || incoming.id::text AS id,'community'::text AS kind,
            'unread'::text AS status,CASE WHEN r.kind='direct' THEN 'New private message' ELSE 'New messages in ' || r.name END AS title,
            incoming.created_at AS occurred_at,NULL::text AS job_id,NULL::text AS session_id,r.id AS room_id
        FROM people_chat.bob_chat_members m JOIN people_chat.bob_chat_rooms r ON r.id=m.room_id
        JOIN LATERAL (SELECT msg.id,msg.created_at FROM people_chat.bob_chat_messages msg
            WHERE msg.room_id=r.id AND msg.sender<>m.username
            AND NOT EXISTS (SELECT 1 FROM people_chat.bob_chat_message_seen seen WHERE seen.message_id=msg.id AND seen.username=m.username) ORDER BY msg.id DESC LIMIT 1) incoming ON true
        WHERE m.username=%s
        UNION ALL
        SELECT 'community-task:' || t.id::text || ':' || t.due_at::text,'community_task','due',t.title,
            t.due_at,NULL,NULL,t.room_id FROM people_chat.bob_chat_tasks t
        JOIN people_chat.bob_chat_members m ON m.room_id=t.room_id AND m.username=%s
        WHERE t.assignee=%s AND t.due_at<=now() AND t.status<>'done'
    ) SELECT items.*,r.read_at FROM items LEFT JOIN bob_notification_reads r
        ON r.username=%s AND r.notification_id=items.id ORDER BY occurred_at DESC LIMIT 200''',(username,username,username,username)).fetchall()


def missed_call_notifications(db, username):
    from app.plugin_client import enabled
    if not enabled('people') or not db.execute("SELECT to_regclass('people_chat.bob_voice_calls') AS relation").fetchone()['relation']:
        return []
    return db.execute("""SELECT 'missed-call:' || c.id::text AS id,
        'missed_call' AS kind,'missed' AS status,'Missed call from ' || COALESCE(NULLIF(p.display_name,''),c.caller) AS title,
        COALESCE(c.ended_at,c.created_at+interval '45 seconds') AS occurred_at,NULL::text AS job_id,NULL::text AS session_id,
        c.room_id,c.caller,'direct' AS room_kind,r.read_at
        FROM people_chat.bob_voice_calls c
        LEFT JOIN bob_user_profiles p ON p.username=c.caller
        JOIN people_chat.bob_chat_members m ON m.room_id=c.room_id AND m.username=%s
        LEFT JOIN bob_notification_reads r ON r.username=%s AND r.notification_id='missed-call:' || c.id::text
        WHERE c.callee=%s AND c.accepted_at IS NULL
        AND ((c.status='ended' AND c.reason IN ('timeout','cancelled','disconnected','hangup'))
             OR (c.status='ringing' AND c.created_at<now()-interval '45 seconds'))
        ORDER BY occurred_at DESC""", (username, username, username)).fetchall()


def learning_certificate_notifications(db, username):
    from app.plugin_client import enabled
    if not enabled('learning') or not db.execute("SELECT to_regclass('learning.course_certificates') AS relation").fetchone()['relation']:
        return []
    return db.execute("""SELECT 'learning-certificate:' || c.id::text AS id,
        'learning_certificate'::text AS kind, 'issued'::text AS status,
        'Certificate of Completion: ' || c.course_title AS title,
        c.issued_at AS occurred_at, NULL::text AS job_id, NULL::text AS session_id,
        '/api/learning/certificates/' || c.id::text || '/download?format=pdf' AS source_url,
        r.read_at
        FROM learning.course_certificates c
        LEFT JOIN bob_notification_reads r ON r.username=%s AND r.notification_id='learning-certificate:' || c.id::text
        WHERE c.username=%s AND c.revoked_at IS NULL
        ORDER BY c.issued_at DESC LIMIT 100""", (username, username)).fetchall()


def list_notifications(username):
    ensure_schema()
    with job_queue._connect() as db:
        rows = db.execute(ITEMS_SQL, (username, username, username, username)).fetchall()
        rows.extend(knowledge_notifications(db, username))
        rows.extend(community_notifications(db, username))
        rows.extend(missed_call_notifications(db, username))
        rows.extend(learning_certificate_notifications(db, username))
        from app.toolbar_reminders import notifications as reminder_notifications
        rows.extend(reminder_notifications(db, username))
    rows.sort(key=lambda row: row['occurred_at'], reverse=True)
    return [{**row, 'review_due': str(row['review_due']) if row.get('review_due') else None, 'occurred_at': row['occurred_at'].isoformat(),
             'read_at': row['read_at'].isoformat() if row['read_at'] else None} for row in rows]


def mark_read(username, notification_id):
    if not any(item['id'] == notification_id for item in list_notifications(username)):
        return False
    with job_queue._connect() as db:
        db.execute('INSERT INTO bob_notification_reads(username,notification_id) VALUES (%s,%s) ON CONFLICT DO NOTHING',
                   (username, notification_id))
    return True


class ReadRequest(BaseModel):
    id: str = Field(min_length=1, max_length=250)


@router.get('')
async def inbox(response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return await run_in_threadpool(list_notifications, user['username'])


@router.post('/read')
async def read_notification(body: ReadRequest, user=Depends(current_user)):
    if not await run_in_threadpool(mark_read, user['username'], body.id):
        raise HTTPException(404, 'Notification not found')
    return {'read': True}
