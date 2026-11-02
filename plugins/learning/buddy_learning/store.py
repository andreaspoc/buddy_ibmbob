"""Learning schema and authorization. Every resource lookup rechecks membership."""
import os
from threading import Lock
from fastapi import HTTPException
from app import job_queue

_lock = Lock()
_ready = set()


def ensure_schema():
    identity = os.environ['DATABASE_URL']
    with _lock:
        if identity in _ready:
            return
        with job_queue._connect() as db:
            db.execute("SELECT pg_advisory_xact_lock(hashtext('buddy_learning_schema'))")
            db.execute('CREATE SCHEMA IF NOT EXISTS learning')
            from app.keycloak_auth import schema as identity_schema
            identity_schema(db)
            from app.app_groups import schema as app_group_schema
            app_group_schema(db)
            db.execute('''CREATE TABLE IF NOT EXISTS learning.folders (
                id UUID PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('ALTER TABLE learning.folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES learning.folders(id)')
            db.execute('ALTER TABLE learning.folders ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false')
            db.execute('''DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='learning_folders_not_self'
                    AND conrelid='learning.folders'::regclass) THEN
                    ALTER TABLE learning.folders ADD CONSTRAINT learning_folders_not_self CHECK(parent_id IS NULL OR parent_id<>id);
                END IF;
            END $$''')
            db.execute('CREATE INDEX IF NOT EXISTS learning_folders_parent ON learning.folders(parent_id)')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.members (
                folder_id UUID REFERENCES learning.folders(id) ON DELETE CASCADE,
                username TEXT REFERENCES users(username) ON DELETE CASCADE,
                PRIMARY KEY(folder_id,username))''')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.folder_groups (
                folder_id UUID REFERENCES learning.folders(id) ON DELETE CASCADE,
                issuer TEXT NOT NULL, group_path TEXT NOT NULL, PRIMARY KEY(folder_id,issuer,group_path))''')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.folder_app_groups (
                folder_id UUID REFERENCES learning.folders(id) ON DELETE CASCADE,
                group_id UUID REFERENCES bob_app_groups(id) ON DELETE CASCADE,
                PRIMARY KEY(folder_id,group_id))''')
            db.execute('CREATE INDEX IF NOT EXISTS learning_members_user ON learning.members(username)')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.books (
                id UUID PRIMARY KEY, folder_id UUID REFERENCES learning.folders(id),
                title TEXT NOT NULL, author TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
                deleted BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute("ALTER TABLE learning.books ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT 'book.epub'")
            db.execute("ALTER TABLE learning.books ADD COLUMN IF NOT EXISTS extension TEXT NOT NULL DEFAULT 'epub'")
            db.execute("UPDATE learning.books SET filename=title||'.epub' WHERE filename='book.epub' AND extension='epub'")
            db.execute('''CREATE TABLE IF NOT EXISTS learning.progress (
                book_id UUID REFERENCES learning.books(id) ON DELETE CASCADE,
                username TEXT REFERENCES users(username) ON DELETE CASCADE,
                data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(book_id,username))''')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.reader_notes (
                id UUID PRIMARY KEY, book_id UUID REFERENCES learning.books(id) ON DELETE CASCADE,
                username TEXT REFERENCES users(username) ON DELETE CASCADE,
                chapter_id TEXT NOT NULL, page INTEGER NOT NULL DEFAULT 0,
                color TEXT NOT NULL, text TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS learning_reader_notes_owner ON learning.reader_notes(book_id,username)')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.quizzes (
                id UUID PRIMARY KEY, folder_id UUID REFERENCES learning.folders(id),
                book_id UUID REFERENCES learning.books(id), title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
                version INTEGER NOT NULL DEFAULT 0, draft JSONB NOT NULL, published JSONB,
                created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.submissions (
                id UUID PRIMARY KEY, quiz_id UUID REFERENCES learning.quizzes(id),
                quiz_version INTEGER NOT NULL, username TEXT NOT NULL,
                request_id UUID NOT NULL, digest TEXT NOT NULL, answers JSONB NOT NULL,
                questions JSONB NOT NULL, grades JSONB NOT NULL, score DOUBLE PRECISION NOT NULL,
                max_score DOUBLE PRECISION NOT NULL, pending_manual BOOLEAN NOT NULL,
                submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(quiz_id,quiz_version,username), UNIQUE(username,request_id))''')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.quiz_starts (
                quiz_id UUID NOT NULL REFERENCES learning.quizzes(id) ON DELETE CASCADE,
                username TEXT NOT NULL REFERENCES users(username),
                started_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(quiz_id,username))''')
            from .lessons import schema as lesson_schema
            lesson_schema(db)
            from .classrooms import schema as classroom_schema
            classroom_schema(db)
            from .course_completion import schema as completion_schema
            completion_schema(db)
            db.execute('ALTER TABLE learning.books ADD COLUMN IF NOT EXISTS lesson_id UUID REFERENCES learning.lessons(id) ON DELETE SET NULL')
            db.execute('CREATE INDEX IF NOT EXISTS learning_books_folder ON learning.books(folder_id)')
            db.execute('CREATE INDEX IF NOT EXISTS learning_books_lesson ON learning.books(lesson_id)')
            db.execute('CREATE INDEX IF NOT EXISTS learning_quizzes_folder ON learning.quizzes(folder_id)')
            db.execute('''CREATE TABLE IF NOT EXISTS learning.class_notes (
                id UUID PRIMARY KEY,
                folder_id UUID NOT NULL REFERENCES learning.folders(id) ON DELETE CASCADE,
                lesson_id UUID REFERENCES learning.lessons(id) ON DELETE SET NULL,
                username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT 'butter' CHECK(color IN ('butter','rose','lavender','mint','sky')),
                tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                favorite BOOLEAN NOT NULL DEFAULT false,
                bob_note_id BIGINT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now())''')
            db.execute('CREATE INDEX IF NOT EXISTS learning_class_notes_folder_user ON learning.class_notes(folder_id, username, updated_at DESC)')
            db.execute('''UPDATE learning.quizzes q
                SET lesson_id = l.id
                FROM learning.lessons l
                WHERE q.folder_id = l.folder_id
                  AND q.lesson_id IS NULL
                  AND lower(trim(q.title)) = lower(trim(l.title))''')
        _ready.add(identity)


def admin(user):
    if not user.get('is_admin'):
        raise HTTPException(403, 'Administrator access required')
    return user


def can_create(db, user):
    if user.get('is_admin'):
        return True
    from app.app_groups import has_role
    if has_role(db,user['username'],'learning_teacher'):
        return True
    from app.keycloak_groups import realm
    group = os.getenv('BUDDY_LEARNING_TEACHER_GROUP', '/teacher')
    return bool(db.execute('''SELECT 1 FROM bob_keycloak_identities i JOIN bob_keycloak_group_memberships m
        ON m.issuer=i.issuer AND m.subject=i.subject
        WHERE i.issuer=%s AND i.username=%s AND m.group_path=%s''', (realm(), user['username'], group)).fetchone())


def creator(row, user):
    if row['created_by'] != user['username']:
        raise HTTPException(403, 'Only the quiz creator can edit or approve this quiz')


def ancestors(db, folder_id):
    """Return parent metadata for administrative ACL display only.

    UNION bounds recursion even if legacy or externally modified data has a
    cycle. Callers must authorize the requested folder before exposing names.
    """
    return db.execute('''WITH RECURSIVE ancestor_rows AS (
        SELECT id,name,parent_id FROM learning.folders WHERE id=%s
        UNION
        SELECT f.id,f.name,f.parent_id FROM learning.folders f
        JOIN ancestor_rows a ON f.id=a.parent_id
    ) SELECT id,name,parent_id FROM ancestor_rows WHERE id<>%s ORDER BY name,id''',
        (str(folder_id), str(folder_id))).fetchall()


def folder(db, folder_id, user):
    # Keep authorization and writes in the same transaction as class deletion.
    row = db.execute('SELECT * FROM learning.folders WHERE id=%s FOR SHARE', (str(folder_id),)).fetchone()
    if not row or row.get('deleted'):
        raise HTTPException(404, 'Folder not found')
    if user.get('is_admin'):
        return row
    if db.execute('''WITH RECURSIVE app_ancestor_ids AS (
        SELECT id,parent_id FROM learning.folders WHERE id=%s
        UNION
        SELECT f.id,f.parent_id FROM learning.folders f JOIN app_ancestor_ids a ON f.id=a.parent_id
    ) SELECT 1 WHERE EXISTS(SELECT 1 FROM learning.members m JOIN app_ancestor_ids a ON a.id=m.folder_id
        WHERE m.username=%s) OR EXISTS(SELECT 1 FROM learning.folder_app_groups g
        JOIN app_ancestor_ids a ON a.id=g.folder_id JOIN bob_app_group_members m ON m.group_id=g.group_id
        WHERE m.username=%s)''',(str(folder_id),user['username'],user['username'])).fetchone():
        return row
    from app.keycloak_groups import realm
    if not realm() or not db.execute('''WITH RECURSIVE ancestor_ids AS (
        SELECT id,parent_id FROM learning.folders WHERE id=%s
        UNION
        SELECT f.id,f.parent_id FROM learning.folders f JOIN ancestor_ids a ON f.id=a.parent_id
    ) SELECT 1 FROM bob_keycloak_identities i WHERE i.issuer=%s AND i.username=%s AND (
        EXISTS(SELECT 1 FROM learning.members m JOIN ancestor_ids a ON a.id=m.folder_id
            WHERE m.username=i.username) OR
        EXISTS(SELECT 1 FROM learning.folder_groups g JOIN ancestor_ids a ON a.id=g.folder_id
            JOIN bob_keycloak_group_memberships km ON km.issuer=g.issuer
            AND km.group_path=g.group_path AND km.subject=i.subject WHERE g.issuer=i.issuer))''',
            (str(folder_id), realm(), user['username'])).fetchone():
        raise HTTPException(404, 'Folder not found')
    return row


def visible_folders(db, user):
    """List direct grants and their descendants, never inaccessible ancestors."""
    if user.get('is_admin'):
        return db.execute('SELECT id,name,parent_id FROM learning.folders WHERE NOT deleted ORDER BY lower(name),id').fetchall()
    local = db.execute('''WITH RECURSIVE app_authorized_folders(id) AS (
        SELECT f.id FROM learning.folders f WHERE NOT f.deleted AND (EXISTS(SELECT 1 FROM learning.members m
            WHERE m.folder_id=f.id AND m.username=%s) OR EXISTS(SELECT 1 FROM learning.folder_app_groups g
            JOIN bob_app_group_members m ON m.group_id=g.group_id WHERE g.folder_id=f.id AND m.username=%s))
        UNION
        SELECT child.id FROM learning.folders child JOIN app_authorized_folders a ON child.parent_id=a.id WHERE NOT child.deleted
    ) SELECT f.id,f.name,f.parent_id FROM learning.folders f
        JOIN app_authorized_folders a ON a.id=f.id ORDER BY lower(f.name),f.id''',
        (user['username'],user['username'])).fetchall()
    from app.keycloak_groups import realm
    if not realm():
        return local
    legacy = db.execute('''WITH RECURSIVE authorized_folders(id) AS (
        SELECT f.id FROM learning.folders f WHERE NOT f.deleted AND EXISTS (
            SELECT 1 FROM bob_keycloak_identities i WHERE i.issuer=%s AND i.username=%s AND (
                EXISTS(SELECT 1 FROM learning.members m WHERE m.folder_id=f.id AND m.username=i.username) OR
                EXISTS(SELECT 1 FROM learning.folder_groups g JOIN bob_keycloak_group_memberships km ON
                    km.issuer=g.issuer AND km.group_path=g.group_path AND km.subject=i.subject
                    WHERE g.folder_id=f.id AND g.issuer=i.issuer)))
        UNION
        SELECT child.id FROM learning.folders child JOIN authorized_folders a ON child.parent_id=a.id WHERE NOT child.deleted
    ) SELECT f.id,f.name,f.parent_id FROM learning.folders f
        JOIN authorized_folders a ON a.id=f.id ORDER BY lower(f.name),f.id''',
        (realm(), user['username'])).fetchall()
    combined = {str(row['id']):row for row in [*local,*legacy]}
    return sorted(combined.values(),key=lambda row:(row['name'].lower(),str(row['id'])))


def book(db, book_id, user):
    row = db.execute('SELECT * FROM learning.books WHERE id=%s AND NOT deleted', (str(book_id),)).fetchone()
    if not row:
        raise HTTPException(404, 'Book not found')
    folder(db, row['folder_id'], user)
    return row


def quiz(db, quiz_id, user, lock=False):
    row = db.execute('SELECT * FROM learning.quizzes WHERE id=%s' + (' FOR UPDATE' if lock else ''), (str(quiz_id),)).fetchone()
    if not row:
        raise HTTPException(404, 'Quiz not found')
    folder(db, row['folder_id'], user)
    if row['status'] == 'draft' and (row['created_by'] != user['username'] or not can_create(db, user)):
        raise HTTPException(404, 'Quiz not found')
    return row
