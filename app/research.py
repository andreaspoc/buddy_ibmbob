"""Private executive research reports backed by durable tasks."""
import json
import os
import re
from fastapi import APIRouter, Depends, HTTPException, Response, Request
from pydantic import BaseModel, Field
from app.auth import current_user
from app import job_queue, postgres_storage as storage
from app.workflows import WorkflowSpec, ensure_schema, _dispatch
from app.artifacts import scope_for
from app.origin_policy import same_origin
from app.research_pdf import ResearchPDFSpec, bounded_payload, pdf_filename, render_pdf

router = APIRouter(prefix='/research', tags=['research'])

class ResearchSpec(BaseModel):
    ui_language: str = Field(default="en", pattern=r"^(en|el|hi|mt)$")
    topic: str = Field(min_length=10, max_length=12000)
    title: str = Field(default='', max_length=160)
    style: str = Field(default='executive', pattern='^(executive|analyst)$')
    diagrams: bool = True
    screenshots: bool = False
    web_search: bool = True
    knowledge: bool = False
    office: bool = False
    max_rounds: int = Field(default=1, ge=1, le=3)
    timeout_seconds: int = Field(default=300, ge=60, le=3600)

# A follow-up chat shares the report's workspace, so only research jobs describe the report.
LATEST_JOB_SQL = """JOIN LATERAL (SELECT id,status,workspace_key,payload FROM bob_jobs
    WHERE username=c.username AND workspace_id=c.id AND payload ? 'research'
    ORDER BY created_at DESC LIMIT 1) j ON true"""
# One automatic retry survives a worker restart; recorded pages are not fetched twice.
RESEARCH_ATTEMPTS = 2
MIN_CHAT_REPORT_HEADINGS = 4
MIN_CHAT_REPORT_CHARS = 2000


def public_status(row):
    """An explicit stop is not a failure, and only unfinished reports can resume."""
    return 'stopped' if row['status'] == 'failed' and (row.get('payload') or {}).get('cancel_requested') else row['status']


def report_from_chat(text):
    """Extract a complete report from a chat answer; a short reply about a change never qualifies."""
    start = re.search(r'^#{1,3}\s', text or '', re.M)
    if not start:
        return ''
    report = re.split(r'^```bobnext\s*$', text[start.start():], maxsplit=1, flags=re.M)[0].strip()
    headings = re.findall(r'^#{1,3}\s', report, re.M)
    return report if len(headings) >= MIN_CHAT_REPORT_HEADINGS and len(report) >= MIN_CHAT_REPORT_CHARS else ''


def latest_chat_report(username, session_id):
    """Find the fullest report written in the conversation when no report file was saved."""
    from app.tasks import task_detail
    with job_queue._connect() as db:
        rows = db.execute("""SELECT id FROM bob_jobs WHERE username=%s AND workspace_id=%s AND status='completed'
            AND NOT payload ? 'research' ORDER BY created_at DESC LIMIT 10""", (username, session_id)).fetchall()
    # A later answer may rewrite one section only, so the most complete answer represents the report.
    reports = [report_from_chat((task_detail(username, str(row['id'])) or {}).get('result', '')) for row in rows]
    return max(reports, key=len, default='')


def research_usage(events):
    """Sum completed phases across retries; terminal totals are legacy fallback."""
    import math
    cost, tokens, known_cost, known_tokens = 0.0, 0, False, False
    phases, phase_events = [], False
    for event in events:
        if event.get('type') not in {'research_usage', 'done', 'error'}: continue
        phase = event.get('type') == 'research_usage'
        if phase or not phase_events:
            value = event.get('cost')
            count = event.get('tokens')
            if isinstance(value, (int,float)) and not isinstance(value,bool) and math.isfinite(value) and value >= 0:
                cost += value; known_cost = True
            if isinstance(count, (int,float)) and not isinstance(count,bool) and math.isfinite(count) and count >= 0:
                tokens += int(count); known_tokens = True
            if phase: phases.append({'phase':event.get('phase','Research'), 'cost':value, 'tokens':count})
        if phase: phase_events = True
        else: phase_events = False
    return {'bobcoins':cost if known_cost else None, 'tokens':tokens if known_tokens else None, 'phases':phases}

@router.get('/capabilities')
def capabilities(user=Depends(current_user)):
    from app.mcp_access import get_authorized_server
    from app.workspace_config import ensure_brave_mcp
    ensure_brave_mcp()
    from app.research_sources import office_available
    return {'web_search': bool(os.getenv('BRAVE_API_KEY','').strip()) and bool(get_authorized_server(user['username'], 'brave_search')), 'knowledge': True, 'office': office_available(user['username'])}

def authorize_sources(username, web_search, knowledge, office):
    """Check source access at every start; a resume must not outlive revoked permissions."""
    from app.mcp_access import get_authorized_server
    from app.workspace_config import ensure_brave_mcp
    ensure_brave_mcp()
    if web_search and not get_authorized_server(username, 'brave_search'):
        raise HTTPException(403, 'Web search is not available for your employee groups')
    if office:
        from app.research_sources import office_available
        if not office_available(username):
            raise HTTPException(403, 'Connect an authorized Microsoft account before Office research')
    if not (web_search or knowledge or office):
        raise HTTPException(422, 'Choose public web, internal knowledge, or Office sources')
    if web_search and not os.getenv('BRAVE_API_KEY','').strip():
        raise HTTPException(422, 'Public web research requires a configured BRAVE_API_KEY')


@router.post('')
def create(spec: ResearchSpec, user=Depends(current_user)):
    authorize_sources(user['username'], spec.web_search, spec.knowledge, spec.office)
    ensure_schema()
    workflow = WorkflowSpec(ui_language=spec.ui_language, name=(spec.title.strip() or spec.topic.strip())[:100], prompt=spec.topic.strip(), timeout_seconds=spec.timeout_seconds, web_search=spec.web_search)
    with job_queue._connect() as db:
        result = _dispatch(db, user['username'], workflow)
        payload = {**spec.model_dump(), 'sources':(['web'] if spec.web_search else []) + (['knowledge'] if spec.knowledge else []) + (['office'] if spec.office else []), 'depth':spec.max_rounds, 'session_id':result['session_id']}
        db.execute("UPDATE bob_jobs SET max_attempts=%s,payload=payload || %s::jsonb WHERE id=%s", (RESEARCH_ATTEMPTS, json.dumps({'research':payload}), result['job_id']))
        db.execute("UPDATE bob_conversations SET record=record || %s::jsonb WHERE username=%s AND id=%s", (json.dumps({'research':True}), user['username'],result['session_id']))
    return result

@router.get('')
def reports(user=Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        rows = db.execute("SELECT c.id,c.record,j.id AS job_id,j.status,j.payload FROM bob_conversations c " + LATEST_JOB_SQL + " WHERE c.username=%s AND c.record->>'research'='true' ORDER BY c.record->>'updated' DESC LIMIT 100", (user['username'],)).fetchall()
    return [{'session_id':r['id'], 'title':r['record']['title'], 'job_id':str(r['job_id']), 'status':public_status(r), 'updated_at':r['record']['updated']} for r in rows]

@router.get('/{session_id}')
def detail(session_id:str, user=Depends(current_user)):
    scope=scope_for(user['username'],session_id)
    with job_queue._connect() as db:
        row=db.execute("SELECT c.record,j.status,j.id AS job_id,j.payload FROM bob_conversations c " + LATEST_JOB_SQL + " WHERE c.username=%s AND c.id=%s AND c.record->>'research'='true'",(user['username'],session_id)).fetchone()
    if not row: raise HTTPException(404,'Research report not found')
    def read(path, structured=False):
        item=storage.get_file(user['username'],scope,path)
        if not item:return None if structured else ''
        text=bytes(item['content']).decode('utf-8')
        if structured:
            try:return json.loads(text)
            except ValueError:return None
        return text
    from app.tasks import task_detail
    live = task_detail(user['username'], str(row['job_id'])) or {}
    with job_queue._connect() as db:
        events = db.execute("SELECT event,created_at FROM bob_job_events WHERE job_id=%s AND event->>'type' IN ('status','tool','error','done') ORDER BY id DESC LIMIT 40", (row['job_id'],)).fetchall()
    activity = []
    for item in reversed(events):
        event = item['event']
        data = event.get('input') or {}
        if not isinstance(data, dict): data = {}
        activity.append({'phase':event.get('phase',''), 'message':event.get('message') or event.get('name','').replace('_',' '), 'status':event.get('status',''), 'query':str(data.get('query',''))[:500], 'url':str(data.get('url',''))[:1000], 'timestamp':item['created_at'].isoformat()})
    with job_queue._connect() as db:
        # Spending includes every earlier attempt at this report.
        usage_events=db.execute("""SELECT e.event FROM bob_job_events e JOIN bob_jobs j ON j.id=e.job_id
            WHERE j.username=%s AND j.workspace_id=%s AND j.payload ? 'research'
            AND e.event->>'type' IN ('research_usage','done','error') ORDER BY e.id""", (user['username'],session_id)).fetchall()
    usage=research_usage([item['event'] for item in usage_events])
    review=read('research-review.json',True)
    status=public_status(row)
    return {'title':row['record']['title'],'status':status,'job_id':str(row['job_id']),'can_resume':status in {'failed','stopped'},'progress':live.get('progress',''), 'activity':activity, 'usage':usage, 'report':read('research-report.md') or live.get('result','') or latest_chat_report(user['username'],session_id),'plan':read('research-plan.json',True),'evidence':read('research-evidence.json',True) or [],'review':review,'visuals':read('research-visuals.json',True) or [],'files':[]}

@router.post('/{session_id}/resume', dependencies=[Depends(same_origin)])
def resume(session_id:str, user=Depends(current_user)):
    """Continue an unfinished report in its workspace, reusing its plan, evidence and draft."""
    username=user['username']
    scope_for(username,session_id)
    ensure_schema()
    with job_queue._connect() as db:
        row=db.execute("SELECT j.status,j.workspace_key,j.payload FROM bob_conversations c " + LATEST_JOB_SQL + " WHERE c.username=%s AND c.id=%s AND c.record->>'research'='true'",(username,session_id)).fetchone()
    if not row: raise HTTPException(404,'Research report not found')
    if row['status'] in {'queued','running'}: raise HTTPException(409,'This research report is still running')
    if row['status']=='completed': raise HTTPException(409,'This research report has already finished')
    research=row['payload']['research']
    authorize_sources(username, research.get('web_search',False), research.get('knowledge',False), research.get('office',False))
    payload={key:value for key,value in row['payload'].items() if key not in {'cancel_requested','superseded'}}
    payload['research']={**research,'session_id':session_id}
    try:
        job_id=job_queue.enqueue(username,session_id,row['workspace_key'],payload)
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from exc
    with job_queue._connect() as db:
        db.execute("UPDATE bob_jobs SET max_attempts=%s WHERE id=%s",(RESEARCH_ATTEMPTS,job_id))
    return {'job_id':job_id,'session_id':session_id}


@router.get('/{session_id}/export')
def export(session_id:str, format:str='markdown', user=Depends(current_user)):
    report=detail(session_id,user)
    if not report['report']:raise HTTPException(404,'Report not available yet')
    if format!='markdown':raise HTTPException(422,'Supported format: markdown')
    return Response(report['report'],media_type='text/markdown',headers={'Content-Disposition':'attachment; filename="research-report.md"'})


@router.post('/{session_id}/office', dependencies=[Depends(same_origin)])
async def save_to_office(session_id: str, request: Request, spec: ResearchPDFSpec = Depends(bounded_payload),
                         user=Depends(current_user)):
    from starlette.concurrency import run_in_threadpool
    from app.plugin_client import save_office_file
    report = await run_in_threadpool(detail, session_id, user)
    if report['status'] != 'completed' or not report['report']:
        raise HTTPException(409, 'Wait for the research report to finish before saving it')
    raw = spec.html.encode('utf-8') if spec.format == 'html' else await render_pdf(spec.html)
    name = pdf_filename(report['title'])
    if spec.format == 'html':
        name = name[:-4][:195].rstrip('. ') + '.html'
    return await save_office_file(request, user['username'], name, raw)
