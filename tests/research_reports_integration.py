"""Research report queries and finished notifications against real PostgreSQL semantics."""
import json
import os
import uuid
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app import job_queue, notification_inbox, postgres_storage as storage, research

OWNER = 'research-owner'


def add_job(db, session, status, payload):
    job_id = str(uuid.uuid4())
    db.execute("""INSERT INTO bob_jobs(id,username,workspace_id,workspace_key,payload,status)
                  VALUES (%s,%s,%s,%s,%s::jsonb,%s)""",
               (job_id, OWNER, session, f'{OWNER}:session:{session}', json.dumps(payload), status))
    return job_id


def verify():
    storage.ensure_schema()
    job_queue.ensure_schema()
    with job_queue._connect() as db:
        for session in ('finished', 'stopped'):
            db.execute('INSERT INTO bob_conversations(username,id,record) VALUES (%s,%s,%s::jsonb)',
                       (OWNER, session, json.dumps({'id': session, 'title': session, 'updated': '2026-10-31', 'research': True})))
        finished = add_job(db, 'finished', 'failed', {'prompt': 'Topic', 'research': {'title': 'Report title'}})
        add_job(db, 'finished', 'completed', {'prompt': 'Follow-up chat'})
        add_job(db, 'stopped', 'failed', {'prompt': 'Stopped', 'cancel_requested': True, 'research': {'title': ''}})

    # A follow-up chat neither duplicates the report nor replaces its status.
    reports = {item['session_id']: item for item in research.reports(user={'username': OWNER})}
    assert set(reports) == {'finished', 'stopped'}, reports
    assert reports['finished']['job_id'] == finished and reports['finished']['status'] == 'failed', reports
    assert reports['stopped']['status'] == 'stopped', reports

    # A missing cancel flag is SQL NULL and must still notify; an explicit stop must not.
    with patch('app.toolbar_reminders.notifications', return_value=[]):
        items = notification_inbox.list_notifications(OWNER)
    assert [(item['kind'], item['title']) for item in items if item['kind'] == 'research'] == [('research', 'Report title')], items
    assert [item['title'] for item in items if item['kind'] == 'task'] == ['Follow-up chat'], items


def main():
    original = os.environ['DATABASE_URL']
    schema = 'researchtest_' + uuid.uuid4().hex[:12]
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options='-c search_path=' + schema)}):
            verify()
    finally:
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
    print('research reports integration passed')


if __name__ == '__main__':
    main()
