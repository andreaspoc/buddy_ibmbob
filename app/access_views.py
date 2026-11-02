"""Personal access summaries and administrator previews and durable audit history."""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from app.auth import current_user, knowledge_access, user_profile, _connect
from app.admin_users import administrator
from app import rag, mcp_access

router = APIRouter(tags=['access'])


class AccessPreview(BaseModel):
    groups: list[str] = Field(default_factory=list, max_length=100)


def access_summary(profile):
    audiences = ['both']
    for group in profile.get('groups') or []:
        audiences.append(group['id'] if isinstance(group, dict) else group)
    return {'libraries': [{'id': 'company', 'name': 'Company Knowledge'}], 'audiences': audiences}


@router.get('/access/groups')
def visible_groups(user: dict = Depends(current_user)):
    """Administrators choose from every group; other people only see the groups they belong to."""
    access = knowledge_access(user['username']) or {}
    with _connect() as db:
        if access.get('is_admin'):
            rows = db.execute('SELECT id,name FROM bob_app_groups ORDER BY lower(name)').fetchall()
        else:
            rows = db.execute('SELECT g.id,g.name FROM bob_app_group_members m JOIN bob_app_groups g ON g.id=m.group_id WHERE m.username=%s ORDER BY lower(g.name)', (user['username'],)).fetchall()
    return {'items': [{'id': str(row[0]), 'name': row[1]} for row in rows]}


@router.get('/access/me')
def my_access(user: dict = Depends(current_user)):
    access = knowledge_access(user['username']) or {}
    profile = user_profile(user['username'], bool(access.get('is_admin')))
    return {'user': profile, **access_summary(profile), 'administrator': profile['is_admin'], 'mcps': mcp_access.catalog(user['username'])}


@router.post('/admin/access-preview')
def preview(body: AccessPreview, user: dict = Depends(administrator)):
    profile = body.model_dump()
    return {'profile': profile, **access_summary(profile), 'documents': rag.preview_documents(profile), 'mcps': mcp_access.preview(profile)}


@router.get('/admin/audit')
def audit(user: dict = Depends(administrator), limit: int = Query(50, ge=1, le=100),
          before_id: int | None = Query(None, ge=1), actor: str | None = Query(None, max_length=128),
          action: str | None = Query(None, max_length=128)):
    actor_pattern = '%' + actor + '%' if actor is not None else None
    with _connect() as db:
        rows = db.execute('''SELECT a.id,a.actor,COALESCE(p.display_name,a.actor),a.action,a.target,a.details,a.created_at,COALESCE(a.details->'after'->>'filename',a.details->'before'->>'filename',target_profile.display_name,a.target)
            FROM bob_access_audit a LEFT JOIN bob_user_profiles p ON p.username=a.actor
            LEFT JOIN bob_user_profiles target_profile ON target_profile.username=a.target
            WHERE (%s::text IS NULL OR a.actor = %s OR p.display_name ILIKE %s OR p.email ILIKE %s)
              AND (%s::bigint IS NULL OR a.id < %s)
              AND (%s::text IS NULL OR a.action = %s)
            ORDER BY a.id DESC LIMIT %s''',
            (actor, actor, actor_pattern, actor_pattern, before_id, before_id, action, action, limit + 1)).fetchall()
    events = [{'id': row[0], 'actor': row[1], 'actor_name': row[2], 'action': row[3],
               'target': row[4], 'target_name': row[7], 'details': row[5], 'created_at': row[6].isoformat()} for row in rows[:limit]]
    return {'events': events, 'next_before_id': events[-1]['id'] if len(rows) > limit else None}
