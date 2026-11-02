"""Private Office Suite folder metadata. Object storage keys never encode folders."""
from uuid import uuid4
from fastapi import HTTPException


def migrate(db):
    db.execute('''CREATE TABLE IF NOT EXISTS office.bob_office_folders (
        id UUID PRIMARY KEY, username TEXT NOT NULL, parent_id UUID,
        name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(id,username),
        FOREIGN KEY(parent_id,username) REFERENCES office.bob_office_folders(id,username) ON DELETE RESTRICT)''')
    db.execute('''CREATE UNIQUE INDEX IF NOT EXISTS bob_office_folder_siblings
        ON office.bob_office_folders(username,COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name))''')
    db.execute('ALTER TABLE office.bob_office_files ADD COLUMN IF NOT EXISTS folder_id UUID')
    db.execute('''DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bob_office_file_folder_owner'
            AND conrelid='office.bob_office_files'::regclass) THEN
            ALTER TABLE office.bob_office_files ADD CONSTRAINT bob_office_file_folder_owner
                FOREIGN KEY(folder_id,username) REFERENCES office.bob_office_folders(id,username) ON DELETE RESTRICT;
        END IF;
        END $$''')
    db.execute('CREATE INDEX IF NOT EXISTS bob_office_file_folder ON office.bob_office_files(username,folder_id)')


def lock_owner(db, username):
    db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('office-folders:' + username,))


def folder(db, folder_id, username):
    row = db.execute('SELECT * FROM office.bob_office_folders WHERE id=%s AND username=%s',
                     (str(folder_id), username)).fetchone()
    if not row:
        raise HTTPException(404, 'Folder not found')
    return row


def destination(db, folder_id, username):
    if folder_id is not None:
        return folder(db, folder_id, username)
    return None


def clean_name(name):
    if not isinstance(name, str):
        raise HTTPException(422, 'Enter a folder name')
    name = name.strip()
    if not name or len(name) > 200 or name in ('.', '..') or any(ord(c) < 32 or c in '/\\' for c in name):
        raise HTTPException(422, 'Enter a folder name of 1 to 200 characters without slashes')
    return name


def summary(row):
    return {key: str(row[key]) if row.get(key) is not None and key in ('id', 'parent_id') else row.get(key)
            for key in ('id', 'name', 'parent_id', 'created_at', 'updated_at')}


def unique_name(db, username, parent_id, name, exclude=None):
    row = db.execute('''SELECT id FROM office.bob_office_folders WHERE username=%s
        AND parent_id IS NOT DISTINCT FROM %s::uuid AND lower(name)=lower(%s)
        AND (%s::uuid IS NULL OR id<>%s::uuid)''',
        (username, str(parent_id) if parent_id else None, name, str(exclude) if exclude else None,
         str(exclude) if exclude else None)).fetchone()
    if row:
        raise HTTPException(409, 'A folder with this name already exists here')


def create(db, username, name, parent_id):
    lock_owner(db, username)
    name = clean_name(name)
    destination(db, parent_id, username)
    unique_name(db, username, parent_id, name)
    return summary(db.execute('''INSERT INTO office.bob_office_folders(id,username,parent_id,name)
        VALUES(%s,%s,%s,%s) RETURNING *''',
        (str(uuid4()), username, str(parent_id) if parent_id else None, name)).fetchone())


def update(db, username, folder_id, changes):
    lock_owner(db, username)
    current = folder(db, folder_id, username)
    name = clean_name(changes['name']) if 'name' in changes else current['name']
    parent_id = changes.get('parent_id', current['parent_id'])
    # Walking the prospective ancestry under the owner's lock prevents cycles,
    # including two simultaneous moves that would otherwise each look valid.
    visited = {str(folder_id)}
    ancestor = parent_id
    while ancestor is not None:
        if str(ancestor) in visited:
            raise HTTPException(409, 'A folder cannot be moved inside itself or its descendants')
        visited.add(str(ancestor))
        ancestor = folder(db, ancestor, username)['parent_id']
    unique_name(db, username, parent_id, name, exclude=folder_id)
    return summary(db.execute('''UPDATE office.bob_office_folders SET name=%s,parent_id=%s,updated_at=now()
        WHERE id=%s AND username=%s RETURNING *''',
        (name, str(parent_id) if parent_id else None, str(folder_id), username)).fetchone())


def delete(db, username, folder_id):
    lock_owner(db, username)
    folder(db, folder_id, username)
    occupied = db.execute('''SELECT EXISTS(SELECT 1 FROM office.bob_office_folders WHERE parent_id=%s AND username=%s)
        OR EXISTS(SELECT 1 FROM office.bob_office_files WHERE folder_id=%s AND username=%s) AS occupied''',
        (str(folder_id), username, str(folder_id), username)).fetchone()
    if occupied['occupied']:
        raise HTTPException(409, 'Move or delete the files and subfolders before deleting this folder')
    db.execute('DELETE FROM office.bob_office_folders WHERE id=%s AND username=%s', (str(folder_id), username))
    return {'deleted': True, 'id': str(folder_id)}
