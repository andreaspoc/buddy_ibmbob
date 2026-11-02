"""Ephemeral typing signals. Draft contents are never accepted or persisted."""
import json
from fastapi import Depends
from pydantic import BaseModel, ConfigDict
from app import job_queue


class TypingSignal(BaseModel):
    model_config = ConfigDict(extra='forbid')
    typing: bool
    parent_id: int | None = None


def register(router, current_user, same_origin):
    from buddy_people import community as c

    @router.post('/rooms/{room_id}/typing', dependencies=[Depends(same_origin)])
    def signal(room_id: int, body: TypingSignal, user=Depends(current_user)):
        c.ensure_schema()
        with job_queue._connect() as db:
            c.member(db, room_id, user['username'], True)
            if body.parent_id is not None:
                from buddy_people.community_collaboration import message_in_room
                message_in_room(db, room_id, body.parent_id)
            row = db.execute(f'''SELECT {c.display_name_sql('u.username')} AS name
                FROM users u LEFT JOIN bob_user_profiles p ON p.username=u.username
                WHERE u.username=%s''', (user['username'],)).fetchone()
            payload = {'type': 'typing', 'room_id': room_id, 'username': user['username'],
                       'display_name': row['name'] if row else 'Member',
                       'typing': body.typing, 'parent_id': body.parent_id}
            db.execute("SELECT pg_notify('bob_community_typing',%s)", (json.dumps(payload),))
        return {'sent': True}
