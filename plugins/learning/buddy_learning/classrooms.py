"""Human-managed courses/classes; enrollment never grants access to source material."""
import logging
from datetime import datetime, timezone
from uuid import UUID, uuid4
from fastapi import APIRouter, Depends, HTTPException
from psycopg.types.json import Jsonb
from app import job_queue
from app.auth import current_user
from app.keycloak_groups import realm
from . import store
from .quizzes import learner_display_name
from .classroom_models import (ClassInput, ClassUpdate, ClassAccessInput, Members, Announcement,
    AnnouncementUpdate, Session, SessionUpdate, Assignment, AssignmentUpdate, Homework, Feedback)

router = APIRouter(prefix='/api/learning')
from .service import same_origin, teacher


def ensure_folder_classes(db):
    db.execute('''INSERT INTO learning.classes(id,folder_id,title,description,created_by,teacher_username)
        SELECT f.id,f.id,f.name,'',f.created_by,f.created_by FROM learning.folders f
        WHERE NOT f.deleted AND NOT EXISTS (SELECT 1 FROM learning.classes c WHERE c.folder_id=f.id)
        ON CONFLICT (id) DO NOTHING''')
    db.execute('''INSERT INTO learning.class_members(class_id,username)
        SELECT c.id,m.username FROM learning.classes c
        JOIN learning.members m ON m.folder_id=c.folder_id
        WHERE NOT c.deleted AND EXISTS (SELECT 1 FROM users u WHERE u.username=m.username)
        ON CONFLICT (class_id,username) DO NOTHING''')
    db.execute('''INSERT INTO learning.class_members(class_id,username)
        SELECT c.id,gm.username FROM learning.classes c
        JOIN learning.folder_app_groups fg ON fg.folder_id=c.folder_id
        JOIN bob_app_group_members gm ON gm.group_id=fg.group_id
        WHERE NOT c.deleted AND EXISTS (SELECT 1 FROM users u WHERE u.username=gm.username)
        ON CONFLICT (class_id,username) DO NOTHING''')


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS learning.classes (
        id UUID PRIMARY KEY,folder_id UUID NOT NULL REFERENCES learning.folders(id),
        title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,
        archived BOOLEAN NOT NULL DEFAULT false,revision INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('ALTER TABLE learning.classes ADD COLUMN IF NOT EXISTS teacher_username TEXT')
    db.execute('ALTER TABLE learning.classes ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false')
    db.execute("ALTER TABLE learning.classes ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}'::jsonb")
    db.execute("ALTER TABLE learning.classes ADD COLUMN IF NOT EXISTS approved_languages JSONB NOT NULL DEFAULT '[]'::jsonb")
    db.execute('UPDATE learning.classes SET teacher_username=created_by WHERE teacher_username IS NULL')
    db.execute('CREATE INDEX IF NOT EXISTS learning_classes_teacher ON learning.classes(teacher_username)')
    db.execute('CREATE INDEX IF NOT EXISTS learning_classes_folder ON learning.classes(folder_id)')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.class_members (
        class_id UUID REFERENCES learning.classes(id) ON DELETE CASCADE,
        username TEXT REFERENCES users(username) ON DELETE CASCADE,
        PRIMARY KEY(class_id,username))''')
    db.execute('CREATE INDEX IF NOT EXISTS learning_class_members_user ON learning.class_members(username)')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.class_announcements (
        id UUID PRIMARY KEY,class_id UUID NOT NULL REFERENCES learning.classes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,body TEXT NOT NULL,created_by TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.class_sessions (
        id UUID PRIMARY KEY,class_id UUID NOT NULL REFERENCES learning.classes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',section TEXT NOT NULL DEFAULT '',
        starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,CHECK(ends_at>starts_at))''')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.class_assignments (
        id UUID PRIMARY KEY,class_id UUID NOT NULL REFERENCES learning.classes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',instructions TEXT NOT NULL,section TEXT NOT NULL DEFAULT '',
        due_at TIMESTAMPTZ,allow_late BOOLEAN NOT NULL DEFAULT true,
        required BOOLEAN NOT NULL DEFAULT true,minimum_score_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('none','book','lesson','quiz')),
        resource_id UUID,resource_version INTEGER,revision INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
    db.execute('''CREATE TABLE IF NOT EXISTS learning.class_submissions (
        id UUID PRIMARY KEY,assignment_id UUID NOT NULL REFERENCES learning.class_assignments(id) ON DELETE CASCADE,
        username TEXT NOT NULL REFERENCES users(username),text TEXT NOT NULL,
        assignment_revision INTEGER NOT NULL,assignment_snapshot JSONB NOT NULL,
        feedback TEXT NOT NULL DEFAULT '',mark DOUBLE PRECISION,max_mark DOUBLE PRECISION,
        reviewed_by TEXT,reviewed_at TIMESTAMPTZ,revision INTEGER NOT NULL DEFAULT 1,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(assignment_id,username))''')
    for table in ('class_announcements', 'class_sessions', 'class_assignments'):
        db.execute(f'CREATE INDEX IF NOT EXISTS learning_{table}_class ON learning.{table}(class_id)')
    ensure_folder_classes(db)


def authorize_class(db, class_id, user, *, manage=False, lock=False):
    row = db.execute('SELECT * FROM learning.classes WHERE id=%s', (str(class_id),)).fetchone()
    if not row or row.get('deleted'):
        raise HTTPException(404, 'Class not found')
    store.folder(db, row['folder_id'], user)
    if lock:
        row = db.execute('SELECT * FROM learning.classes WHERE id=%s FOR UPDATE', (str(class_id),)).fetchone()
        if not row or row.get('deleted'):
            raise HTTPException(404, 'Class not found')
    lead = row.get('teacher_username') or row['created_by']
    manager = bool(user.get('is_admin') or lead == user['username'] and store.can_create(db, user))
    if manage and not manager:
        raise HTTPException(403, 'Only the class teacher or an administrator can manage this class')
    if not manager and not db.execute('SELECT 1 FROM learning.class_members WHERE class_id=%s AND username=%s',
                                     (str(class_id), user['username'])).fetchone():
        if str(row['id']) == str(row['folder_id']):
            db.execute('''INSERT INTO learning.class_members(class_id,username)
                SELECT %s, u.username FROM users u WHERE u.username=%s
                ON CONFLICT (class_id,username) DO NOTHING''', (str(class_id), user['username']))
        else:
            raise HTTPException(404, 'Class not found')
    return {**class_identity(db,row), 'can_manage': manager, 'can_delete': row['created_by'] == user['username'], 'can_assign_teacher': bool(user.get('is_admin'))}


def class_identity(db,row):
    lead = row.get('teacher_username') or row['created_by']
    profile = db.execute('SELECT display_name FROM bob_user_profiles WHERE username=%s',(lead,)).fetchone()
    name = learner_display_name({'username':lead,'display_name':profile.get('display_name') if profile else None})
    return {**row,'teacher_username':lead,'teacher_display_name':'Teacher' if name=='Learner' else name}


def checked_teacher(db,folder_id,username):
    person = db.execute('SELECT username,is_admin FROM users WHERE username=%s',(username,)).fetchone()
    if not person or not store.can_create(db,person):
        raise HTTPException(422,'Select an existing teacher with current teacher permissions')
    try:
        store.folder(db,folder_id,person)
    except HTTPException as error:
        if error.status_code == 404:
            raise HTTPException(422,'The selected teacher needs current access to this folder') from None
        raise
    return person


classroom = authorize_class


def revision(row, expected):
    if row['revision'] != expected:
        raise HTTPException(409, 'This item changed. Reload before saving your changes.')


def ensure_open(row):
    if row['archived']:
        raise HTTPException(409, 'This class is archived. Reopen it before making changes.')


def assignment(db, class_id, assignment_id, *, lock=False):
    row = db.execute('SELECT * FROM learning.class_assignments WHERE id=%s AND class_id=%s' + (' FOR UPDATE' if lock else ''),
                     (str(assignment_id), str(class_id))).fetchone()
    if not row:
        raise HTTPException(404, 'Assignment not found')
    return row


def resource(db, course, spec, user):
    if spec.resource_type == 'none':
        return None
    if spec.resource_type == 'book':
        row = store.book(db, spec.resource_id, user)
    elif spec.resource_type == 'quiz':
        row = store.quiz(db, spec.resource_id, user)
    else:
        from .lessons import lookup
        row, _ = lookup(db, spec.resource_id, user)
    if str(row['folder_id']) != str(course['folder_id']):
        raise HTTPException(422, 'Select material from this class folder')
    if spec.resource_type != 'book' and row['status'] != 'published':
        raise HTTPException(422, 'Publish the lesson or quiz before assigning it')
    return row.get('version')


@router.get('/classes')
def list_all_classes(user=Depends(current_user)):
    with job_queue._connect() as db:
        ensure_folder_classes(db)
        create = store.can_create(db, user)
        if create:
            # Ensure a teacher assigned to a class has folder membership so visible_folders includes it
            db.execute('''INSERT INTO learning.members(folder_id,username)
                SELECT c.folder_id, %s FROM learning.classes c
                WHERE NOT c.deleted AND COALESCE(c.teacher_username,c.created_by)=%s
                AND EXISTS (SELECT 1 FROM users u WHERE u.username=%s)
                ON CONFLICT (folder_id,username) DO NOTHING''',
                (user['username'], user['username'], user['username']))
        folders = store.visible_folders(db, user)
        if not folders:
            return {'items': []}
        folder_ids = [str(f['id']) for f in folders]
        parent_by_folder = {str(f['id']): str(f['parent_id']) if f.get('parent_id') else None for f in folders}
        rows = db.execute('''SELECT c.*,(%s OR (COALESCE(c.teacher_username,c.created_by)=%s AND %s)) AS can_manage,
            p.display_name AS teacher_display_name,
            (SELECT count(*)::int FROM learning.class_members cm WHERE cm.class_id=c.id) AS member_count,
            (SELECT count(*)::int FROM learning.books b WHERE b.folder_id=c.folder_id AND NOT b.deleted) AS book_count,
            (SELECT count(*)::int FROM learning.lessons l WHERE l.folder_id=c.folder_id AND (l.status<>'draft' OR (l.created_by=%s AND %s))) AS lesson_count,
            (SELECT count(*)::int FROM learning.quizzes q WHERE q.folder_id=c.folder_id AND (q.status<>'draft' OR (q.created_by=%s AND %s))) AS quiz_count
            FROM learning.classes c
            LEFT JOIN bob_user_profiles p ON p.username=COALESCE(c.teacher_username,c.created_by)
            WHERE NOT c.deleted AND c.folder_id=ANY(%s::uuid[]) AND (%s OR (COALESCE(c.teacher_username,c.created_by)=%s AND %s)
                OR c.id=c.folder_id
                OR EXISTS(SELECT 1 FROM learning.class_members m WHERE m.class_id=c.id AND m.username=%s))
            ORDER BY c.archived,lower(c.title),c.created_at DESC''',
            (bool(user.get('is_admin')), user['username'], create,
             user['username'], create, user['username'], create,
             folder_ids, bool(user.get('is_admin')), user['username'], create, user['username'])).fetchall()
    return {'items': [{**row,
                      'parent_id': parent_by_folder.get(str(row['folder_id'])), 'can_delete': row['created_by'] == user['username'],
                      'teacher_username': row.get('teacher_username') or row['created_by'],
                      'teacher_display_name': learner_display_name({'username': row.get('teacher_username') or row['created_by'],
                          'display_name': row.get('teacher_display_name')}),
                      'can_assign_teacher': bool(user.get('is_admin'))} for row in rows]}


@router.post('/classes', dependencies=[Depends(same_origin)])
def create_standalone_class(req: ClassInput, user=Depends(teacher)):
    with job_queue._connect() as db:
        if req.parent_id:
            store.folder(db, req.parent_id, user)
        lead = req.teacher_username or user['username']
        if not user.get('is_admin') and lead != user['username']:
            raise HTTPException(403, 'Only an administrator can assign another course teacher')
        person = db.execute('SELECT username,is_admin FROM users WHERE username=%s', (lead,)).fetchone()
        if not person or not store.can_create(db, person):
            raise HTTPException(422, 'Select an existing teacher with current teacher permissions')
        cid = str(uuid4())
        title = req.title.strip()
        db.execute('INSERT INTO learning.folders(id,name,created_by,parent_id) VALUES(%s,%s,%s,%s)',
                   (cid, title, user['username'], str(req.parent_id) if req.parent_id else None))
        for uname in {user['username'], lead}:
            db.execute('''INSERT INTO learning.members(folder_id,username)
                SELECT %s, u.username FROM users u WHERE u.username=%s
                ON CONFLICT (folder_id,username) DO NOTHING''', (cid, uname))
        row = db.execute('''INSERT INTO learning.classes(id,folder_id,title,description,created_by,teacher_username)
            VALUES(%s,%s,%s,%s,%s,%s) RETURNING *''',
            (cid, cid, title, req.description, user['username'], lead)).fetchone()
        return {**class_identity(db, row), 'parent_id': str(req.parent_id) if req.parent_id else None,
                'can_manage': True, 'can_assign_teacher': bool(user.get('is_admin')),
                'member_count': 0, 'book_count': 0, 'lesson_count': 0, 'quiz_count': 0}


@router.get('/folders/{folder_id}/classes')
def list_classes(folder_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        store.folder(db, folder_id, user)
        create = store.can_create(db, user)
        rows = db.execute('''SELECT c.*,(%s OR (COALESCE(c.teacher_username,c.created_by)=%s AND %s)) AS can_manage,
            p.display_name AS teacher_display_name FROM learning.classes c
            LEFT JOIN bob_user_profiles p ON p.username=COALESCE(c.teacher_username,c.created_by)
            WHERE NOT c.deleted AND c.folder_id=%s AND (%s OR (COALESCE(c.teacher_username,c.created_by)=%s AND %s)
                OR c.id=c.folder_id
                OR EXISTS(SELECT 1 FROM learning.class_members m WHERE m.class_id=c.id AND m.username=%s))
            ORDER BY c.archived,c.created_at DESC''',
            (bool(user.get('is_admin')), user['username'], create, str(folder_id), bool(user.get('is_admin')), user['username'], create, user['username'])).fetchall()
    return {'items': [{**row,'can_delete':row['created_by'] == user['username'],'teacher_username':row.get('teacher_username') or row['created_by'],
                      'teacher_display_name':learner_display_name({'username':row.get('teacher_username') or row['created_by'],
                          'display_name':row.get('teacher_display_name')}),
                      'can_assign_teacher':bool(user.get('is_admin'))} for row in rows]}


@router.post('/folders/{folder_id}/classes', dependencies=[Depends(same_origin)])
def create_class(folder_id: UUID, req: ClassInput, user=Depends(teacher)):
    with job_queue._connect() as db:
        store.folder(db, folder_id, user)
        lead = req.teacher_username or user['username']
        if not user.get('is_admin') and lead != user['username']:
            raise HTTPException(403,'Only an administrator can assign another course teacher')
        checked_teacher(db,folder_id,lead)
        row = db.execute('''INSERT INTO learning.classes(id,folder_id,title,description,created_by,teacher_username)
            VALUES(%s,%s,%s,%s,%s,%s) RETURNING *''',
            (str(uuid4()), str(folder_id), req.title.strip(), req.description, user['username'],lead)).fetchone()
        return {**class_identity(db,row),'can_manage':True,'can_assign_teacher':bool(user.get('is_admin'))}


@router.get('/classes/{class_id}')
def get_class(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        return authorize_class(db, class_id, user)


@router.put('/classes/{class_id}', dependencies=[Depends(same_origin)])
def update_class(class_id: UUID, req: ClassUpdate, user=Depends(current_user)):
    with job_queue._connect() as db:
        row = authorize_class(db, class_id, user, manage=True, lock=True)
        revision(row, req.expected_revision)
        current = row.get('teacher_username') or row['created_by']
        lead = req.teacher_username or current
        if lead != current:
            if not user.get('is_admin'):
                raise HTTPException(403,'Only an administrator can reassign the course teacher')
            if str(row['id']) == str(row['folder_id']):
                db.execute('''INSERT INTO learning.members(folder_id,username)
                    SELECT %s, u.username FROM users u WHERE u.username=%s
                    ON CONFLICT (folder_id,username) DO NOTHING''', (str(row['folder_id']), lead))
            checked_teacher(db,row['folder_id'],lead)
        saved = db.execute('''UPDATE learning.classes SET title=%s,description=%s,archived=%s,teacher_username=%s,revision=revision+1
            WHERE id=%s RETURNING *''', (req.title.strip(), req.description, req.archived,lead,str(class_id))).fetchone()
        if str(row['id']) == str(row['folder_id']):
            db.execute('UPDATE learning.folders SET name=%s WHERE id=%s', (req.title.strip(), str(row['folder_id'])))
        return {**class_identity(db,saved),'can_manage':bool(user.get('is_admin') or lead == user['username']),
                'can_assign_teacher':bool(user.get('is_admin'))}


@router.get('/classes/{class_id}/access')
def get_class_access(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True)
        folder_id = str(course['folder_id'])
        enrolled = {row['username'] for row in db.execute('SELECT username FROM learning.class_members WHERE class_id=%s', (str(class_id),)).fetchall()}
        folder_members = {row['username'] for row in db.execute('SELECT username FROM learning.members WHERE folder_id=%s', (folder_id,)).fetchall()}
        usernames = sorted(enrolled | folder_members)
        app_group_ids = [str(row['group_id']) for row in db.execute('SELECT group_id FROM learning.folder_app_groups WHERE folder_id=%s ORDER BY group_id', (folder_id,)).fetchall()]
        kc_groups = [row['group_path'] for row in db.execute('SELECT group_path FROM learning.folder_groups WHERE folder_id=%s AND issuer=%s ORDER BY group_path', (folder_id, realm())).fetchall()]
        directory = db.execute('''SELECT DISTINCT u.username,u.is_admin,p.email,COALESCE(NULLIF(p.display_name,''),u.username) AS display_name
            FROM users u LEFT JOIN bob_user_profiles p ON p.username=u.username
            ORDER BY display_name LIMIT 1000''').fetchall()
        directory_items = [{**item, 'display_name': learner_display_name(item)} for item in directory]
        available_app_groups = db.execute('''SELECT g.id,g.name,g.description,count(m.username)::int AS member_count
            FROM bob_app_groups g LEFT JOIN bob_app_group_members m ON m.group_id=g.id
            GROUP BY g.id ORDER BY lower(g.name),g.id''').fetchall()
        known_kc_groups = [row['path'] for row in db.execute('SELECT DISTINCT group_path AS path FROM bob_keycloak_group_memberships WHERE issuer=%s ORDER BY path', (realm(),)).fetchall()]
        teachers = [{'username': p['username'], 'display_name': p['display_name']} for p in directory_items if store.can_create(db, p)]
        return {
            'class_id': str(class_id),
            'folder_id': folder_id,
            'usernames': usernames,
            'app_groups': app_group_ids,
            'groups': kc_groups,
            'teacher_username': course.get('teacher_username') or course['created_by'],
            'can_assign_teacher': bool(user.get('is_admin')),
            'directory': directory_items,
            'available_app_groups': available_app_groups,
            'available_keycloak_groups': sorted(set([*known_kc_groups, *kc_groups])),
            'available_teachers': teachers,
            'inherited_from': store.ancestors(db, folder_id),
        }


def _email_members(kind, messages):
    """Send {username: (subject, body)} individually so one failure cannot block the rest."""
    log = logging.getLogger(__name__)
    if not messages:
        return
    try:
        from app.smtp_settings import load_config, send_message
        config = load_config()
        if not config.get('enabled'):
            log.warning('%s emails skipped: SMTP is disabled', kind)
            return
        with job_queue._connect() as db:
            profiles = db.execute('SELECT username,email FROM bob_user_profiles WHERE username=ANY(%s)', (list(messages),)).fetchall()
        emails = {row['username']: row['email'] for row in profiles}
        for username, (subject, body) in messages.items():
            recipient = emails.get(username) or (username if '@' in username else None)
            if not recipient:
                log.warning('%s email skipped: no address for %s', kind, username)
                continue
            try:
                send_message(config, recipient, subject, body)
            except Exception:
                log.exception('%s email failed for %s', kind, username)
    except Exception:
        log.exception('Could not prepare %s emails', kind)


def notify_enrolled(course_title, usernames):
    """Send individual enrollment notices after the enrollment transaction commits."""
    message = (f'Course enrollment: {course_title}',
               f'You have been enrolled in {course_title}. Open your Learning workspace to view the course.')
    _email_members('Enrollment', {username: message for username in usernames})


def new_module_message(course_title, module_title):
    course_name = ' '.join(str(course_title).split())
    module_name = ' '.join(str(module_title).split())
    return (f'New module to complete: {course_name}',
            f'A new required module, {module_name}, has been added to {course_name}. '
            'Open your Learning workspace to complete it.\n\n'
            'Any certificate you already hold remains valid. When you finish all required activities, '
            'you will receive an updated certificate showing the new completion date.')


def notify_new_module(module_title, *, folder_id=None, class_id=None, exclude=None):
    """Tell enrolled learners about a new required module, after its transaction commits.

    Publishing must succeed even if notification fails, so every error is logged and absorbed.
    A learner enrolled in several affected classes receives one email.
    """
    try:
        with job_queue._connect() as db:
            ensure_folder_classes(db)
            rows = db.execute('''SELECT c.title,m.username FROM learning.classes c
                JOIN learning.class_members m ON m.class_id=c.id
                WHERE (c.folder_id=%s::uuid OR c.id=%s::uuid) AND NOT c.archived AND NOT c.deleted
                ORDER BY c.title,c.id,m.username''',
                (str(folder_id) if folder_id else None, str(class_id) if class_id else None)).fetchall()
        messages = {}
        for row in rows:
            if row['username'] != exclude:
                messages.setdefault(row['username'], new_module_message(row['title'], module_title))
    except Exception:
        logging.getLogger(__name__).exception('Could not find learners to notify about a new module')
        return
    _email_members('New module', messages)


@router.put('/classes/{class_id}/access', dependencies=[Depends(same_origin)])
def update_class_access(class_id: UUID, req: ClassAccessInput, user=Depends(current_user)):
    from app.keycloak_groups import valid_group_path
    names = sorted(set(req.usernames))
    group_paths = sorted(set(req.groups))
    if any(not valid_group_path(g) for g in group_paths):
        raise HTTPException(422, 'Use full Keycloak group paths such as /Training/Team')
    if group_paths and not realm():
        raise HTTPException(503, 'Configure Keycloak before granting Keycloak group access')
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True, lock=True)
        ensure_open(course)
        folder_id = str(course['folder_id'])
        db.execute('SELECT id FROM learning.folders WHERE id=%s FOR UPDATE', (folder_id,))
        if names and len(db.execute('SELECT username FROM users WHERE username=ANY(%s)', (names,)).fetchall()) != len(names):
            raise HTTPException(422, 'Select existing application users')
        app_ids = sorted({str(value) for value in req.app_groups})
        if app_ids and len(db.execute('SELECT id FROM bob_app_groups WHERE id=ANY(%s::uuid[])', (app_ids,)).fetchall()) != len(app_ids):
            raise HTTPException(422, 'Select existing application groups')
        current_lead = course.get('teacher_username') or course['created_by']
        lead = req.teacher_username or current_lead
        if lead != current_lead:
            if not user.get('is_admin'):
                raise HTTPException(403, 'Only an administrator can reassign the course teacher')
            person = db.execute('SELECT username,is_admin FROM users WHERE username=%s', (lead,)).fetchone()
            if not person or not store.can_create(db, person):
                raise HTTPException(422, 'Select an existing teacher with current teacher permissions')
            db.execute('UPDATE learning.classes SET teacher_username=%s WHERE id=%s', (lead, str(class_id)))
        db.execute('DELETE FROM learning.members WHERE folder_id=%s', (folder_id,))
        folder_usernames = sorted(set(names) | ({lead} if db.execute('SELECT 1 FROM users WHERE username=%s', (lead,)).fetchone() else set()))
        for name in folder_usernames:
            db.execute('INSERT INTO learning.members(folder_id,username) VALUES(%s,%s) ON CONFLICT DO NOTHING', (folder_id, name))
        if 'groups' in req.model_fields_set:
            db.execute('DELETE FROM learning.folder_groups WHERE folder_id=%s', (folder_id,))
            for group in group_paths:
                db.execute('INSERT INTO learning.folder_groups(folder_id,issuer,group_path) VALUES(%s,%s,%s)', (folder_id, realm(), group))
        if 'app_groups' in req.model_fields_set:
            db.execute('DELETE FROM learning.folder_app_groups WHERE folder_id=%s', (folder_id,))
            for identity in app_ids:
                db.execute('INSERT INTO learning.folder_app_groups(folder_id,group_id) VALUES(%s,%s)', (folder_id, identity))
        group_member_rows = db.execute('''SELECT DISTINCT gm.username FROM bob_app_group_members gm
            JOIN learning.folder_app_groups fg ON fg.group_id=gm.group_id
            WHERE fg.folder_id=%s''', (folder_id,)).fetchall()
        all_enrolled = sorted(set(names) | {r['username'] for r in group_member_rows})
        previous = {row['username'] for row in db.execute('SELECT username FROM learning.class_members WHERE class_id=%s', (str(class_id),)).fetchall()}
        db.execute('DELETE FROM learning.class_members WHERE class_id=%s', (str(class_id),))
        for name in all_enrolled:
            db.execute('INSERT INTO learning.class_members(class_id,username) VALUES(%s,%s) ON CONFLICT DO NOTHING', (str(class_id), name))
        db.execute('UPDATE learning.classes SET revision=revision+1 WHERE id=%s', (str(class_id),))
        result = {
            'usernames': all_enrolled,
            'app_groups': app_ids,
            'groups': group_paths,
            'teacher_username': lead,
            'items': member_rows(db, class_id),
        }
    notify_enrolled(course['title'], sorted(set(all_enrolled) - previous))
    return result


def member_rows(db, class_id):
    rows = db.execute('''SELECT m.username,COALESCE(NULLIF(p.display_name,''),m.username) AS display_name
        FROM learning.class_members m LEFT JOIN bob_user_profiles p ON p.username=m.username
        WHERE m.class_id=%s ORDER BY display_name''', (str(class_id),)).fetchall()
    return [{**row, 'display_name': learner_display_name(row)} for row in rows]


@router.get('/classes/{class_id}/members')
def members(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        authorize_class(db, class_id, user, manage=True)
        return {'items': member_rows(db, class_id)}


def eligible_users(db, course):
    rows = db.execute('''SELECT DISTINCT u.username,u.is_admin,COALESCE(NULLIF(p.display_name,''),u.username) AS display_name
        FROM users u LEFT JOIN bob_user_profiles p ON p.username=u.username
        ORDER BY display_name LIMIT 1001''').fetchall()
    if len(rows)>1000:
        raise HTTPException(422, 'The directory is too large; ask an administrator to manage enrollment')
    result = []
    for row in rows:
        try:
            store.folder(db, course['folder_id'], row)
        except HTTPException as error:
            if error.status_code == 404:
                continue
            raise
        result.append({**row, 'display_name': learner_display_name(row)})
    return result


@router.get('/folders/{folder_id}/class-teachers')
@router.get('/folders/{folder_id}/teacher-candidates')
def teacher_candidates(folder_id: UUID,user=Depends(current_user)):
    store.admin(user)
    with job_queue._connect() as db:
        store.folder(db,folder_id,user)
        people = eligible_users(db,{'folder_id':folder_id})
        return {'items':[{key:person[key] for key in ('username','display_name')}
                         for person in people if store.can_create(db,person)],'can_assign_teacher':True}


@router.get('/classes/{class_id}/candidates')
def candidates(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True)
        return {'items': [{k: row[k] for k in ('username','display_name')} for row in eligible_users(db, course)]}


@router.put('/classes/{class_id}/members', dependencies=[Depends(same_origin)])
def replace_members(class_id: UUID, req: Members, user=Depends(current_user)):
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True, lock=True)
        ensure_open(course)
        eligible = {row['username'] for row in eligible_users(db, course)}
        if not set(req.usernames) <= eligible:
            raise HTTPException(422, 'Select only provisioned users with current access to this folder')
        previous = {row['username'] for row in db.execute('SELECT username FROM learning.class_members WHERE class_id=%s', (str(class_id),)).fetchall()}
        db.execute('DELETE FROM learning.class_members WHERE class_id=%s', (str(class_id),))
        for username in req.usernames:
            db.execute('INSERT INTO learning.class_members(class_id,username) VALUES(%s,%s)', (str(class_id), username))
        db.execute('UPDATE learning.classes SET revision=revision+1 WHERE id=%s', (str(class_id),))
        result = {'items': member_rows(db, class_id)}
    notify_enrolled(course['title'], sorted(set(req.usernames) - previous))
    return result


@router.get('/classes/{class_id}/announcements')
def announcements(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        authorize_class(db, class_id, user)
        return {'items': db.execute('SELECT * FROM learning.class_announcements WHERE class_id=%s ORDER BY created_at DESC', (str(class_id),)).fetchall()}


@router.post('/classes/{class_id}/announcements', dependencies=[Depends(same_origin)])
def post_announcement(class_id: UUID, req: Announcement, user=Depends(current_user)):
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True, lock=True)
        ensure_open(course)
        return db.execute('''INSERT INTO learning.class_announcements(id,class_id,title,body,created_by)
            VALUES(%s,%s,%s,%s,%s) RETURNING *''', (str(uuid4()), str(class_id), req.title, req.body, user['username'])).fetchone()


@router.put('/classes/{class_id}/announcements/{announcement_id}', dependencies=[Depends(same_origin)])
def edit_announcement(class_id: UUID, announcement_id: UUID, req: AnnouncementUpdate, user=Depends(current_user)):
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True, lock=True)
        ensure_open(course)
        row = db.execute('SELECT * FROM learning.class_announcements WHERE id=%s AND class_id=%s FOR UPDATE',
                         (str(announcement_id),str(class_id))).fetchone()
        if not row:
            raise HTTPException(404, 'Announcement not found')
        revision(row, req.expected_revision)
        return db.execute('UPDATE learning.class_announcements SET title=%s,body=%s,revision=revision+1 WHERE id=%s RETURNING *',
                          (req.title,req.body,str(announcement_id))).fetchone()


@router.get('/classes/{class_id}/sessions')
def sessions(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        authorize_class(db, class_id, user)
        return {'items': db.execute('SELECT * FROM learning.class_sessions WHERE class_id=%s ORDER BY starts_at,id', (str(class_id),)).fetchall()}


def save_session(db, class_id, req, session_id=None):
    values = (req.title,req.description,req.section,req.starts_at,req.ends_at)
    if session_id:
        row = db.execute('SELECT * FROM learning.class_sessions WHERE id=%s AND class_id=%s FOR UPDATE', (str(session_id),str(class_id))).fetchone()
        if not row:
            raise HTTPException(404, 'Session not found')
        revision(row,req.expected_revision)
        return db.execute('''UPDATE learning.class_sessions SET title=%s,description=%s,section=%s,starts_at=%s,ends_at=%s,
            revision=revision+1 WHERE id=%s RETURNING *''', (*values,str(session_id))).fetchone()
    return db.execute('''INSERT INTO learning.class_sessions(title,description,section,starts_at,ends_at,id,class_id)
        VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *''', (*values,str(uuid4()),str(class_id))).fetchone()


@router.post('/classes/{class_id}/sessions', dependencies=[Depends(same_origin)])
def create_session(class_id: UUID, req: Session, user=Depends(current_user)):
    with job_queue._connect() as db:
        course=authorize_class(db,class_id,user,manage=True,lock=True)
        ensure_open(course)
        return save_session(db,class_id,req)


@router.put('/classes/{class_id}/sessions/{session_id}', dependencies=[Depends(same_origin)])
def edit_session(class_id: UUID, session_id: UUID, req: SessionUpdate, user=Depends(current_user)):
    with job_queue._connect() as db:
        course=authorize_class(db,class_id,user,manage=True,lock=True)
        ensure_open(course)
        return save_session(db,class_id,req,session_id)


@router.get('/classes/{class_id}/assignments')
def assignments(class_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        course = authorize_class(db,class_id,user)
        rows = db.execute('SELECT * FROM learning.class_assignments WHERE class_id=%s ORDER BY due_at NULLS LAST,created_at,id', (str(class_id),)).fetchall()
        own = db.execute('''SELECT s.* FROM learning.class_submissions s JOIN learning.class_assignments a ON a.id=s.assignment_id
            WHERE a.class_id=%s AND s.username=%s''', (str(class_id),user['username'])).fetchall()
        by_assignment = {str(row['assignment_id']): row for row in own}
        counts = {}
        if course['can_manage']:
            counts = {str(row['assignment_id']): row['count'] for row in db.execute('''SELECT s.assignment_id,count(*) AS count
                FROM learning.class_submissions s JOIN learning.class_assignments a ON a.id=s.assignment_id
                WHERE a.class_id=%s GROUP BY s.assignment_id''',(str(class_id),)).fetchall()}
        return {'items': [{**row,'my_submission':by_assignment.get(str(row['id'])),
                            **({'submission_count':counts.get(str(row['id']),0)} if course['can_manage'] else {})} for row in rows]}


def save_assignment(db, course, req, user, assignment_id=None):
    resource_version = resource(db,course,req,user)
    values=(req.title,req.instructions,req.section,req.due_at,req.allow_late,req.required,req.minimum_score_percent,
            req.resource_type,str(req.resource_id) if req.resource_id else None,resource_version)
    db.execute('UPDATE learning.classes SET revision=revision+1 WHERE id=%s', (str(course['id']),))
    if assignment_id:
        row=assignment(db,course['id'],assignment_id,lock=True)
        revision(row,req.expected_revision)
        return db.execute('''UPDATE learning.class_assignments SET title=%s,instructions=%s,section=%s,due_at=%s,allow_late=%s,
            required=%s,minimum_score_percent=%s,resource_type=%s,resource_id=%s,resource_version=%s,revision=revision+1
            WHERE id=%s RETURNING *''',(*values,str(assignment_id))).fetchone()
    return db.execute('''INSERT INTO learning.class_assignments(title,instructions,section,due_at,allow_late,required,
        minimum_score_percent,resource_type,resource_id,resource_version,id,class_id)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',(*values,str(uuid4()),str(course['id']))).fetchone()


@router.get('/classes/{class_id}/assignments/{assignment_id}')
def get_assignment(class_id: UUID, assignment_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        authorize_class(db,class_id,user)
        item=assignment(db,class_id,assignment_id)
        own=db.execute('SELECT * FROM learning.class_submissions WHERE assignment_id=%s AND username=%s',
                       (str(assignment_id),user['username'])).fetchone()
        return {**item,'my_submission':own}


@router.post('/classes/{class_id}/assignments', dependencies=[Depends(same_origin)])
def create_assignment(class_id: UUID, req: Assignment, user=Depends(current_user)):
    with job_queue._connect() as db:
        course=authorize_class(db,class_id,user,manage=True,lock=True)
        ensure_open(course)
        saved = save_assignment(db,course,req,user)
    # Lessons and quizzes already notified learners when they were first published.
    if req.required and req.resource_type not in ('lesson','quiz'):
        notify_new_module(req.title,class_id=class_id,exclude=user['username'])
    return saved


@router.put('/classes/{class_id}/assignments/{assignment_id}', dependencies=[Depends(same_origin)])
def edit_assignment(class_id: UUID, assignment_id: UUID, req: AssignmentUpdate, user=Depends(current_user)):
    with job_queue._connect() as db:
        course=authorize_class(db,class_id,user,manage=True,lock=True)
        ensure_open(course)
        was_required = assignment(db,class_id,assignment_id).get('required', True)
        saved = save_assignment(db,course,req,user,assignment_id)
    if req.required and not was_required:
        notify_new_module(req.title,class_id=class_id,exclude=user['username'])
    return saved


@router.post('/classes/{class_id}/assignments/{assignment_id}/submit', dependencies=[Depends(same_origin)])
def submit(class_id: UUID, assignment_id: UUID, req: Homework, user=Depends(current_user)):
    with job_queue._connect() as db:
        course=authorize_class(db,class_id,user,lock=True)
        ensure_open(course)
        # Managers may preview material but do not submit learner work for someone else.
        if not db.execute('SELECT 1 FROM learning.class_members WHERE class_id=%s AND username=%s', (str(class_id),user['username'])).fetchone():
            raise HTTPException(403,'Only enrolled learners can submit work')
        item=assignment(db,class_id,assignment_id,lock=True)
        revision(item,req.expected_revision)
        if item['due_at'] and not item['allow_late'] and datetime.now(timezone.utc)>item['due_at']:
            raise HTTPException(409,'The submission deadline has passed')
        previous=db.execute('SELECT * FROM learning.class_submissions WHERE assignment_id=%s AND username=%s FOR UPDATE',
                            (str(assignment_id),user['username'])).fetchone()
        if previous and previous['reviewed_at']:
            raise HTTPException(409,'Reviewed work cannot be overwritten. Contact your teacher.')
        snapshot={key:item[key] for key in ('title','instructions','section','resource_type','resource_id','resource_version','required','minimum_score_percent','revision')}
        snapshot['resource_id']=str(snapshot['resource_id']) if snapshot['resource_id'] else None
        if previous:
            return db.execute('''UPDATE learning.class_submissions SET text=%s,assignment_revision=%s,assignment_snapshot=%s,
                submitted_at=now(),revision=revision+1 WHERE id=%s RETURNING *''',
                (req.text,item['revision'],Jsonb(snapshot),str(previous['id']))).fetchone()
        return db.execute('''INSERT INTO learning.class_submissions(id,assignment_id,username,text,assignment_revision,assignment_snapshot)
            VALUES(%s,%s,%s,%s,%s,%s) RETURNING *''',
            (str(uuid4()),str(assignment_id),user['username'],req.text,item['revision'],Jsonb(snapshot))).fetchone()


@router.get('/classes/{class_id}/assignments/{assignment_id}/submissions')
def submissions(class_id: UUID, assignment_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        authorize_class(db,class_id,user,manage=True)
        assignment(db,class_id,assignment_id)
        rows=db.execute('''SELECT s.*,COALESCE(NULLIF(p.display_name,''),s.username) AS display_name
            FROM learning.class_submissions s LEFT JOIN bob_user_profiles p ON p.username=s.username
            WHERE s.assignment_id=%s ORDER BY s.submitted_at''',(str(assignment_id),)).fetchall()
        return {'items':[{**row,'display_name':learner_display_name(row)} for row in rows]}


@router.put('/classes/{class_id}/assignments/{assignment_id}/submissions/{submission_id}/feedback', dependencies=[Depends(same_origin)])
def feedback(class_id: UUID, assignment_id: UUID, submission_id: UUID, req: Feedback, user=Depends(current_user)):
    with job_queue._connect() as db:
        course=authorize_class(db,class_id,user,manage=True,lock=True)
        ensure_open(course)
        assignment(db,class_id,assignment_id)
        row=db.execute('SELECT * FROM learning.class_submissions WHERE id=%s AND assignment_id=%s FOR UPDATE',
                       (str(submission_id),str(assignment_id))).fetchone()
        if not row:
            raise HTTPException(404,'Submission not found')
        revision(row,req.expected_revision)
        updated = db.execute('''UPDATE learning.class_submissions SET feedback=%s,mark=%s,max_mark=%s,reviewed_by=%s,
            reviewed_at=now(),revision=revision+1 WHERE id=%s RETURNING *''',
            (req.feedback,req.mark,req.max_mark,user['username'],str(submission_id))).fetchone()
        from .course_completion import check_and_issue_for_folder
        check_and_issue_for_folder(db,course['folder_id'],row['username'])
        return updated
