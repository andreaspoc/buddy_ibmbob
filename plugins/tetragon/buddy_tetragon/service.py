"""Administrator-only Docker plugin controlling a host Tetragon daemon."""
from app.branding import brand_text
from contextlib import asynccontextmanager
from pathlib import Path
import mimetypes
from typing import Literal
import uuid

from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app.admin_users import administrator
from app.browser_security import BrowserSecurityMiddleware
from .engine import Engine, EngineError, compile_policy, policy_name, render_policy
from .store import Store


class RuleInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80)
    kind: Literal['file', 'exec']
    paths: list[str] = Field(min_length=1, max_length=32)
    binaries: list[str] = Field(min_length=1, max_length=32)


class Revision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: int = Field(ge=1, strict=True)


def create_app(*, store=None, engine=None):
    store = store or Store()
    engine = engine or Engine()

    @asynccontextmanager
    async def lifespan(app):
        store.initialize()
        yield

    app = FastAPI(title=brand_text('Buddy Tetragon'), version='1.0.0', lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BrowserSecurityMiddleware)

    def admin(response: Response, user=Depends(administrator)):
        response.headers['Cache-Control'] = 'private, no-store'
        return user

    def compile_input(body):
        rule = {'id': str(uuid.uuid4()), **body.model_dump()}
        rule['name'] = rule['name'].strip()
        if not rule['name']:
            raise HTTPException(422, 'Enter a rule name')
        try:
            compile_policy(rule)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return rule

    def find(identity, revision):
        rule = store.get(identity)
        if not rule:
            raise HTTPException(404, 'Rule not found')
        if rule['revision'] != revision:
            raise HTTPException(409, 'Rule changed. Refresh and review it before trying again.')
        return rule

    @app.get('/health')
    def health():
        return {'ok': True}

    @app.get('/ready')
    def ready():
        # UI/configuration remain available when Tetragon is offline. The status
        # endpoint independently reports the real engine connection.
        try:
            store.snapshot()
        except Exception:
            raise HTTPException(503, 'Tetragon rule storage unavailable') from None
        return {'ok': True}

    @app.get('/plugins/manifest')
    def manifest():
        return {'id': 'tetragon', 'version': '1.0.0', 'runtime_api': 1,
                'api_prefix': '/api/tetragon', 'url': '/tetragon/'}

    @app.get('/api/tetragon/status')
    def status(user=Depends(admin)):
        return engine.status()

    @app.get('/api/tetragon/rules')
    def rules(user=Depends(admin)):
        return store.snapshot()

    @app.post('/api/tetragon/preview')
    def preview(body: RuleInput, user=Depends(admin)):
        rule = compile_input(body)
        return {'policy': compile_policy(rule), 'yaml': render_policy(rule)}

    @app.post('/api/tetragon/rules', status_code=201)
    def save(body: RuleInput, user=Depends(admin)):
        try:
            return store.create(compile_input(body), user['username'])
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @app.get('/api/tetragon/rules/{identity}/policy')
    def saved_policy(identity: uuid.UUID, user=Depends(admin)):
        rule = store.get(str(identity))
        if not rule:
            raise HTTPException(404, 'Rule not found')
        return {'policy': compile_policy(rule), 'yaml': render_policy(rule)}

    def mutate(identity, body, user, action):
        with store.locked():
            rule = find(identity, body.expected_revision)
            # Commit intent before touching the engine: a crash leaves evidence
            # and attempted=True, preventing unsafe deletion of an uncertain rule.
            store.intent(identity, user['username'], action)
            try:
                if action == 'apply':
                    engine.add(compile_policy(rule))
                else:
                    engine.remove(policy_name(identity))
            except (EngineError, ValueError) as exc:
                store.result(identity, user['username'], action, error=str(exc))
                raise HTTPException(503, str(exc)) from None
            store.result(identity, user['username'], action, enabled=action == 'apply')
            return store.get(identity)

    @app.post('/api/tetragon/rules/{identity}/apply')
    def apply(identity: uuid.UUID, body: Revision, user=Depends(admin)):
        return mutate(str(identity), body, user, 'apply')

    @app.post('/api/tetragon/rules/{identity}/remove')
    def remove(identity: uuid.UUID, body: Revision, user=Depends(admin)):
        return mutate(str(identity), body, user, 'remove')

    @app.delete('/api/tetragon/rules/{identity}', status_code=204)
    def delete(identity: uuid.UUID, expected_revision: int = Query(ge=1), user=Depends(admin)):
        identity = str(identity)
        with store.locked():
            rule = find(identity, expected_revision)
            if rule['enabled']:
                raise HTTPException(409, 'Remove this policy from Tetragon before deleting it')
            if rule['attempted']:
                live = engine.status()
                if not live['connected']:
                    raise HTTPException(503, 'Cannot confirm policy removal while Tetragon is disconnected')
                if any(p['name'] == policy_name(identity) for p in live['policies']):
                    raise HTTPException(409, 'Policy still exists in Tetragon. Remove it first.')
            store.delete(identity, user['username'])
        return Response(status_code=204)

    static = Path(__file__).parent / 'static'
    assets = {path.name: (path.read_bytes(), mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
              for path in static.iterdir() if path.is_file() and not path.is_symlink()}
    @app.get('/tetragon')
    @app.get('/tetragon/')
    def screen(user=Depends(admin)):
        return FileResponse(static / 'index.html', headers={'Cache-Control': 'private, no-store'})

    # Protect assets with the same administrator dependency as the app itself.
    @app.get('/tetragon/assets/{asset:path}')
    def asset(asset: str, user=Depends(admin)):
        candidate = assets.get(asset)
        if candidate is None:
            raise HTTPException(404, 'Asset not found')
        content, media_type = candidate
        return Response(content, media_type=media_type, headers={'Cache-Control': 'private, no-store'})

    return app
