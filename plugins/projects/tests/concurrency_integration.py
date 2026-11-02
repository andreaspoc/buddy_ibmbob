"""Run only against a disposable database: verifies actual PostgreSQL row concurrency."""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import psycopg
from psycopg.rows import dict_row
from fastapi import HTTPException
from buddy_projects import service

service.ensure_schema()
name = 'concurrency-test-' + uuid.uuid4().hex
user = {'username': name, 'is_admin': True}
with psycopg.connect(os.environ['DATABASE_URL']) as db:
    db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES (%s,%s,true)', (name, 'test-only'))
first = service.create_project(service.Project(name=name+' first'), user)
second = service.create_project(service.Project(name=name+' second'), user)
try:
    with ThreadPoolExecutor(max_workers=2) as executor:
        with psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row) as holder:
            holder.execute('UPDATE projects.projects SET revision=revision+1 WHERE id=%s', (first['id'],))
            pending = executor.submit(service.update_project, first['id'], service.ProjectPatch(expected_revision=1, name='Stale concurrent update'), user)
            # Unrelated project update must complete while the first row remains locked.
            other = executor.submit(service.update_project, second['id'], service.ProjectPatch(expected_revision=1, name='Independent change'), user)
            assert other.result(timeout=5)['revision'] == 2
            try:
                pending.result(timeout=0.2)
                raise AssertionError('Conflicting writer unexpectedly bypassed row lock')
            except TimeoutError:
                pass
        try:
            pending.result(timeout=5)
            raise AssertionError('Conflicting writer unexpectedly succeeded')
        except HTTPException as exc:
            assert exc.status_code == 409
            assert exc.detail['code'] == 'revision_conflict'
    # Reciprocal relationship edits cannot both commit, including under real overlap.
    left = service.create_work_item(service.WorkItem(project_id=first['id'],kind='task',title='Left'), user)
    right = service.create_work_item(service.WorkItem(project_id=first['id'],kind='task',title='Right'), user)
    from threading import Barrier
    start = Barrier(2)
    def link(item, parent):
        start.wait(timeout=5)
        try:
            return service.update_work_item(item['id'], service.WorkItemPatch(expected_revision=1,parent_id=parent['id']), user)
        except HTTPException as exc:
            return exc
    with ThreadPoolExecutor(max_workers=2) as executor:
        fa = executor.submit(link,left,right)
        fb = executor.submit(link,right,left)
        results = [fa.result(timeout=5),fb.result(timeout=5)]
    assert sum(isinstance(r,dict) for r in results)==1
    failure = next(r for r in results if isinstance(r,HTTPException))
    assert failure.status_code in (409,422)
    winner = next(r for r in results if isinstance(r,dict))
    loser = right if winner['id']==left['id'] else left
    try:
        service.update_work_item(loser['id'],service.WorkItemPatch(expected_revision=1,parent_id=winner['id']),user)
        raise AssertionError('Retry introduced a reciprocal cycle')
    except HTTPException as exc:
        assert exc.status_code==422
    # Deleting a predecessor/parent advances dependent revisions and records evidence.
    dependent = service.create_work_item(service.WorkItem(project_id=second['id'],kind='task',title='Dependent'),user)
    base = service.create_work_item(service.WorkItem(project_id=second['id'],kind='task',title='Base'),user)
    predecessor = service.create_work_item(service.WorkItem(project_id=second['id'],kind='task',title='Predecessor',predecessor_ids=[base['id']]),user)
    dependent = service.update_work_item(dependent['id'],service.WorkItemPatch(expected_revision=1,parent_id=predecessor['id'],predecessor_ids=[predecessor['id']]),user)
    service.delete_work_item(predecessor['id'],user)
    with service.connection() as db:
        cleared = service.work_record(db,dependent['id'])
        assert cleared['revision']==dependent['revision']+1
        assert cleared['parent_id'] is None and cleared['predecessor_ids']==[]
        audit = db.execute("SELECT payload FROM projects.events WHERE actor=%s AND action='work_item.updated' ORDER BY id DESC LIMIT 1",(name,)).fetchone()['payload']
        deleted_audit = db.execute("SELECT payload FROM projects.events WHERE actor=%s AND action='work_item.deleted' ORDER BY id DESC LIMIT 1",(name,)).fetchone()['payload']
        assert deleted_audit['predecessor_ids']==[base['id']]
        assert audit['reason']=='related_work_item_deleted'
        assert audit['changes']['predecessor_ids']=={'before':[predecessor['id']],'after':[]}
    try:
        service.update_work_item(dependent['id'],service.WorkItemPatch(expected_revision=dependent['revision'],title='Stale'),user)
        raise AssertionError('Deletion failed to invalidate stale form')
    except HTTPException as exc:
        assert exc.status_code==409
    # Snapshot uses one repeatable-read view even if another transaction commits.
    with service.connection() as reader:
        before = service.snapshot(reader, user)
        service.update_project(second['id'], service.ProjectPatch(expected_revision=2, name='Later committed change'), user)
        after = service.snapshot(reader, user)
        a = next(p for p in before['projects'] if p['id']==second['id'])
        b = next(p for p in after['projects'] if p['id']==second['id'])
        assert a == b
    print('Projects concurrency: independent writes, conflict 409, reciprocal cycle safety, deletion audit/revisions, repeatable snapshot passed')
finally:
    with psycopg.connect(os.environ['DATABASE_URL']) as db:
        db.execute('DELETE FROM projects.events WHERE actor=%s', (name,))
        db.execute('DELETE FROM projects.projects WHERE id=ANY(%s)', ([first['id'], second['id']],))
        db.execute('DELETE FROM users WHERE username=%s', (name,))
