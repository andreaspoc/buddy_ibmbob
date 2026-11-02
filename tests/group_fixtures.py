"""Create real administrator-style groups for integration tests."""
from uuid import uuid4

from app import auth


def make_group(name, *usernames):
    identity = str(uuid4())
    with auth._connect() as db:
        db.execute("INSERT INTO bob_app_groups(id,name,created_by) VALUES (%s,%s,'test')", (identity, f'{name}-{identity[:8]}'))
        for username in usernames:
            db.execute('INSERT INTO bob_app_group_members(group_id,username) VALUES (%s,%s)', (identity, username))
    return identity


def set_members(group, *usernames):
    with auth._connect() as db:
        db.execute('DELETE FROM bob_app_group_members WHERE group_id=%s', (group,))
        for username in usernames:
            db.execute('INSERT INTO bob_app_group_members(group_id,username) VALUES (%s,%s)', (group, username))


def delete_group(group):
    with auth._connect() as db:
        db.execute('DELETE FROM bob_app_groups WHERE id=%s', (group,))
