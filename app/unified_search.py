"""Owner-scoped saved-work search and current-policy knowledge retrieval."""
import re
from typing import Literal
from fastapi import APIRouter, Depends, Query
from app import job_queue, postgres_storage as storage, rag, conversation_documents, sessions
from app.auth import current_user

router = APIRouter(tags=['search'])


def excerpt(text, query, limit=280):
    text = re.sub(r'\s+', ' ', text or '').strip()
    index = text.casefold().find(query.casefold())
    start = max(0, index - 75)
    return ('…' if start else '') + text[start:start + limit] + ('…' if len(text) > start + limit else '')


def literal_pattern(query):
    return '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def search_saved(username, query, kind='all', limit=30):
    storage.ensure_schema()
    rag.ensure_schema()
    conversation_documents.ensure_schema()
    sessions.mark_note_enrichment_sessions(username)
    pattern = literal_pattern(query)
    results = []
    with job_queue._connect() as db:
        # Bound interactive search even for very large histories.
        db.execute("SET LOCAL statement_timeout = '8s'")
        if kind in ('all', 'conversations'):
            rows = db.execute('''WITH turns AS (
                SELECT id,session_id,event,
                  sum(CASE WHEN event->>'type'='request' THEN 1 ELSE 0 END)
                    OVER (PARTITION BY session_id ORDER BY id) AS turn
                FROM bob_conversation_history WHERE username=%s
                AND event->>'type' IN ('request','delta','done')
            ), replacements AS (
                SELECT *,max(id) FILTER (WHERE event->>'type'='delta' AND event->>'replace'='true')
                    OVER (PARTITION BY session_id,turn) AS replaced FROM turns
            ), answers AS (
                SELECT session_id,turn,min(id) AS id,
                    max(event->>'prompt') FILTER (WHERE event->>'type'='request') AS prompt,
                    string_agg(event->>'text','' ORDER BY id) FILTER
                      (WHERE event->>'type'='delta' AND (replaced IS NULL OR id>=replaced)) AS answer
                FROM replacements GROUP BY session_id,turn
            ) SELECT a.*,c.record FROM answers a JOIN bob_conversations c
              ON c.username=%s AND c.id=a.session_id
            WHERE NOT EXISTS (SELECT 1 FROM bob_deleted_conversations d
              WHERE d.username=c.username AND d.workspace_id=c.id)
            AND COALESCE(c.record->>'purpose','conversation') <> 'note_enrichment'
            AND (a.prompt ILIKE %s OR a.answer ILIKE %s OR c.record->>'title' ILIKE %s)
            ORDER BY a.id DESC LIMIT %s''', (username, username, pattern, pattern, pattern, limit + 1)).fetchall()
            for row in rows:
                text = row['answer'] if query.casefold() in (row['answer'] or '').casefold() else row['prompt']
                results.append(dict(kind='conversations', id=str(row['id']), title=row['record'].get('title', 'Conversation'),
                                    session_id=row['session_id'], project_id=row['record'].get('project_id'), snippet=excerpt(text, query)))
        if kind in ('all', 'files'):
            rows = db.execute('''SELECT s.scope,s.path,s.modified,
                  substring(COALESCE(p.search_text,s.search_text) FROM greatest(1,strpos(lower(COALESCE(p.search_text,s.search_text)),lower(%s))-75) FOR 400) AS passage,
                  c.id AS session_id,c.record->>'project_id' AS project_id
                FROM bob_storage_files s JOIN LATERAL (
                  SELECT id,record FROM bob_conversations c WHERE c.username=s.username
                  AND COALESCE(c.record->>'purpose','conversation') <> 'note_enrichment'
                  AND ((s.scope='session:'||c.id) OR (s.scope='project:'||(c.record->>'project_id')))
                  AND NOT EXISTS (SELECT 1 FROM bob_deleted_conversations d WHERE d.username=c.username AND d.workspace_id=c.id)
                  ORDER BY c.record->>'updated' DESC LIMIT 1
                ) c ON TRUE
                LEFT JOIN bob_conversation_documents doc ON doc.username=s.username AND doc.scope=s.scope AND doc.path=s.path AND doc.status='ready' AND doc.sha256=s.sha256
                LEFT JOIN bob_storage_files p ON p.username=doc.username AND p.scope=doc.scope AND p.path=doc.prepared_path
                WHERE s.username=%s AND s.path !~ '(^|/)[.]'
                  AND s.path !~ '(^|/)(node_modules|__pycache__|vendor)/'
                  AND s.path NOT LIKE 'document-text/%%'
                  AND (s.path ILIKE %s OR s.search_text ILIKE %s OR p.search_text ILIKE %s)
                ORDER BY s.modified DESC,s.path LIMIT %s''', (query, username, pattern, pattern, pattern, limit + 1)).fetchall()
            for row in rows:
                results.append(dict(kind='files', id=f"{row['scope']}:{row['path']}", title=row['path'], path=row['path'],
                                    session_id=row['session_id'], project_id=row['project_id'], snippet=excerpt(row['passage'], query)))
        if kind in ('all', 'knowledge'):
            predicate, access_params = rag.access_filter(username, alias='d')
            rows = db.execute(f'''SELECT d.id,d.filename,d.description,
                substring(d.prepared_text FROM greatest(1,strpos(lower(d.prepared_text),lower(%s))-75) FOR 400) AS passage
                FROM bob_knowledge_documents d WHERE d.visibility='shared' AND {predicate}
                  AND (d.filename ILIKE %s OR d.description ILIKE %s OR d.prepared_text ILIKE %s)
                ORDER BY d.created_at DESC LIMIT %s''', (query, *access_params, pattern, pattern, pattern, limit + 1)).fetchall()
            for row in rows:
                results.append(dict(kind='knowledge', id=str(row['id']), title=row['filename'],
                                    url=f"/knowledge/{row['id']}/file", snippet=excerpt(row['passage'] or row['description'], query)))
    # Round robin prevents any single category hiding other matching work.
    groups = [[item for item in results if item['kind'] == category] for category in ('conversations','files','knowledge')]
    ordered = [group[index] for index in range(limit + 1) for group in groups if index < len(group)]
    return {'results': ordered[:limit], 'has_more': len(results) > limit,
            'coverage': 'Saved conversation text, filenames, indexed text files (first 1 MB), prepared documents, and accessible knowledge. Older workspace content needs indexing; filenames remain searchable.'}


@router.get('/search')
def search(q: str = Query(min_length=2, max_length=200),
           kind: Literal['all','conversations','files','knowledge'] = 'all',
           limit: int = Query(30, ge=1, le=60), user: dict = Depends(current_user)):
    query = q.strip()
    if len(query) < 2:
        return {'results': [], 'has_more': False}
    return search_saved(user['username'], query, kind, limit)
