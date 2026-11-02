from __future__ import annotations

from app.branding import brand_text
import os
import re
import json
import uuid
import shutil
import mimetypes
import tempfile
import asyncio
import logging
from contextlib import aclosing, suppress
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import quote

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Depends, Request, Response, UploadFile, File, Form
from fastapi import Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from app.frontend_assets import frontend_assets
from pydantic import BaseModel, Field, field_validator

from app.approval_policy import ApprovalPolicy
from app.acp_bridge import BobACPBridge
from app import projects as project_store
from starlette.concurrency import run_in_threadpool
from app.microsoft_auth import router as microsoft_router
from app.tasks import router as tasks_router
from app.research import router as research_router
from app.workflows import router as workflows_router
from app.mcp_catalog import router as mcp_catalog_router
from app.mcp_oauth import router as mcp_oauth_router
from app.productivity import router as productivity_router
from app.project_memory import router as project_memory_router
from app.conversation_branching import router as conversation_branching_router
from app.message_deletion import router as message_deletion_router
from app.voice import router as voice_router
from app.notification_inbox import router as notification_inbox_router
from app.agent_catalog import router as agent_catalog_router
from app.spreadsheet_utils import summarize_spreadsheet
from app import postgres_storage as storage, job_queue, rag
from app.presentation_delete import delete_presentation
from app.conversation_delete import delete_conversation
from app.user_appearance import Appearance, read_appearance, write_appearance
from app.auth import (
    authenticate, create_user, current_user, end_session, has_users,
    list_users, start_session,
)
from app.knowledge_intent import knowledge_policy
from app.a2a_client import discover_agent, validate_url, validate_mcp_url
from app.sessions import (
    append_history, create_session, list_sessions, read_history, touch_session,
    user_root, workspace_for, storage_scope, workspace_key,
)
from app.presentation import (
    build_presentation_prompt,
    build_html_presentation_prompt,
    build_html_edit_guidance,
    get_presentation_template,
    PresentationTemplateCreate,
    create_presentation_template,
    list_presentation_templates,
    presentation_intent,
    artifact_role,
)
from app.workspace_config import (
    ALLOWED_GROUPS,
    create_mode,
    create_mcp,
    delete_mcp,
    create_agent,
    update_agent,
    delete_agent,
    create_skill,
    get_skill,
    update_skill,
    delete_skill,
    get_agent,
    list_agents,
    list_mcps,
    list_modes,
    list_skills,
)
from app.hooks import (
    BUILTIN_HOOK_TEMPLATES,
    list_hooks,
    save_hook,
    delete_hook,
    toggle_hook,
    record_hook_audit,
    execute_event_hooks,
)


app = FastAPI(
    title="Assistant ACP to A2A bridge",
    version="0.1.0",
    description="Enterprise AI workspace with HTTP and A2A JSON-RPC APIs.",
)
from app.access_boundary import AccessBoundaryMiddleware
from app.plugin_gateway import PluginGatewayMiddleware
app.add_middleware(PluginGatewayMiddleware)
app.add_middleware(AccessBoundaryMiddleware)
from app.download_review import DownloadReviewMiddleware
app.add_middleware(DownloadReviewMiddleware)
from app.browser_security import BrowserSecurityMiddleware
app.add_middleware(BrowserSecurityMiddleware)
logger = logging.getLogger(__name__)
from app.keycloak_auth import router as keycloak_router, configured as keycloak_configured, local_login_enabled
app.include_router(keycloak_router)
from app.admin_users import administrator, router as admin_users_router
from app.login_throttle import reserve_login_attempt, clear_account_attempts, LoginThrottled
from app.file_delivery import file_headers
app.include_router(admin_users_router)
from app.smtp_settings import router as smtp_settings_router
app.include_router(smtp_settings_router)
from app.bob_key_settings import provider_configured, router as bob_key_settings_router
app.include_router(bob_key_settings_router)
from app.instance_setup import router as instance_setup_router
app.include_router(instance_setup_router)
from app.buddy_profiles import router as buddy_profiles_router
app.include_router(buddy_profiles_router)
from app.app_groups import router as app_groups_router
app.include_router(app_groups_router)
from app.access_views import router as access_views_router
from app.answer_feedback import router as answer_feedback_router
app.include_router(access_views_router)
app.include_router(answer_feedback_router)
app.include_router(microsoft_router)
app.include_router(tasks_router)
app.include_router(workflows_router)
app.include_router(research_router)
app.include_router(mcp_catalog_router)
app.include_router(mcp_oauth_router)
app.include_router(productivity_router)
app.include_router(project_memory_router)
app.include_router(conversation_branching_router)
app.include_router(message_deletion_router)
app.include_router(notification_inbox_router)
app.include_router(voice_router)
app.include_router(agent_catalog_router)
from app.personalization import router as personalization_router, get_preset, personalize_prompt
app.include_router(personalization_router)
from app.artifacts import router as artifacts_router
from app.conversation_sharing import router as sharing_router
app.include_router(artifacts_router)
app.include_router(sharing_router)
from app.unified_search import router as unified_search_router
app.include_router(unified_search_router)
from app.artifact_comments import router as artifact_comments_router
from app.document_comparison import router as document_comparison_router
app.include_router(artifact_comments_router)
app.include_router(document_comparison_router)
from app.plugin_client import enabled as plugin_enabled
if plugin_enabled('people') and not os.getenv('BUDDY_PEOPLE_PLUGIN_URL', '').strip():
    from app.community import router as community_router
    app.include_router(community_router)
from app.notes import router as notes_router
app.include_router(notes_router)
from app.interactive_widgets import router as interactive_widgets_router
app.include_router(interactive_widgets_router)
from app.note_exports import router as note_exports_router
app.include_router(note_exports_router)
from app.email_review import router as email_review_router
app.include_router(email_review_router)
from app.privacy_policy import router as privacy_policy_router
app.include_router(privacy_policy_router)
from app.app_registry import router as app_registry_router
app.include_router(app_registry_router)
from app.docmost import router as docmost_router
app.include_router(docmost_router)
if plugin_enabled('office') and not os.getenv('BUDDY_OFFICE_PLUGIN_URL', '').strip():
    from app.office_app_actions import router as office_app_actions_router
    from app.office import router as office_router
    from app.office_proxy import router as office_proxy_router
    from app.office_ai import router as office_ai_router
    from app.office_assistant import router as office_assistant_router
    for router in (office_router, office_ai_router, office_assistant_router, office_proxy_router, office_app_actions_router):
        app.include_router(router)
if plugin_enabled('decisions'):
    if not os.getenv('BUDDY_DECISIONS_PLUGIN_URL', '').strip():
        from app.decisions_buddy.main import router as decisions_router
        app.include_router(decisions_router)
    decisions_static = Path(__file__).parent / 'static' / 'decisions'
    if decisions_static.is_dir():
        app.mount('/decisions', StaticFiles(directory=decisions_static, html=True), name='decisions')

@app.get('/api/plugins')
async def plugin_capabilities(user: dict = Depends(current_user)):
    from app.plugin_client import capabilities
    return capabilities()

bridge = BobACPBridge()
workspace_locks: dict[str, asyncio.Lock] = {}
STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIST_DIR = STATIC_DIR / "dist"
app.mount("/assets", frontend_assets(STATIC_DIST_DIR / "assets"), name="assets")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class AskRequest(BaseModel):
    prompt: str = Field(min_length=1)


class StreamRequest(BaseModel):
    idempotency_key: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
    correlation_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
    user_message_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
    assistant_message_id: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
    template_studio: bool = False
    voice_mode: bool = False
    client_timezone: str = Field(default="UTC", min_length=1, max_length=80)
    ui_language: str = Field(default="en", pattern=r"^(en|el|hi|mt)$")
    assistant_name: str | None = Field(default=None, pattern=r"^[\p{L}\p{N}][\p{L}\p{N} '\-]{0,48}$")
    office_file_ids: list[uuid.UUID] = Field(default_factory=list, max_length=3)
    note_ids: list[int] = Field(default_factory=list, max_length=5)
    edit_artifact_path: str | None = Field(default=None, min_length=1, max_length=500)
    approval_policy: ApprovalPolicy = Field(default_factory=ApprovalPolicy)
    preset_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    prompt: str = Field(min_length=1, max_length=20000)
    display_prompt: str | None = Field(default=None, max_length=20000)
    session_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    skill_name: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9-]{0,63}$")
    skill_names: list[Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")]] = Field(default_factory=list, max_length=6)
    mode: str = Field(default="agent", pattern=r"^[a-z][a-z0-9-]{0,63}$")
    agent_name: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9-]{0,63}$")
    agent_slugs: list[str] = Field(default_factory=list, max_length=12)
    agent_context_id: str | None = Field(default=None, max_length=200)
    workspace_id: str = Field(default="legacy", pattern=r"^(legacy|[a-f0-9]{32})$")
    template_id: str | None = Field(default=None, pattern=r"^[a-z0-9-]+$")
    html_artifact_path: str | None = Field(default=None, pattern=r"^dashboard-[a-f0-9]{32}\.html$")
    slide_count: int | None = Field(default=None, ge=1, le=50, strict=True)
    presentation_format: str | None = Field(default=None, pattern=r"^(pptx|html)$")

    @field_validator('agent_slugs')
    @classmethod
    def valid_agent_slugs(cls, value):
        from app.agent_attachments import validate_slugs
        return validate_slugs(value)

    @field_validator('client_timezone')
    @classmethod
    def valid_timezone(cls, value):
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError('Unknown client timezone') from None
        return value


class AuthRequest(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class SkillCreateRequest(BaseModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    description: str = Field(min_length=5, max_length=400)
    instructions: str = Field(min_length=1, max_length=10000)


class SkillUpdateRequest(BaseModel):
    description: str = Field(max_length=400)
    instructions: str = Field(min_length=1, max_length=10000)


class ModeCreateRequest(BaseModel):
    slug: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=400)
    role_definition: str = Field(min_length=1, max_length=5000)
    instructions: str = Field(default="", max_length=10000)
    groups: list[str] = Field(default_factory=lambda: ["read", "skill", "mode"])


class MCPCreateRequest(BaseModel):
    disabled: bool | None = None
    name: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    transport: str = Field(pattern=r"^(http|sse|stdio)$")
    url: str = ""
    command: str = ""
    args: list[str] = Field(default_factory=list, max_length=30)
    parameters: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    api_key: str = ""
    api_key_name: str = ""
    api_key_prefix: str = ""
    knowledge_base: str | None = Field(default=None, pattern="^company$")
    audience: str | None = Field(default=None, pattern="^(both|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")


class AgentCreateRequest(BaseModel):
    slug: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    card_url: str
    endpoint_override: str = ""
    api_key: str = ""
    api_key_header: str = ""
    auth_token: str = Field(default='', max_length=8000, repr=False)


class AgentUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    endpoint: str | None = None
    card_url: str | None = None
    api_key: str | None = None
    api_key_header: str | None = None
    auth_token: str | None = Field(default=None, max_length=8000, repr=False)


def _workspace_page(path: str, root: Path) -> Path:
    candidate = (root / path).resolve()
    if not candidate.is_file():
        global_root = Path(os.getenv("BOB_WORKSPACE", "/workspace")).resolve()
        global_cand = (global_root / path).resolve()
        if global_cand.is_file() and global_cand.is_relative_to(global_root):
            candidate = global_cand
    if candidate.suffix.lower() not in {".html", ".htm"}:
        raise HTTPException(status_code=400, detail="Invalid page path")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Page not found")
    return candidate


def _public_base_url() -> str:
    return os.getenv("PUBLIC_BASE_URL", "http://localhost:8080").rstrip("/")


def _agent_card() -> dict[str, Any]:
    base = _public_base_url()
    return {
        "protocolVersion": "0.3.0",
        "name": brand_text("Buddy"),
        "description": (
            brand_text("Buddy Shell running through ACP with project-local Buddy skills, "
            "exposed through a small A2A JSON-RPC adapter.")
        ),
        "url": f"{base}/a2a",
        "preferredTransport": "JSONRPC",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
        },
        "securitySchemes": {
            "apiKey": {
                "type": "apiKey",
                "name": "x-api-key",
                "in": "header",
            }
        },
        "defaultInputModes": ["text"],
        "defaultOutputModes": ["text"],
        "skills": [
            {
                "id": "code-review-buddy",
                "name": "Code Review Lite",
                "description": (
                    "Reviews a small code snippet using a concise structured checklist."
                ),
                "tags": ["code", "review", "test"],
                "examples": [
                    "Review this Python: def divide(a,b): return a/b"
                ],
                "inputModes": ["text"],
                "outputModes": ["text"],
            },
        ],
    }


def _extract_a2a_text(body: dict[str, Any]) -> str:
    params = body.get("params") or {}
    message = params.get("message") if isinstance(params, dict) else None
    if isinstance(message, dict):
        parts = message.get("parts")
        if isinstance(parts, list):
            chunks: list[str] = []
            for part in parts:
                if not isinstance(part, dict):
                    continue
                # A2A v0.3
                if part.get("kind") == "text" and isinstance(part.get("text"), str):
                    chunks.append(part["text"])
                # Be liberal enough to also accept the v1-style unified Part shape.
                elif isinstance(part.get("text"), str):
                    chunks.append(part["text"])
            prompt = "\n".join(x for x in chunks if x.strip()).strip()
            if prompt:
                return prompt
        if isinstance(message.get("text"), str) and message["text"].strip():
            return message["text"].strip()
    if isinstance(params.get("prompt"), str) and params["prompt"].strip():
        return params["prompt"].strip()
    if isinstance(params.get("text"), str) and params["text"].strip():
        return params["text"].strip()
    raise ValueError("No text content found in params.message.parts or params.prompt")


@app.get("/")
@app.get('/app/{workspace_path:path}')
@app.get('/notes')
@app.get('/notes/')
@app.get('/notes/{note_path}')
@app.get('/projects/view/{portfolio_project_id}')
@app.get('/projects/tabs/{portfolio_tab}')
@app.get('/office')
@app.get('/office/')
@app.get('/office/files/{office_file_id}')
@app.get('/office/new/{office_kind}')
async def root(workspace_path: str = "", portfolio_project_id: str = "", portfolio_tab: str = "", note_path: str = "", office_kind: str = "", office_file_id: str = "") -> FileResponse:
    if (STATIC_DIST_DIR / "index.html").exists():
        return FileResponse(STATIC_DIST_DIR / "index.html", headers={"Cache-Control": "no-store"})
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


@app.get('/learning')
@app.get('/learning/')
@app.get('/learning/{learning_path:path}')
async def learning_page(user: dict = Depends(current_user)):
    if not plugin_enabled('learning'):
        raise HTTPException(404, 'Learning plugin is disabled')
    return FileResponse(STATIC_DIST_DIR / 'learning.html', headers={'Cache-Control': 'no-store'})


@app.get("/register")
async def register_page() -> FileResponse:
    if (STATIC_DIST_DIR / "index.html").exists():
        return FileResponse(STATIC_DIST_DIR / "index.html", headers={"Cache-Control": "no-store"})
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/favicon.svg")
async def favicon_svg() -> FileResponse:
    if (STATIC_DIST_DIR / "favicon.svg").exists():
        return FileResponse(STATIC_DIST_DIR / "favicon.svg")
    return FileResponse(STATIC_DIR / "favicon.svg")


@app.get("/auth/status")
async def auth_status(request: Request) -> dict[str, Any]:
    user = None
    try:
        user = await current_user(request)
    except HTTPException:
        pass
    local_enabled = local_login_enabled()
    return {
        "setup_required": local_enabled and not has_users(),
        "user": user,
        "keycloak_configured": keycloak_configured(),
        "local_login_enabled": local_enabled,
    }


@app.post("/auth/setup")
async def auth_setup(req: AuthRequest, request: Request, response: Response) -> dict:
    if not local_login_enabled():
        raise HTTPException(403, "Use Keycloak to sign in")
    try:
        user = create_user(req.username, req.password, admin=True, setup=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    target = user_root(user["username"], create=True)
    legacy_page = Path(os.getenv("BOB_WORKSPACE", "/workspace")) / "index.html"
    if legacy_page.is_file():
        storage.put_file(user["username"], "session:legacy", "index.html", legacy_page.read_bytes())
    start_session(response, user, request)
    return user


@app.post("/auth/login")
async def auth_login(req: AuthRequest, request: Request, response: Response) -> dict:
    if not local_login_enabled():
        raise HTTPException(403, "Use Keycloak to sign in")
    try:
        await run_in_threadpool(reserve_login_attempt, req.username, request.client.host if request.client else 'unknown')
    except LoginThrottled as exc:
        raise HTTPException(429, str(exc), headers={'Retry-After': str(exc.retry_after)}) from None
    user = await run_in_threadpool(authenticate, req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    await run_in_threadpool(clear_account_attempts, req.username)
    start_session(response, user, request)
    return user


@app.post("/auth/register", status_code=201)
async def auth_register(req: AuthRequest, request: Request, response: Response) -> dict:
    if keycloak_configured():
        raise HTTPException(403, "Manage company users in Keycloak")
    if not local_login_enabled():
        raise HTTPException(403, "Use Keycloak to sign in")
    if not has_users():
        raise HTTPException(status_code=409, detail="Create the first admin account first")
    try:
        user = create_user(req.username, req.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    user_root(user["username"], create=True)
    start_session(response, user, request)
    return user


@app.post("/auth/logout")
async def auth_logout(request: Request, response: Response) -> dict[str, bool]:
    end_session(request, response)
    return {"ok": True}


@app.get("/auth/appearance")
def auth_appearance(user: dict = Depends(current_user)) -> dict[str, Any]:
    return {"appearance": read_appearance(user["username"])}


@app.put("/auth/appearance")
def auth_save_appearance(appearance: Appearance, user: dict = Depends(current_user)) -> dict[str, Any]:
    return {"appearance": write_appearance(user["username"], appearance)}


@app.get("/auth/users")
async def auth_users(user: dict = Depends(current_user)) -> list[dict]:
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    return list_users()


@app.post("/auth/users", status_code=201)
async def auth_add_user(req: AuthRequest, user: dict = Depends(current_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    try:
        created = create_user(req.username, req.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    user_root(created["username"], create=True)
    return created


@app.get("/sessions")
async def sessions(project_id: str | None = None, user: dict = Depends(current_user)) -> list[dict]:
    states, all_sessions = await asyncio.gather(
        run_in_threadpool(job_queue.deletion_states, user["username"]),
        run_in_threadpool(list_sessions, user["username"], project_id),
    )
    records = [item for item in all_sessions
               if states.get(item["id"], {}).get("status") != "deleted"]
    known = {item["id"] for item in records}
    for item in records:
        if states.get(item["id"], {}).get("status") == "deleting":
            item["deletion_pending"] = True
    for session_id, state in states.items():
        if state["status"] == "deleting" and state.get("project_id") == project_id and session_id not in known:
            records.append({"id": session_id, "title": "Deletion pending", "updated": "",
                            "project_id": project_id, "deletion_pending": True})
    return records


@app.post("/sessions", status_code=201)
async def add_session(project_id: str | None = None, user: dict = Depends(current_user)) -> dict:
    return create_session(user["username"], project_id)


@app.delete("/sessions/{session_id}")
async def remove_session(session_id: str, user: dict = Depends(current_user)) -> dict:
    try:
        result = await run_in_threadpool(delete_conversation, user["username"], session_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Conversation not found") from exc
    except ValueError as exc:
        detail = str(exc)
        raise HTTPException(status_code=409 if "active" in detail.lower() else 400, detail=detail) from exc
    except Exception as exc:
        logger.exception("Conversation deletion failed for %s/%s", user["username"], session_id)
        raise HTTPException(status_code=503, detail="Deletion is incomplete. Retry later; the conversation is hidden from the list.") from exc
    return {"deleted": True, **result}


class ProjectImport(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(default='', max_length=2000)
    branch: str = Field(default='', max_length=200)
    token: str = Field(default='', max_length=1000)


class ProjectFileEdit(BaseModel):
    path: str = Field(min_length=1, max_length=100)
    content: str = Field(max_length=1024*1024)
    original: str = Field(max_length=1024*1024)


@app.get('/projects')
@app.get('/projects/')
async def projects(request: Request, user: dict = Depends(current_user)):
    # Browser navigation opens the portfolio; existing JSON clients retain their API.
    if 'text/html' in request.headers.get('accept', '').lower():
        response = await root()
        response.headers['Vary'] = 'Accept'
        return response
    rows = await run_in_threadpool(project_store.list_projects, user['username'])
    return JSONResponse(rows, headers={'Vary': 'Accept'})


@app.post('/projects', status_code=201)
async def import_project(req: ProjectImport, user: dict = Depends(current_user)):
    return await run_in_threadpool(project_store.create_project, user['username'], req.name, 'git' if req.url else 'empty', url=req.url, branch=req.branch, token=req.token)


@app.post('/projects/upload', status_code=201)
async def upload_project(request: Request, name: str, user: dict = Depends(current_user)):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > project_store.MAX_ZIP: raise HTTPException(413, 'ZIP exceeds 50 MB')
    return await run_in_threadpool(project_store.create_project, user['username'], name, 'zip', data=bytes(data))


@app.get('/projects/{project_id}/files')
async def project_files(project_id: str, user: dict = Depends(current_user)):
    return await run_in_threadpool(project_store.stored_files, user['username'], project_id)


@app.get('/projects/{project_id}/file')
async def project_file(project_id: str, path: str, user: dict = Depends(current_user)):
    return await run_in_threadpool(project_store.stored_read_file, user['username'], project_id, path)


@app.put('/projects/{project_id}/file')
async def save_project_file(project_id: str, req: ProjectFileEdit, user: dict = Depends(current_user)):
    if len(req.content.encode('utf-8')) > 1024*1024: raise HTTPException(413, 'Text files are limited to 1 MB')
    return await run_in_threadpool(project_store.stored_edit_file, user['username'],project_id,req.path,req.content,req.original)


@app.delete('/projects/{project_id}/file', status_code=204)
async def delete_project_file(project_id: str, path: str, user: dict = Depends(current_user)):
    project_store.project_root(user['username'],project_id)
    await _delete_stored_file(user['username'],'project:'+project_id,path)
    return Response(status_code=204)


@app.delete('/projects/{project_id}')
async def delete_project(project_id: str, user: dict = Depends(current_user)):
    from app.conversation_delete import delete_project as remove_project
    try:
        result = await run_in_threadpool(remove_project,user['username'],project_id)
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from exc
    return {'deleted':True,**result}


@app.get('/projects/{project_id}/changes')
async def project_changes(project_id: str, user: dict = Depends(current_user)):
    return await run_in_threadpool(project_store.stored_changes, user['username'],project_id)


class ProjectPublish(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    branch: str = Field(default='main', min_length=1, max_length=200)
    token: str = Field(min_length=1, max_length=1000)


@app.post('/projects/{project_id}/publish')
async def publish_project(project_id: str, req: ProjectPublish, user: dict = Depends(current_user)):
    return await run_in_threadpool(project_store.stored_publish, user['username'], project_id,
                                  req.url, req.branch, req.token)


@app.get('/projects/{project_id}/download')
async def download_project(project_id: str, user: dict = Depends(current_user)):
    data = await run_in_threadpool(project_store.stored_download, user['username'],project_id)
    return Response(data, media_type='application/zip', headers={'Content-Disposition':'attachment; filename="project.zip"'})


@app.get("/sessions/{session_id}/history")
async def session_history(session_id: str, user: dict = Depends(current_user)) -> list[dict]:
    try:
        return await run_in_threadpool(read_history, session_id, user["username"])
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail="Conversation not found") from exc



@app.get("/knowledge")
@app.get("/sessions/{session_id}/knowledge")
async def knowledge_documents(session_id: str = 'shared', user: dict = Depends(current_user)):
    return await run_in_threadpool(rag.list_documents, user["username"], session_id, admin=user["is_admin"])


@app.post("/knowledge", status_code=201)
@app.post("/sessions/{session_id}/knowledge", status_code=201)
async def upload_knowledge(session_id: str = 'shared', file: UploadFile = File(...), description: str = Form(default='', max_length=2000), knowledge_base: str = Form(default='company'), audience: str = Form(default='both'), user: dict = Depends(current_user)):
    if not user["is_admin"]: raise HTTPException(403, "Only administrators can upload knowledge documents")
    content = await file.read(rag.MAX_BYTES + 1)
    try:
        return await run_in_threadpool(rag.add_document, user["username"], session_id,
                                      file.filename or "document.txt", content, description, knowledge_base=knowledge_base, audience=audience, admin=user["is_admin"])
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class KnowledgeMetadata(BaseModel):
    description: str | None = Field(default=None, max_length=2000)
    knowledge_base: str | None = None
    audience: str | None = None


class KnowledgeFreshness(BaseModel):
    owner: str = Field(default='', max_length=200)
    review_due: str | None = None
    reviewed: bool = False


@app.patch('/knowledge/{document_id}/freshness')
async def edit_knowledge_freshness(document_id: uuid.UUID, req: KnowledgeFreshness, user: dict = Depends(current_user)):
    try:
        result = await run_in_threadpool(rag.update_freshness, user['username'], 'shared', str(document_id), req.owner, req.review_due, reviewed=req.reviewed, admin=user['is_admin'])
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not result:
        raise HTTPException(404, 'Document not found')
    return result


@app.patch('/knowledge/{document_id}')
async def edit_knowledge(document_id: uuid.UUID, req: KnowledgeMetadata, user: dict = Depends(current_user)):
    try:
        if req.knowledge_base is not None or req.audience is not None:
            if req.knowledge_base is None or req.audience is None:
                raise HTTPException(422, 'Specify both knowledge base and policy audience')
            result = await run_in_threadpool(rag.update_classification, user['username'], 'shared', str(document_id), req.knowledge_base, req.audience, admin=user['is_admin'], description=req.description)
            if not result: raise HTTPException(404, 'Document not found')
        elif req.description is not None:
            result = await run_in_threadpool(rag.update_description, user['username'], 'shared', str(document_id), req.description, admin=user['is_admin'])
        elif req.knowledge_base is None:
            raise HTTPException(422, 'Specify document metadata')
    except PermissionError as exc: raise HTTPException(403, str(exc)) from exc
    except ValueError as exc: raise HTTPException(422, str(exc)) from exc
    if not result: raise HTTPException(404, 'Document not found')
    return result


@app.put('/knowledge/{document_id}', status_code=202)
async def replace_knowledge(document_id: uuid.UUID, file: UploadFile = File(...), description: str | None = Form(default=None, max_length=2000), user: dict = Depends(current_user)):
    content = await file.read(rag.MAX_BYTES + 1)
    try:
        result = await run_in_threadpool(rag.replace_document, user['username'], 'shared', str(document_id), file.filename or 'document.txt', content, description, admin=user['is_admin'])
    except PermissionError as exc: raise HTTPException(403, str(exc)) from exc
    except ValueError as exc: raise HTTPException(422, str(exc)) from exc
    if not result: raise HTTPException(404, 'Document not found')
    return result


@app.delete("/knowledge/{document_id}", status_code=204)
@app.delete("/sessions/{session_id}/knowledge/{document_id}", status_code=204)
async def remove_knowledge(document_id: uuid.UUID, session_id: str = 'shared', user: dict = Depends(current_user)):
    try:
        removed = await run_in_threadpool(rag.remove_document, user["username"], session_id, str(document_id), admin=user["is_admin"])
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail="Document not found")
    return Response(status_code=204)


@app.post("/knowledge/{document_id}/retry", status_code=202)
@app.post("/sessions/{session_id}/knowledge/{document_id}/retry", status_code=202)
async def retry_knowledge(document_id: uuid.UUID, session_id: str = 'shared', user: dict = Depends(current_user)):
    try:
        retried = await run_in_threadpool(rag.retry_document, user["username"], session_id, str(document_id), admin=user["is_admin"])
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not retried:
        raise HTTPException(status_code=409, detail="Document not found or already being indexed")
    return {"status": "queued"}


@app.get("/knowledge/{document_id}/file")
@app.get("/sessions/{session_id}/knowledge/{document_id}/file")
async def download_knowledge(document_id: uuid.UUID, session_id: str = 'shared', user: dict = Depends(current_user)):
    document = await run_in_threadpool(rag.get_document, user["username"], session_id, str(document_id), admin=user["is_admin"])
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    return Response(bytes(document["content"]), media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(document['filename'], safe='')}",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })


@app.get("/knowledge/{document_id}/preview")
@app.get("/sessions/{session_id}/knowledge/{document_id}/preview")
async def preview_knowledge(document_id: uuid.UUID, session_id: str = 'shared', citation: uuid.UUID | None = None,
                            quote: str | None = Query(default=None, max_length=600),
                            user: dict = Depends(current_user)):
    try:
        preview = await run_in_threadpool(rag.citation_preview, user["username"], session_id,
                                         str(document_id), str(citation) if citation else None, quote)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not preview:
        raise HTTPException(status_code=404, detail="This source passage is no longer available")
    return Response(json.dumps(preview), media_type="application/json", headers={"Cache-Control": "no-store"})


@app.get("/knowledge/{document_id}/prepared")
@app.get("/sessions/{session_id}/knowledge/{document_id}/prepared")
async def prepared_knowledge(document_id: uuid.UUID, session_id: str = 'shared', user: dict = Depends(current_user)):
    document = await run_in_threadpool(rag.get_document, user["username"], session_id, str(document_id), admin=user["is_admin"])
    if not document or document["status"] != "ready":
        raise HTTPException(status_code=404, detail="Prepared document is not available yet")
    return Response(document["prepared_text"], media_type="text/plain", headers={"Cache-Control": "no-store"})


class KnowledgeSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    knowledge_base: str | None = Field(default=None, pattern="^company$")


@app.post('/knowledge/search')
async def search_knowledge(req: KnowledgeSearchRequest, user: dict = Depends(current_user)):
    try:
        passages=await rag.retrieve(user['username'],'shared',req.query,knowledge_base=req.knowledge_base)
    except (ValueError,httpx.HTTPError) as exc:
        raise HTTPException(503,'Knowledge search is unavailable. Check the embedding service and source statuses.') from exc
    return [{key:str(row[key]) if key=='id' else row[key] for key in ('id','filename','location','text','score','citation_id')} for row in passages]


def _file_scope(username: str, session_id: str) -> str:
    try:
        return storage_scope(session_id,username)
    except (ValueError,FileNotFoundError) as exc:
        raise HTTPException(404,'Conversation not found') from exc


async def _stored_file(username,scope,path):
    try:
        row = await run_in_threadpool(storage.get_file,username,scope,path)
    except ValueError as exc:
        raise HTTPException(400,'Invalid file path') from exc
    if not row: raise HTTPException(404,'File not found')
    return row


async def _save_stored_file(username,session_id,path,content):
    scope=_file_scope(username,session_id)
    try:
        storage.validate_path(path)
        await run_in_threadpool(storage.put_file,username,scope,path,content,session_id=session_id)
    except ValueError as exc:
        raise HTTPException(409 if 'active' in str(exc) or 'deleted' in str(exc) else 400,str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404,str(exc)) from exc


async def _delete_stored_file(username,scope,path,session_id=None):
    try:
        storage.validate_path(path)
        if Path(path).suffix.lower() in {'.html', '.htm', '.bobdeck', '.pptx'}:
            removed=await run_in_threadpool(delete_presentation,username,scope,path,session_id)
        else:
            removed=await run_in_threadpool(storage.delete_file,username,scope,path,session_id=session_id)
    except ValueError as exc:
        raise HTTPException(409 if 'active' in str(exc) or 'deleted' in str(exc) else 400,str(exc)) from exc
    if not removed: raise HTTPException(404,'File not found')
    from app import conversation_documents
    if conversation_documents.supported(path):
        await run_in_threadpool(conversation_documents.remove, username, scope, path, session_id)



@app.post('/sessions/{session_id}/upload',status_code=201)
async def upload_session_file(session_id: str,file: UploadFile=File(...),user: dict=Depends(current_user)):
    filename=Path((file.filename or 'uploaded_file').replace('\\','/')).name
    if not filename or filename.startswith('.'):
        filename='file_'+filename.lstrip('.') if filename.lstrip('.') else 'uploaded_file'
    from app import conversation_documents
    suffix = Path(filename).suffix.lower()
    if suffix == '.doc':
        raise HTTPException(422, 'Legacy Word .doc files are not supported. Save as .docx and attach that copy.')
    is_document = conversation_documents.supported(filename)
    limit = conversation_documents.MAX_BYTES if is_document else 50 * 1024 * 1024
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise HTTPException(413, 'Documents are limited to 25 MB' if is_document else 'File exceeds 50 MB limit')
    if is_document and not content:
        raise HTTPException(422, 'The document is empty. Attach a file with readable content.')
    await _save_stored_file(user['username'], session_id, filename, content)
    document = None
    if is_document:
        try:
            document = await run_in_threadpool(conversation_documents.enqueue, user['username'], _file_scope(user['username'], session_id), filename, session_id)
        except (ValueError, FileNotFoundError) as exc:
            document = {'path': filename, 'status': 'failed', 'prepared_path': None, 'error': str(exc)}
    is_sheet=Path(filename).suffix.lower() in {'.csv','.tsv','.xlsx','.xlsm','.xltx'}
    summary=None
    if is_sheet:
        def summarize():
            with tempfile.TemporaryDirectory(prefix='bob-sheet-') as directory:
                # The fixed filename works with openpyxl; the original format
                # selects a parser separately and never affects the path.
                path=Path(directory)/'upload.xlsx'
                path.write_bytes(content)
                result = summarize_spreadsheet(path, file_extension=suffix)
                result['filename'] = filename
                return result
        try: summary=await run_in_threadpool(summarize)
        except Exception as exc: summary={'error':f'Failed to parse spreadsheet: {exc}'}
    return {'session_id':session_id,'filename':filename,'path':filename,'size':len(content),'is_spreadsheet':is_sheet,'summary':summary,'document':document,'is_document':is_document}


@app.get('/sessions/{session_id}/documents/preview')
async def conversation_document_preview(session_id: str, path: str, user: dict = Depends(current_user)):
    from app import conversation_documents
    scope = _file_scope(user['username'], session_id)
    try:
        if not conversation_documents.supported(path):
            raise HTTPException(422, 'Select a PDF, DOCX, Markdown or text document')
        preview = await run_in_threadpool(conversation_documents.get_preview, user['username'], scope, path)
        if preview['status'] == 'unprepared':
            await run_in_threadpool(conversation_documents.enqueue, user['username'], scope, path, session_id)
            preview = await run_in_threadpool(conversation_documents.get_preview, user['username'], scope, path)
        return preview
    except FileNotFoundError as exc:
        raise HTTPException(404, 'Document not found') from exc
    except ValueError as exc:
        raise HTTPException(409 if 'active' in str(exc) else 400 if 'path' in str(exc).lower() else 422, str(exc)) from exc


@app.post('/sessions/{session_id}/documents/prepare')
async def prepare_conversation_document(session_id: str, path: str, user: dict = Depends(current_user)):
    from app import conversation_documents
    scope = _file_scope(user['username'], session_id)
    try:
        return await run_in_threadpool(conversation_documents.enqueue, user['username'], scope, path, session_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, 'Document not found') from exc
    except ValueError as exc:
        raise HTTPException(409 if 'active' in str(exc) else 400 if 'path' in str(exc).lower() else 422, str(exc)) from exc


@app.get('/sessions/{session_id}/files')
async def session_files(session_id: str,user: dict=Depends(current_user)):
    scope=_file_scope(user['username'],session_id)
    rows=await run_in_threadpool(storage.list_files,user['username'],scope)
    return sorted([{'name':r['path'],'size':r['size'],'modified':r['modified'],
                    'is_document':Path(r['path']).suffix.lower() in {'.pdf','.docx','.md','.txt'},
                    'is_spreadsheet':Path(r['path']).suffix.lower() in {'.csv','.tsv','.xlsx','.xlsm','.xltx'}}
                   for r in rows if not r['path'].startswith('document-text/')],key=lambda r:r['modified'],reverse=True)


class SessionFileSaveRequest(BaseModel):
    path: str=Field(min_length=1,max_length=1000)
    content: str=Field(max_length=10*1024*1024)


@app.get('/sessions/{session_id}/file')
async def get_session_file(session_id: str,path: str,user: dict=Depends(current_user)):
    row=await _stored_file(user['username'],_file_scope(user['username'],session_id),path)
    media_type = mimetypes.guess_type(path)[0] or 'application/octet-stream'
    return Response(row['content'], media_type=media_type, headers=file_headers(path, media_type))


@app.put('/sessions/{session_id}/file')
async def save_session_file(session_id: str,req: SessionFileSaveRequest,user: dict=Depends(current_user)):
    await _save_stored_file(user['username'],session_id,req.path,req.content.encode('utf-8'))
    return {'ok':True,'path':req.path}


@app.delete('/sessions/{session_id}/file',status_code=204)
async def delete_session_file(session_id: str,path: str,user: dict=Depends(current_user)):
    await _delete_stored_file(user['username'],_file_scope(user['username'],session_id),path,session_id)
    return Response(status_code=204)


@app.get('/workspace/pages')
async def workspace_pages(session_id: str='legacy',user: dict=Depends(current_user)):
    rows=await run_in_threadpool(storage.list_files,user['username'],_file_scope(user['username'],session_id))
    pages=[{'name':Path(r['path']).name,**r} for r in rows
           if Path(r['path']).suffix.lower() in {'.html','.htm','.pptx','.bobdeck','.ppt'}]
    for page in pages:
        item = await run_in_threadpool(storage.get_file,user['username'],_file_scope(user['username'],session_id),page['path']) if Path(page['path']).suffix.lower() in {'.html','.htm'} else None
        page.update(artifact_role(page['path'], bytes(item['content']) if item else ''))
    return sorted(pages,key=lambda r:r['modified'],reverse=True)


@app.get('/workspace/page')
async def workspace_page(path: str,session_id: str='legacy',user: dict=Depends(current_user)):
    if Path(path).suffix.lower() not in {'.html','.htm'}: raise HTTPException(400,'Invalid page path')
    row=await _stored_file(user['username'],_file_scope(user['username'],session_id),path)
    if len(row['content'])>2_000_000: raise HTTPException(413,'Page is too large to preview')
    return {'path':path,'html':row['content'].decode('utf-8',errors='replace')}


@app.put('/workspace/page')
async def save_workspace_page(req: SessionFileSaveRequest,session_id: str='legacy',user: dict=Depends(current_user)):
    await _save_stored_file(user['username'],session_id,req.path,req.content.encode('utf-8'))
    return {'ok':True,'path':req.path}


@app.get('/workspace/{path:path}')
async def standalone_workspace_file(path: str, session_id: str='legacy', user: dict=Depends(current_user)):
    return await get_session_file(session_id,path,user)


@app.get("/skills")
async def skills(user: dict = Depends(current_user)) -> list[dict[str, str]]:
    return await run_in_threadpool(list_skills)


@app.post("/skills", status_code=201)
async def add_skill(req: SkillCreateRequest, user: dict = Depends(current_user)) -> dict[str, str]:
    try:
        return await run_in_threadpool(create_skill, req.name, req.description, req.instructions)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"Skill '{req.name}' already exists") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/skills/{name}")
async def skill_details(name: str, user: dict = Depends(current_user)) -> dict[str, str]:
    try:
        return await run_in_threadpool(get_skill, name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Skill not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.put("/skills/{name}")
async def edit_skill(name: str, req: SkillUpdateRequest, user: dict = Depends(current_user)) -> dict[str, str]:
    try:
        return await run_in_threadpool(update_skill, name, req.description, req.instructions)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Skill not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/skills/{name}")
async def remove_skill(name: str, user: dict = Depends(current_user)):
    from app.postgres_storage import SkillDeletionBusy
    try:
        await run_in_threadpool(delete_skill, name)
    except SkillDeletionBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Skill not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True}


@app.get("/modes")
async def modes(user: dict = Depends(current_user)) -> list[dict[str, str]]:
    return await run_in_threadpool(list_modes)


@app.post("/modes", status_code=201)
async def add_mode(req: ModeCreateRequest, user: dict = Depends(current_user)) -> dict[str, str]:
    if not set(req.groups).issubset(ALLOWED_GROUPS):
        raise HTTPException(status_code=422, detail="Unsupported tool group")
    try:
        return await run_in_threadpool(
            create_mode,
            req.slug, req.name, req.description, req.role_definition,
            req.instructions, req.groups,
        )
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/mcps")
async def mcps(user: dict = Depends(current_user)) -> list[dict[str, Any]]:
    return await run_in_threadpool(list_mcps, admin=user["is_admin"])


@app.post("/mcps/check")
async def test_mcp_draft(req: MCPCreateRequest, user: dict = Depends(current_user)) -> dict:
    if not user["is_admin"]: raise HTTPException(403, "Only administrators can configure MCP connections")
    from app.workspace_config import build_mcp_config, _root
    from app.mcp_health import probe_mcp
    try:
        if req.transport != "stdio":
            validate_mcp_url(req.url)
        elif not req.command.strip():
            raise ValueError("Enter a command for the stdio server")
        config = build_mcp_config(req.transport, req.url.strip(), req.command.strip(), req.args,
                                  req.parameters, req.headers, req.env, req.api_key,
                                  req.api_key_name.strip(), req.api_key_prefix)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await probe_mcp(config, cwd=str(_root()))


@app.post("/mcps", status_code=201)
async def add_mcp(req: MCPCreateRequest, user: dict = Depends(current_user)) -> dict[str, Any]:
    if not user["is_admin"]: raise HTTPException(403, "Only administrators can configure MCP connections")
    try:
        if req.transport != "stdio":
            validate_mcp_url(req.url)
        elif not req.command.strip():
            raise ValueError("Enter a command for the stdio server")
        api_key_name = req.api_key_name.strip()
        if req.api_key and not api_key_name:
            api_key_name = "API_KEY" if req.transport == "stdio" else "Authorization"
        return await run_in_threadpool(
            create_mcp,
            req.name, req.transport, req.url.strip(), req.command.strip(), req.args,
            req.parameters, req.headers, req.env, req.api_key,
            api_key_name, req.api_key_prefix, knowledge_base=req.knowledge_base or "company", audience=req.audience or "both", disabled=bool(req.disabled),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc


@app.get("/mcps/{name}/config")
async def mcp_configuration(name: str, user: dict = Depends(current_user)) -> dict:
    if not user["is_admin"]: raise HTTPException(403, "Only administrators can configure MCP connections")
    from app.workspace_config import migrate_mcp_registry
    from app.mcp_access import admin_config
    await run_in_threadpool(migrate_mcp_registry)
    try:
        config = await run_in_threadpool(admin_config, user["username"], name)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    if config is None:
        raise HTTPException(status_code=404, detail="MCP connection not found")
    return config


@app.put("/mcps/{name}")
async def configure_mcp(name: str, req: MCPCreateRequest, user: dict = Depends(current_user)) -> dict:
    if not user["is_admin"]: raise HTTPException(403, "Only administrators can configure MCP connections")
    from app.workspace_config import update_mcp
    if req.name != name:
        raise HTTPException(status_code=422, detail="Connection names cannot be changed")
    try:
        if req.transport != "stdio":
            validate_mcp_url(req.url)
        values = req.model_dump(exclude={"name"}, exclude_none=True)
        return await run_in_threadpool(update_mcp, name, **values)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="MCP connection not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/mcps/{name}/check")
async def check_mcp_connection(name: str, user: dict = Depends(current_user)) -> dict:
    from app.workspace_config import migrate_mcp_registry, _root
    from app.mcp_access import get_authorized_server, get_managed_server
    from app.mcp_health import probe_mcp
    await run_in_threadpool(migrate_mcp_registry)
    if user["is_admin"]:
        entry = await run_in_threadpool(get_managed_server, user["username"], name)
        config = entry["config"] if entry else None
    else:
        config = await run_in_threadpool(get_authorized_server, user["username"], name)
    if config is None:
        raise HTTPException(status_code=404, detail="MCP connection not found")
    return await probe_mcp(config, cwd=str(_root()), server_name=name)


@app.delete("/mcps/{name}", status_code=204)
async def remove_mcp(name: str, user: dict = Depends(current_user)) -> None:
    if not user["is_admin"]: raise HTTPException(403, "Only administrators can configure MCP connections")
    try:
        removed = await run_in_threadpool(delete_mcp, name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail=f"MCP server '{name}' not found")


class MCPAccessRequest(BaseModel):
    knowledge_base: str = Field(pattern="^company$")
    audience: str = Field(pattern="^(both|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")


@app.patch('/mcps/{name}/access')
async def classify_mcp(name: str, req: MCPAccessRequest, user: dict = Depends(current_user)):
    if not user['is_admin']: raise HTTPException(403, 'Only administrators can assign MCP access')
    from app.mcp_access import set_access
    from app.workspace_config import migrate_mcp_registry
    await run_in_threadpool(migrate_mcp_registry)
    try:
        return await run_in_threadpool(set_access, user['username'], name, req.knowledge_base, req.audience)
    except KeyError as exc: raise HTTPException(404, 'MCP connection not found') from exc
    except PermissionError as exc: raise HTTPException(403, str(exc)) from exc
    except ValueError as exc: raise HTTPException(422, str(exc)) from exc


@app.get("/agents")
async def agents(user: dict = Depends(current_user)) -> list[dict[str, Any]]:
    return await run_in_threadpool(list_agents)


@app.post("/agents", status_code=201)
async def add_agent(req: AgentCreateRequest, user: dict = Depends(current_user)) -> dict[str, Any]:
    try:
        details = await discover_agent(req.card_url, req.endpoint_override, bearer_token=req.auth_token,
                                       api_key=req.api_key, api_key_header=req.api_key_header or 'x-api-key')
        if req.auth_token.strip() or req.api_key.strip():
            from app.safe_http import origin
            if origin(details['endpoint']) != origin(req.card_url):
                raise ValueError('The authenticated Agent Card advertises a different endpoint origin. Add it without a token, then configure credentials for that endpoint.')
            if req.auth_token.strip():
                details['auth_token'] = req.auth_token.strip()
        if req.api_key:
            details["api_key"] = req.api_key
        if req.api_key_header:
            details["api_key_header"] = req.api_key_header
        return await run_in_threadpool(create_agent, req.slug, details)
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.put("/agents/{slug}")
async def modify_agent(slug: str, req: AgentUpdateRequest, user: dict = Depends(current_user)) -> dict[str, Any]:
    try:
        updates = {k: v for k, v in req.model_dump().items() if v is not None}
        if "endpoint" in updates and updates["endpoint"]:
            validate_url(updates["endpoint"])
        return await run_in_threadpool(update_agent, slug, updates)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/agents/{slug}", status_code=204)
async def remove_agent(slug: str, user: dict = Depends(current_user)) -> None:
    try:
        await run_in_threadpool(delete_agent, slug)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class PresentationIntentRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100000)
    mode: str | None = None
    skill_name: str | None = None


@app.post('/presentation/intent')
async def resolve_presentation_intent(req: PresentationIntentRequest, user: dict = Depends(current_user)):
    intent = await run_in_threadpool(presentation_intent, req.prompt, req.mode, req.skill_name, user["username"])
    from app.html_artifact_policy import is_html_artifact_request
    intent['html_artifact'] = not intent['presentation'] and is_html_artifact_request(req.prompt)
    intent['html_artifact_path'] = f"dashboard-{uuid.uuid4().hex}.html" if intent['html_artifact'] else None
    return intent


@app.get("/presentation/templates")
async def presentation_templates(user: dict = Depends(current_user)) -> list[dict]:
    return await run_in_threadpool(list_presentation_templates, user["username"])


@app.post("/presentation/templates", status_code=201)
async def save_presentation_template(req: PresentationTemplateCreate, user: dict = Depends(current_user)) -> dict:
    return await run_in_threadpool(create_presentation_template, user["username"], req)


@app.get("/presentation/template-drafts")
async def presentation_template_drafts(session_id: str = Query(pattern=r"^(legacy|[a-f0-9]{32})$"), user: dict = Depends(current_user)) -> list[dict]:
    scope = _file_scope(user["username"], session_id)
    rows = await run_in_threadpool(storage.list_files, user["username"], scope)
    drafts = []
    for row in [row for row in rows if row["path"].endswith(".presentation-template.json")][-20:]:
        if row.get("size", 0) > 32768:
            continue
        saved = await run_in_threadpool(storage.get_file, user["username"], scope, row["path"])
        try:
            if not saved or len(saved["content"]) > 32768:
                continue
            config = PresentationTemplateCreate.model_validate_json(saved["content"])
        except (ValueError, TypeError):
            continue
        drafts.append({"path": row["path"], "config": config.model_dump()})
    return drafts


@app.get("/presentation/templates/{template_id}")
async def presentation_template(template_id: str, user: dict = Depends(current_user)) -> dict:
    return await run_in_threadpool(get_presentation_template, template_id, user["username"])


@app.get('/presentation/decks')
async def presentation_decks(session_id: str='legacy',user: dict=Depends(current_user)):
    scope=_file_scope(user['username'],session_id)
    rows=await run_in_threadpool(storage.list_files,user['username'],scope)
    decks=[]
    for row in rows:
        if not row['path'].endswith('.bobdeck'): continue
        try:
            data=json.loads((await _stored_file(user['username'],scope,row['path']))['content'])
            decks.append({'path':row['path'],'title':data.get('title',Path(row['path']).stem),
                          'slidesCount':len(data.get('slides',[])),'modified':row['modified']})
        except (ValueError,HTTPException): continue
    return sorted(decks,key=lambda r:r['modified'],reverse=True)


@app.get('/presentation/deck')
async def presentation_deck(path: str='presentation.bobdeck',session_id: str='legacy',user: dict=Depends(current_user)):
    row=await _stored_file(user['username'],_file_scope(user['username'],session_id),path)
    try: return json.loads(row['content'])
    except ValueError as exc: raise HTTPException(422,'Invalid presentation deck') from exc


class HookPayload(BaseModel):
    id: str | None = None
    name: str
    description: str = ""
    event: str = "PreToolUse"
    matcher: str = ".*"
    command: str = ""
    script_code: str = ""
    timeout: int = 5000
    enabled: bool = True
    is_blocking: bool = True


class HookTogglePayload(BaseModel):
    enabled: bool


class HookTestPayload(BaseModel):
    command: str = ""
    script_code: str = ""
    event: str = "PreToolUse"
    payload: dict[str, Any] = Field(default_factory=dict)


@app.get("/hooks")
@app.get("/api/hooks")
async def get_hooks(user: dict = Depends(administrator)):
    return {
        "hooks": list_hooks(),
        "templates": BUILTIN_HOOK_TEMPLATES,
    }


@app.post("/hooks", status_code=201)
@app.post("/api/hooks", status_code=201)
async def create_or_update_hook(req: HookPayload, user: dict = Depends(administrator)):
    try:
        saved = save_hook(req.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    record_hook_audit(user, 'save-hook', saved.get('id', ''))
    return saved


@app.delete("/hooks/{hook_id}", status_code=204)
@app.delete("/api/hooks/{hook_id}", status_code=204)
async def remove_hook(hook_id: str, user: dict = Depends(administrator)):
    try:
        found = delete_hook(hook_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if found:
        record_hook_audit(user, 'delete-hook', hook_id)
    if not found:
        raise HTTPException(status_code=404, detail="Hook not found")


@app.post("/hooks/{hook_id}/toggle")
@app.post("/api/hooks/{hook_id}/toggle")
async def toggle_hook_status(hook_id: str, req: HookTogglePayload, user: dict = Depends(administrator)):
    try:
        found = toggle_hook(hook_id, req.enabled)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if found:
        record_hook_audit(user, 'toggle-hook', hook_id)
    if not found:
        raise HTTPException(status_code=404, detail="Hook not found")
    return {"ok": True, "id": hook_id, "enabled": req.enabled}


@app.post("/hooks/test")
@app.post("/api/hooks/test")
async def test_hook_execution(req: HookTestPayload, user: dict = Depends(administrator)):
    # Executing arbitrary scripts inside the API process is not an execution sandbox.
    raise HTTPException(403, 'Hook command testing is disabled. Validate trusted hooks in an isolated administrative environment.')


@app.get('/api/office/chat-capabilities')
def office_chat_capabilities(user: dict = Depends(current_user)):
    return {'version': 1, 'max_files': 3, 'read_only_snapshots': True, 'import_conversation': True}


@app.post("/chat/stream")
async def chat_stream(req: StreamRequest, request: Request, user: dict = Depends(current_user)) -> StreamingResponse:
    if req.agent_slugs:
        if req.agent_name or req.voice_mode or req.template_studio or req.edit_artifact_path:
            raise HTTPException(422, brand_text('A2A attachments require a Buddy chat without voice, template studio, or artifact editing.'))
        from app.agent_attachments import selected_agents
        try:
            await run_in_threadpool(selected_agents, user['username'], req.agent_slugs)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
    if req.voice_mode and (req.agent_name or req.edit_artifact_path or req.template_studio or req.skill_name or req.skill_names):
        raise HTTPException(422, brand_text('Voice discussion uses Buddy without a presentation, artifact editor, or explicit skill.'))
    from app.chat_correlation import request_ids, turn_metadata, correlate_stream
    try:
        correlation = request_ids(req.model_dump(), request.headers.get('x-correlation-id'))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        workspace = workspace_for(req.workspace_id, user["username"])
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail="Conversation not found") from exc
    from app.chat_submission import fingerprint
    idempotency_key = req.idempotency_key or request.headers.get('idempotency-key') or correlation['correlation_id']
    if req.idempotency_key and request.headers.get('idempotency-key') and req.idempotency_key != request.headers['idempotency-key']:
        raise HTTPException(422, 'Idempotency header and body keys must match')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', idempotency_key):
        raise HTTPException(422, 'Invalid idempotency key')
    request_hash = fingerprint(req.model_dump(mode="json"))
    try:
        existing = await run_in_threadpool(job_queue.find_submission, user['username'], req.workspace_id, idempotency_key, request_hash)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if existing:
        return _chat_submission_response(existing, existing.payload, req.workspace_id, reused=True)
    quiz_grading_context = ''
    if req.prompt.startswith('Quiz submission:'):
        from app.quiz import submission_context
        history = await run_in_threadpool(read_history, req.workspace_id, user['username'])
        try:
            quiz_grading_context = submission_context(req.prompt, history)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        req.mode = 'agent'
        req.agent_name = None
        req.skill_name = None
        req.skill_names = []
        req.preset_id = None
        req.edit_artifact_path = None
        req.template_studio = False
        req.html_artifact_path = None
    if req.edit_artifact_path:
        try:
            storage.validate_path(req.edit_artifact_path)
        except ValueError as exc:
            raise HTTPException(422, 'Invalid artifact path') from exc
        if Path(req.edit_artifact_path).suffix.lower() not in {'.html', '.htm', '.bobdeck', '.md', '.txt', '.jsx', '.tsx', '.mmd', '.mermaid', '.css', '.js', '.ts', '.json', '.svg'}:
            raise HTTPException(422, 'Select an editable artifact or presentation')
        if not storage.get_file(user['username'], storage_scope(req.workspace_id, user['username']), req.edit_artifact_path):
            raise HTTPException(404, 'Artifact not found')
        req.mode = 'agent'
        req.agent_name = None
        req.skill_name = None
        req.skill_names = []
        req.preset_id = None
    if req.template_studio:
        req.preset_id = None
        req.agent_name = None
        req.skill_name = None
        req.skill_names = []
        req.mode = "agent"
    preset = get_preset(user["username"], req.preset_id) if req.preset_id else None
    if req.preset_id and not preset:
        raise HTTPException(404, "Preset not found")
    if preset:
        if req.agent_name:
            raise HTTPException(422, brand_text("Assistant presets currently apply to Buddy"))
        req.mode = preset['mode']
        req.skill_name = preset.get('skill_name') if not req.skill_names else req.skill_name
        if preset.get('web_search'):
            from app.workspace_config import ensure_brave_mcp
            from app.mcp_access import get_authorized_server
            await run_in_threadpool(ensure_brave_mcp)
            if not await run_in_threadpool(get_authorized_server, user['username'], 'brave_search'):
                raise HTTPException(403, 'Your groups do not have access to the web search connection')
            if not os.getenv('BRAVE_API_KEY', '').strip():
                raise HTTPException(422, "This preset requires configured web search")
            req.prompt = '/research-buddy ' + req.prompt
    from app.workspace_config import resolve_skill_name
    requested_skills = list(dict.fromkeys(([req.skill_name] if req.skill_name else []) + req.skill_names))
    if len(requested_skills) > 6:
        raise HTTPException(status_code=422, detail="Select up to 6 skills")
    if requested_skills:
        available_skills = {skill["name"] for skill in list_skills()}
        req.skill_names = list(dict.fromkeys(resolve_skill_name(name) for name in requested_skills))
        if req.agent_name:
            raise HTTPException(status_code=422, detail=brand_text("Skills can be called only with Buddy"))
        if any(name not in available_skills for name in req.skill_names):
            raise HTTPException(status_code=404, detail="Skill not found")
        req.skill_name = req.skill_names[0]
    if req.mode == "chat":
        req.mode = "agent"
    if not req.agent_name and req.mode not in {mode["slug"] for mode in list_modes()}:
        raise HTTPException(status_code=404, detail="Mode not found")
    agent = get_agent(req.agent_name) if req.agent_name else None
    if req.agent_name and not agent:
        raise HTTPException(status_code=404, detail="A2A agent not found")

    from app.html_artifact_policy import is_html_artifact_request
    if req.voice_mode:
        req.mode = 'agent'
        req.template_studio = False
        req.skill_name = None
        req.skill_names = []
        req.html_artifact_path = None
    # If the workspace belongs to a research report, follow-ups must edit the report directly instead of creating HTML artifacts
    is_research_session = False
    with job_queue._connect() as db:
        conv_row = db.execute("SELECT record FROM bob_conversations WHERE username=%s AND id=%s", (user['username'], req.workspace_id)).fetchone()
        if conv_row and isinstance(conv_row.get('record'), dict) and conv_row['record'].get('research'):
            is_research_session = True
    if not is_research_session and storage.get_file(user['username'], storage_scope(req.workspace_id, user['username']), 'research-report.md'):
        is_research_session = True

    html_requested = not is_research_session and not req.voice_mode and not quiz_grading_context and not req.edit_artifact_path and not req.template_studio and not req.agent_name and is_html_artifact_request(req.prompt)
    if html_requested:
        req.mode = 'agent'
    intent = {'presentation': False} if quiz_grading_context or req.voice_mode else presentation_intent(req.prompt, req.mode, "presentation-buddy" if "presentation-buddy" in req.skill_names else req.skill_name, user["username"])
    if req.edit_artifact_path:
        req.mode = 'agent'
    elif intent['presentation'] and not req.template_studio:
        req.mode = 'presentation'
        req.slide_count = req.slide_count or intent['slide_count']
        req.presentation_format = req.presentation_format or intent['format']
        if req.agent_name or not req.template_id or req.slide_count is None or not req.presentation_format:
            raise HTTPException(status_code=422, detail={
                'code': 'presentation_setup_required',
                'message': 'Choose a template, format and slide count in Presentation Studio before generating.',
                **intent,
            })
        get_presentation_template(req.template_id, user["username"])
    html_artifact_output_path = req.html_artifact_path or f"dashboard-{uuid.uuid4().hex}.html" if html_requested else None
    if html_artifact_output_path and storage.get_file(user['username'], storage_scope(req.workspace_id, user['username']), html_artifact_output_path):
        # A simultaneous retry may have passed the first lookup before the
        # original request committed and its worker wrote the scaffold.
        try:
            existing = await run_in_threadpool(job_queue.find_submission, user['username'], req.workspace_id, idempotency_key, request_hash)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if existing:
            return _chat_submission_response(existing, existing.payload, req.workspace_id, reused=True)
        raise HTTPException(409, 'Dashboard filename already exists. Submit the request again to create a new artifact.')
    presentation_output_path = None
    html_edit_request = False
    if req.edit_artifact_path:
        html_edit_request = True
        bob_prompt = build_html_edit_guidance(req.prompt, req.edit_artifact_path)
        display_prompt = f"Edit {req.edit_artifact_path}: {req.prompt}"
    elif req.template_studio:
        schema = PresentationTemplateCreate.model_json_schema()
        draft_filename = f"studio-{uuid.uuid4().hex}.presentation-template.json"
        bob_prompt = ("Create a reusable presentation design template from the user's request below. "
                      f"Save one JSON object to {draft_filename} in the current workspace, "
                      "matching this schema exactly: " + json.dumps(schema) + "\n"
                      "Use six digit #RRGGBB colors, real font family names, supported shapes and decorations. "
                      "Choose tasteful defaults for unspecified design settings. This is a reusable design "
                      "for both PowerPoint and HTML. Do not generate slides or invent factual content. "
                      "When finished, name the saved file and tell the user to reopen Presentation Studio "
                      "to review and save this draft to their reusable template catalog.\nUser request: " + req.prompt)
        display_prompt = "Create presentation template: " + req.prompt
    elif req.mode == "presentation":
        presentation_output_path = f"presentation-{uuid.uuid4().hex}.{'html' if req.presentation_format == 'html' else 'bobdeck'}"
        if req.presentation_format == "html":
            bob_prompt = build_html_presentation_prompt(req.prompt, existing=False, template_id=req.template_id, username=user["username"], slide_count=req.slide_count, output_path=presentation_output_path)
            display_prompt = f"📊 Interactive HTML presentation [{req.template_id or 'default'}]: {req.prompt}"
        else:
            template_id = req.template_id
            bob_prompt = build_presentation_prompt(template_id, req.prompt, username=user["username"], slide_count=req.slide_count, output_path=presentation_output_path)
            display_prompt = f"📊 Presentation [{template_id}]: {req.prompt}"
        if any(name != "presentation-buddy" for name in req.skill_names):
            bob_prompt = " ".join(f"${name}" for name in req.skill_names if name != "presentation-buddy") + " " + bob_prompt
    elif req.skill_name:
        bob_prompt = " ".join(f"${name}" for name in req.skill_names) + " " + req.prompt
        display_prompt = req.display_prompt or " ".join(f"/{name}" for name in req.skill_names) + " " + req.prompt
    else:
        bob_prompt = req.prompt
        display_prompt = req.display_prompt or req.prompt

    if req.session_id == req.workspace_id or not req.session_id:
        target_session_id = next(
            (evt.get("session_id") for evt in reversed(read_history(req.workspace_id, user["username"]))
             if evt.get("type") == "done" and evt.get("session_id")), None,
        )
    else:
        target_session_id = req.session_id

    if html_edit_request:
        # The saved HTML is the editing baseline. Resuming a large earlier Bob
        # task makes even a small file change slow and consumes context.
        target_session_id = None

    if preset and preset.get('instructions'):
        bob_prompt = "[Saved assistant instructions]:\n" + preset['instructions'] + "\n\n" + bob_prompt

    if req.voice_mode:
        from app.voice_policy import discussion_prompt
        bob_prompt = discussion_prompt(bob_prompt)

    note_references = []
    if req.note_ids:
        if req.agent_name or req.voice_mode:
            raise HTTPException(422, brand_text('Note references require the built-in Buddy text chat'))
        if any(note_id < 1 or note_id > 9223372036854775807 for note_id in req.note_ids):
            raise HTTPException(422, 'Invalid note ID')
        from app.note_integration import chat_context as load_note_context
        note_context, note_references = await run_in_threadpool(load_note_context, user['username'], req.note_ids)
        bob_prompt += note_context

    office_references = []
    if req.office_file_ids:
        if req.agent_name or req.voice_mode:
            raise HTTPException(422, brand_text('Office references require the built-in Buddy text chat'))
        from app.plugin_client import office_context as load_office_context
        office_context, office_references = await load_office_context(request, user['username'], req.office_file_ids)
        bob_prompt += office_context

    # Execute UserPromptSubmit lifecycle hooks
    hook_allowed, hook_context, hook_error = await execute_event_hooks(
        "UserPromptSubmit",
        {"prompt": bob_prompt, "workspace_id": req.workspace_id, "user": user["username"]},
        match_target=req.prompt,
    )
    if not hook_allowed:
        async def blocked_stream():
            error_payload = {
                **turn_metadata(correlation, req.workspace_id),
                "type": "error",
                "message": f"Action blocked by policy hook: {hook_error or 'Forbidden prompt'}",
            }
            yield f"data: {json.dumps(error_payload)}\n\n"
        return StreamingResponse(blocked_stream(), media_type="text/event-stream",
                                 headers={'X-Correlation-Id': correlation['correlation_id'], 'X-Chat-Id': req.workspace_id,
                                          'X-User-Message-Id': correlation['user_message_id'],
                                          'X-Assistant-Message-Id': correlation['assistant_message_id']})

    if hook_context:
        bob_prompt = f"{bob_prompt}\n\n[Context from lifecycle hook]:\n{hook_context}"

    target_agent_context_id = req.agent_context_id
    if not target_agent_context_id and req.agent_name:
        target_agent_context_id = next(
            (evt.get("agent_context_id") for evt in reversed(read_history(req.workspace_id, user["username"]))
             if evt.get("type") == "done" and evt.get("agent_context_id")), None,
        )

    # Allow the operator to force auto-approve for all jobs via environment variable.
    effective_approval_policy = req.approval_policy
    if os.getenv('BOB_FORCE_AUTO_APPROVE') == '1':
        effective_approval_policy = ApprovalPolicy(mode='auto', actions=[])
    if effective_approval_policy.mode == 'selected' and req.agent_name:
        raise HTTPException(422, brand_text('Selected approvals require the built-in Buddy agent; remote agents cannot enforce this policy'))
    if quiz_grading_context:
        display_prompt = '📝 Submitted test answers'
    payload = {
        **correlation,
        'idempotency_key': idempotency_key,
        "quiz_grading_context": quiz_grading_context,
        "office_references": office_references,
        "note_references": note_references,
        "ui_language": req.ui_language, "assistant_name": req.assistant_name,
        "edit_artifact_path": req.edit_artifact_path,
        "presentation_output_path": presentation_output_path,
        "html_artifact_output_path": html_artifact_output_path,
        "presentation_format": req.presentation_format if req.mode == "presentation" else None,
        "prompt": req.prompt, "bob_prompt": bob_prompt, "mode": req.mode, "voice_mode": req.voice_mode, "client_timezone": req.client_timezone,
        "approval_policy": effective_approval_policy.model_dump(),
        "approval_runtime": "acp" if not req.agent_name else None,
        "approval_policy_revision": 0,
        "session_id": target_session_id, "agent_name": req.agent_name, "agent_slugs": req.agent_slugs,
        "agent_context_id": target_agent_context_id, "skill_name": req.skill_name, "skill_names": req.skill_names, "template_id": req.template_id,
    }
    request_event = {
        'message_id': correlation['user_message_id'],
        "office_references": office_references,
        "note_references": note_references,
        "edit_artifact_path": req.edit_artifact_path,
        "presentation_output_path": presentation_output_path,
        "html_artifact_output_path": html_artifact_output_path,
        "type": "request", "prompt": req.prompt, "display_prompt": display_prompt, "voice_mode": req.voice_mode,
        "ui_language": req.ui_language, "assistant_name": req.assistant_name,
        "agent_name": req.agent_name, "agent_slugs": req.agent_slugs, "mode": req.mode, "skill_name": req.skill_name, "skill_names": req.skill_names,
        "approval_policy": req.approval_policy.model_dump(),
        "template_id": req.template_id if req.mode == "presentation" else None,
        "presentation_format": req.presentation_format if req.mode == "presentation" else None,
        "slide_count": req.slide_count if req.mode == "presentation" else None,
    }
    try:
        job_id = await run_in_threadpool(
            job_queue.enqueue, user["username"], req.workspace_id, workspace_key(req.workspace_id,user["username"]), payload,
            idempotency_key=idempotency_key, request_hash=request_hash, request_event=request_event,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    reused = getattr(job_id, 'reused', False)
    payload = getattr(job_id, 'payload', payload)
    if not reused:
        touch_session(req.workspace_id, user["username"], req.prompt)
    return _chat_submission_response(job_id, payload, req.workspace_id, reused=reused)


def _chat_submission_response(job_id, payload, workspace_id, *, reused=False):
    from app.chat_correlation import correlate_stream, turn_metadata
    correlation = {key: payload[key] for key in ('correlation_id', 'user_message_id', 'assistant_message_id')}
    return StreamingResponse(
        correlate_stream(_stream_job_events(str(job_id)), turn_metadata(payload, workspace_id, job_id)),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Bob-Job-Id": job_id,
                 'X-Correlation-Id': correlation['correlation_id'], 'X-Chat-Id': workspace_id,
                 'X-Idempotency-Replayed': str(reused).lower(),
                 'Idempotency-Key': payload.get('idempotency_key', correlation['correlation_id']),
                 'X-User-Message-Id': correlation['user_message_id'],
                 'X-Assistant-Message-Id': correlation['assistant_message_id']},
    )


async def _stream_job_events(job_id: str, after_id: int = 0):
    clean_id = str(job_id).replace("-", "")
    channel = f"bob_job_{clean_id}"

    # Connect to PostgreSQL to listen on the dedicated in-memory channel
    connection = await psycopg.AsyncConnection.connect(os.environ["DATABASE_URL"], autocommit=True)
    try:
        await connection.execute(f"LISTEN {channel}")

        # Flush transport headers immediately; this is not a generated model token.
        yield json.dumps({"type": "start"}, ensure_ascii=False) + "\n"

        # Check and replay any events recorded before or during LISTEN registration
        cursor = await connection.execute(
            "SELECT id,event FROM bob_job_events WHERE job_id=%s ORDER BY id", (str(job_id),)
        )
        early_events = await cursor.fetchall()
        seen_terminal = False
        for row in early_events:
            evt = {**row[1], 'event_id': row[0]}
            if evt.get("type") in {"done", "error"}:
                seen_terminal = True
            yield json.dumps(evt, ensure_ascii=False) + "\n"

        if seen_terminal:
            return

        cursor = await connection.execute("SELECT status FROM bob_jobs WHERE id=%s", (str(job_id),))
        job = await cursor.fetchone()
        if job and job[0] in {"completed", "failed"}:
            return

        # Stream live in-memory notifications directly to the UI
        async with aclosing(connection.notifies(timeout=None)) as notifications:
            notice_task = None
            try:
                while True:
                    if notice_task is None:
                        notice_task = asyncio.create_task(anext(notifications))
                    ready, _ = await asyncio.wait({notice_task}, timeout=2.0)
                    if not ready:
                        # Quick heartbeat check to keep connection alive and recover if a notice was quiet
                        j = await asyncio.to_thread(job_queue.get_job, str(job_id))
                        if j and j["status"] in {"completed", "failed"}:
                            notice_task.cancel()
                            with suppress(asyncio.CancelledError, StopAsyncIteration):
                                await notice_task
                            notice_task = None
                            cursor = await connection.execute(
                                "SELECT id,event FROM bob_job_events WHERE job_id=%s "
                                "AND event->>'type' IN ('delta','app_action','done','error') ORDER BY id",
                                (str(job_id),),
                            )
                            first_delta = True
                            for row in await cursor.fetchall():
                                event = {**row[1], 'event_id': row[0]}
                                if event.get("type") == "delta" and first_delta:
                                    event = {**event, "replace": True}
                                    first_delta = False
                                yield json.dumps(event, ensure_ascii=False) + "\n"
                            break
                        continue

                    try:
                        notice = await notice_task
                        notice_task = None
                    except (StopAsyncIteration, asyncio.CancelledError):
                        break

                    if notice.channel == channel:
                        yield notice.payload + "\n"
                        try:
                            evt = json.loads(notice.payload)
                            if evt.get("type") in {"done", "error"}:
                                break
                        except Exception:
                            pass
            finally:
                if notice_task is not None:
                    notice_task.cancel()
                    with suppress(asyncio.CancelledError, StopAsyncIteration):
                        await notice_task
    finally:
        await connection.close()


@app.get('/approvals/capabilities')
async def approval_capabilities(user: dict = Depends(current_user)):
    return {'available': True, 'runtime_updates': True, 'actions': ['commands', 'files', 'dependencies', 'messages', 'external', 'publish'], 'supported': ['local_chat', 'presentations', 'artifact_edits'], 'unsupported': ['remote_agents', 'research', 'workflows'], 'reason': None}


@app.get('/jobs/{job_id}/approval-policy')
async def get_job_approval_policy(job_id: uuid.UUID, user: dict = Depends(current_user)):
    state = await run_in_threadpool(job_queue.get_approval_policy, str(job_id), user['username'])
    if state is None:
        raise HTTPException(404, 'Job not found')
    return state


@app.put('/jobs/{job_id}/approval-policy')
async def put_job_approval_policy(job_id: uuid.UUID, req: ApprovalPolicy, user: dict = Depends(current_user)):
    try:
        state = await run_in_threadpool(job_queue.update_approval_policy, str(job_id), user['username'], req.model_dump())
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if state is None:
        raise HTTPException(404, 'Job not found')
    return state


class ApprovalDecisionRequest(BaseModel):
    decision: Literal['approve', 'approve_task', 'reject']


@app.post('/jobs/{job_id}/approvals/{approval_id}')
async def decide_job_approval(job_id: str, approval_id: str, req: ApprovalDecisionRequest, user=Depends(current_user)):
    try:
        uuid.UUID(job_id)
        uuid.UUID(approval_id)
    except ValueError:
        raise HTTPException(404, 'Approval not found')
    try:
        event = await run_in_threadpool(job_queue.decide_approval, job_id, user['username'], approval_id, req.decision)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if event is None:
        raise HTTPException(404, 'Approval not found')
    return event


class ChatGuidanceRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=4000)


@app.post("/jobs/{job_id}/guidance", status_code=202)
async def guide_chat(job_id: uuid.UUID, req: ChatGuidanceRequest, user: dict = Depends(current_user)):
    from app.chat_guidance import submit
    try:
        result = await run_in_threadpool(submit, str(job_id), user["username"], req.instruction)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return result


@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: uuid.UUID, user: dict = Depends(current_user)):
    job = await run_in_threadpool(job_queue.request_cancel, str(job_id), user["username"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("cancel_event"):
        await run_in_threadpool(append_history, job["workspace_id"], user["username"], job["cancel_event"])
    for _ in range(40):
        job = await run_in_threadpool(job_queue.get_job, str(job_id), user["username"])
        if job["status"] not in {"queued", "running"}:
            return {"status": "stopped" if job["payload"].get("cancel_requested") else job["status"]}
        await asyncio.sleep(0.25)
    return Response(json.dumps({"status": "stopping"}), status_code=202, media_type="application/json")


async def _replay_job_events(job_id: str, after_id: int = 0):
    """Replay committed events with a stable cursor, then follow new commits."""
    connection = await job_queue.stream_reader()
    try:
        cursor_id = max(0, after_id)
        while True:
            rows, status = await job_queue.read_stream_events(connection, job_id, cursor_id)
            for row in rows:
                cursor_id = row["id"]
                yield json.dumps({**row["event"], "event_id": cursor_id}, ensure_ascii=False) + "\n"
            # A full page may still have more persisted events, including the terminal event.
            if len(rows) >= 200:
                continue
            if status not in {"queued", "running"}:
                return
            await asyncio.sleep(0.5)
    finally:
        await connection.close()


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: uuid.UUID, after_id: int = 0, user: dict = Depends(current_user)):
    job = await run_in_threadpool(job_queue.get_job, str(job_id), user["username"])
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    from app.chat_correlation import correlate_stream, turn_metadata
    metadata = turn_metadata(job.get('payload', {}), job.get('workspace_id'), job_id)
    return StreamingResponse(correlate_stream(_replay_job_events(str(job_id), max(0, after_id)), metadata),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.websocket('/jobs/{job_id}/artifacts/ws')
async def artifact_socket(socket: WebSocket, job_id: uuid.UUID, after_id: int = 0):
    # Browser cookies authenticate the upgrade; enforce the same origin and
    # job ownership as HTTP replay before accepting the connection.
    from urllib.parse import urlsplit
    origin = socket.headers.get('origin')
    if origin and urlsplit(origin).netloc != socket.headers.get('host'):
        await socket.close(code=1008)
        return
    try:
        user = await current_user(socket)
        job = await run_in_threadpool(job_queue.get_job, str(job_id), user['username'])
    except HTTPException:
        await socket.close(code=1008)
        return
    if not job:
        await socket.close(code=1008)
        return
    await socket.accept()
    connection = await job_queue.stream_reader()
    tasks = []
    try:
        await connection.execute('LISTEN bob_job_events')

        async def send_updates():
            from app.live_artifacts import artifact_events
            from app.chat_correlation import turn_metadata
            metadata = turn_metadata(job.get('payload', {}), job.get('workspace_id'), job_id)
            async for event in artifact_events(connection, str(job_id), job_queue.read_stream_events, after_id):
                await socket.send_json({**event, **metadata})

        async def receive_disconnect():
            while True:
                await socket.receive_text()

        tasks = [asyncio.create_task(send_updates()), asyncio.create_task(receive_disconnect())]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await connection.close()
        with suppress(WebSocketDisconnect, RuntimeError):
            await socket.close()


@app.get('/ready')
async def readiness():
    try:
        from app.auth import _connect
        with _connect() as db: db.execute('SELECT 1')
        return {'ok': True}
    except Exception:
        raise HTTPException(503, 'Database unavailable')


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "bob_key_present": await run_in_threadpool(provider_configured),
        "workspace": os.getenv("BOB_WORKSPACE", "/workspace"),
    }


@app.get("/.well-known/agent-card.json")
async def agent_card() -> dict[str, Any]:
    return _agent_card()


# Older A2A tooling used this path. Keeping it costs nothing and makes testing easier.
@app.get("/.well-known/agent.json")
async def legacy_agent_card() -> dict[str, Any]:
    return _agent_card()


@app.post("/ask")
async def ask(req: AskRequest, user: dict = Depends(current_user)) -> dict[str, Any]:
    try:
        with storage.direct_workspace(user['username']) as (root,workspace):
            personal_prompt = await run_in_threadpool(personalize_prompt, req.prompt, user["username"])
            result = await bridge.ask(knowledge_policy(personal_prompt), workspace=str(workspace), user_home=str(root / ".home"), username=user["username"])
        return {
            "response": result["text"],
            "session_id": result["session_id"],
            "debug": {
                "prompt_response": result["prompt_response"],
                "event_count": len(result["events"]),
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/a2a")
async def a2a(body: dict[str, Any], request: Request) -> dict[str, Any]:
    request_id = body.get("id")
    if body.get("jsonrpc") != "2.0":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32600, "message": "Invalid JSON-RPC request"},
        }

    try:
        user = await current_user(request)
    except HTTPException:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32000,
                "message": "Authentication required. Sign in or provide a valid application session token.",
            },
        }

    # A2A v0.3 canonical JSON-RPC spelling is message/send (or message.send).
    # A2A v1.0 spelling is SendMessage.
    if body.get("method") not in {"message/send", "message.send", "SendMessage"}:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": "Method not found"},
        }

    try:
        prompt = _extract_a2a_text(body)
        with storage.direct_workspace(user['username']) as (root,workspace):
            personal_prompt = await run_in_threadpool(personalize_prompt, prompt, user["username"])
            result = await bridge.ask(knowledge_policy(personal_prompt), workspace=str(workspace), user_home=str(root / ".home"), username=user["username"])
    except ValueError as exc:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32602, "message": str(exc)},
        }
    except Exception as exc:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32000,
                "message": brand_text("Buddy ACP request failed"),
                "data": {"detail": str(exc)},
            },
        }

    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "kind": "message",
            "role": "agent",
            "messageId": uuid.uuid4().hex,
            "parts": [
                {
                    "kind": "text",
                    "text": result["text"],
                }
            ],
            "metadata": {
                "bobAcpSessionId": result["session_id"],
            },
        },
    }
