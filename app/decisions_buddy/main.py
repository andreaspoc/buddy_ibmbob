"""Authenticated DecisionsBuddy API, durable models and version-bound governance."""
import os
import asyncio
import copy
from contextlib import asynccontextmanager
import hashlib
import json
import time
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.auth import current_user
from app.admin_users import administrator
from app.origin_policy import same_origin
from . import db
from .decision_engine import DecisionEngine, evaluate_unary, evaluate_expression
from .safe_expression import validate_graph
from .analysis import analyze_graph
from . import cp4d_governance as governance
from .cp4d_settings import (ConnectorSettings, GovernanceError, get_public_settings,
                            update_admin_settings, test_admin_connection)


class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        try:
            self.loop = asyncio.get_running_loop()
        except Exception:
            pass

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        # Notifications carry no model IDs, names, actors, defaults or graphs.
        # Every recipient refreshes through its own authorized HTTP endpoints.
        message = {'type': 'models_changed'}
        dead = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for d in dead:
            self.disconnect(d)


manager = ConnectionManager()


def broadcast_event(event: dict):
    if not manager.active_connections:
        return
    try:
        if manager.loop and manager.loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(event), manager.loop)
        else:
            loop = asyncio.get_running_loop()
            loop.create_task(manager.broadcast(event))
    except Exception:
        pass


def permitted(request: Request, response: Response, user=Depends(current_user)):
    response.headers['Cache-Control'] = 'no-store'
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        same_origin(request)
    return user


class DecisionsRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def protected(request):
            try:
                return await handler(request)
            except HTTPException:
                raise
            except GovernanceError as exc:
                raise HTTPException(409, str(exc)) from None
            except db.RevisionConflict:
                raise HTTPException(409, 'The saved record changed. Reload before trying again.') from None
            except PermissionError:
                raise HTTPException(403, 'This decision operation is not authorized') from None
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            except (TypeError, SyntaxError, RecursionError, OverflowError):
                raise HTTPException(422, 'Invalid or excessively complex decision data') from None
        return protected


router = APIRouter(prefix='/api/decisions', tags=['decisions'])
http_router = APIRouter(dependencies=[Depends(permitted)], route_class=DecisionsRoute)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class SaveDecisionRequest(StrictModel):
    id: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]*$')
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=10000)
    graph: dict[str, Any]
    defaultInput: dict[str, Any] = Field(default_factory=dict)
    changeSummary: str = Field(default='Rule update', max_length=2000)
    accessPolicy: Literal['authenticated', 'private'] = 'private'
    expectedVersion: int = Field(ge=0)


class GovernanceStatusRequest(StrictModel):
    status: Literal['draft', 'in_review', 'approved', 'published']
    environment: Literal['development', 'staging', 'production'] = 'development'
    expectedVersion: int = Field(ge=1)


class EvaluateRequest(StrictModel):
    decisionId: str | None = Field(default=None, max_length=100)
    graph: dict[str, Any] | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    mode: Literal['simulation', 'production'] = 'simulation'
    expectedVersion: int | None = Field(default=None, ge=1)

    @model_validator(mode='after')
    def one_source(self):
        if (self.graph is None) == (self.decisionId is None):
            raise ValueError('Provide either a saved decision ID or a draft graph')
        if self.mode == 'production' and (self.graph is not None or self.expectedVersion is None):
            raise ValueError('Production evaluation requires a saved decision and expectedVersion')
        return self


class BatchEvaluateRequest(StrictModel):
    decisionId: str | None = Field(default=None, max_length=100)
    graph: dict[str, Any] | None = None
    items: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    expectedVersion: int | None = Field(default=None, ge=1)


class TestCase(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    input: dict[str, Any] = Field(default_factory=dict)
    expected: Any


class TestSuiteRequest(StrictModel):
    expectedVersion: int = Field(ge=1, strict=True)
    expectedSuiteRevision: int = Field(ge=0, strict=True)
    cases: list[TestCase] = Field(min_length=1, max_length=100)


class RunTestsRequest(StrictModel):
    expectedVersion: int = Field(ge=1, strict=True)


class AnalyzeRequest(StrictModel):
    graph: dict[str, Any] | None = None
    decisionId: str | None = Field(default=None, max_length=100)


class MapTermRequest(StrictModel):
    field: str = Field(min_length=1, max_length=200)
    termId: str = Field(min_length=1, max_length=200)
    provider: Literal['ikc', 'wxdi'] = 'ikc'
    expectedVersion: int = Field(ge=1)


class SyncCP4DRequest(StrictModel):
    expectedVersion: int = Field(ge=1)


class ReconcileRequest(StrictModel):
    provider: Literal['ikc', 'wxdi']
    assetId: str = Field(min_length=1, max_length=200)
    expectedVersion: int = Field(ge=1)


def can_author(user):
    """Administrators, or members of the admin-managed flow authors group, may build flows."""
    if user.get('is_admin'):
        return True
    from app.app_groups import _connect
    group = os.getenv('BUDDY_DECISIONS_AUTHOR_GROUP', 'Decision authors')
    with _connect() as connection:
        return bool(connection.execute(
            'SELECT 1 FROM bob_app_group_members m JOIN bob_app_groups g ON g.id = m.group_id '
            'WHERE m.username = %s AND lower(g.name) = lower(%s)', (user.get('username'), group)).fetchone())


def flow_author(user=Depends(current_user)):
    if not can_author(user):
        raise HTTPException(403, 'Ask an administrator for access to create decision flows')
    return user


def _ad_hoc_graph_allowed(graph, user):
    # Saved decisions follow their own read rules; running an unsaved graph is authoring.
    if graph is not None and not can_author(user):
        raise HTTPException(403, 'Ask an administrator for access to run unsaved decision flows')


def _caller(user):
    if not isinstance(user.get('username'), str) or not user['username']:
        raise HTTPException(401, 'Authenticated user required')
    return user['username']


def _read(decision_id, user):
    decision = db.get_decision(decision_id)
    if not decision:
        raise HTTPException(404, 'Decision not found')
    if decision['accessPolicy'] == 'private' and not user.get('is_admin') and decision['owner'] != _caller(user):
        raise HTTPException(404, 'Decision not found')
    return decision


def _write(decision_id, user):
    decision = _read(decision_id, user)
    if not user.get('is_admin') and decision['owner'] != _caller(user):
        raise HTTPException(403, 'Only the decision owner or an administrator can change it')
    return decision


def _revision(decision, expected):
    if decision['version'] != expected:
        raise HTTPException(409, 'Decision changed. Reload and review the current version.')


def _digest(graph):
    return hashlib.sha256(json.dumps(graph, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _size(value, maximum=65536):
    if len(json.dumps(value, allow_nan=False).encode()) > maximum:
        raise HTTPException(422, 'Decision data exceeds the allowed size')


def _mutation(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except db.RevisionConflict:
        raise HTTPException(409, 'Decision changed. Reload before saving.') from None
    except PermissionError:
        raise HTTPException(403, 'Decision change is not authorized') from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


def _gov_snapshot(conn, decision):
    return governance.get_or_create_cp4d_governance(conn, decision['id'], decision['name'],
                                                  decision['graph'], version=decision['version'])


def _require_governance(decision):
    conn_status = governance.connection_status()
    if not conn_status.get('configured'):
        return None
    with db.connection() as conn:
        snapshot = _gov_snapshot(conn, decision)
    if not governance.governance_ready(snapshot, decision):
        raise HTTPException(409, 'Current decision version requires verified governance evidence from the configured services')
    return snapshot


@http_router.get('/health')
def health():
    with db.connection() as conn:
        conn.execute('SELECT 1')
    return {'status': 'ok', 'engine': 'DecisionsBuddy', 'database': 'PostgreSQL', 'schema': 'decisions'}


@http_router.get('/me')
def profile(user=Depends(current_user)):
    return {'username': _caller(user), 'displayName': user.get('display_name') or user['username'],
            'isAdmin': bool(user.get('is_admin')), 'canAuthor': can_author(user)}


@http_router.get('/models')
def models(user=Depends(current_user)):
    return db.get_all_decisions(user=user)


@http_router.get('/models/{decision_id}')
def model(decision_id: str, user=Depends(current_user)):
    return _read(decision_id, user)


@http_router.post('/models')
def save(req: SaveDecisionRequest, user=Depends(flow_author)):
    validate_graph(req.graph)
    graph = copy.deepcopy(req.graph)
    for node in graph['nodes']:
        if node['type'] == 'decisionNode':
            content = node.setdefault('content', {})
            key = content.get('key') or content.get('decisionId')
            child = _read(key, user)
            version = content.get('version', child['version'])
            if type(version) is not int or version < 1:
                raise HTTPException(422, 'Nested decisions require a positive version')
            snapshot = db.get_version_snapshot(key, version)
            if snapshot is None:
                raise HTTPException(422, 'Nested decision version not found')
            content['version'] = version
            content['graphDigest'] = _digest(snapshot)
    _engine_for(graph, user)
    _size(req.defaultInput)
    saved = _mutation(db.save_decision, req.id, req.name, req.description, graph,
        req.defaultInput, change_summary=req.changeSummary, author=_caller(user),
        access_policy=req.accessPolicy, expected_version=req.expectedVersion, is_admin=bool(user.get('is_admin')))
    globals().get('broadcast_event', lambda *a: None)({'type': 'model_saved', 'decision': saved, 'author': _caller(user)})
    return {'status': 'success', 'decision': saved, 'author': _caller(user)}


@http_router.delete('/models/{decision_id}')
def delete(decision_id: str, expectedVersion: int = Query(..., ge=1), user=Depends(flow_author)):
    _write(decision_id, user)
    _mutation(db.delete_decision, decision_id, author=_caller(user),
              expected_version=expectedVersion, is_admin=bool(user.get('is_admin')))
    globals().get('broadcast_event', lambda *a: None)({'type': 'model_deleted', 'decisionId': decision_id, 'author': _caller(user)})
    return {'status': 'success'}


@http_router.get('/models/{decision_id}/versions')
def versions(decision_id: str, user=Depends(current_user)):
    _read(decision_id, user)
    return db.get_decision_versions(decision_id)


@http_router.get('/models/{decision_id}/versions/{version}')
def version(decision_id: str, version: int, user=Depends(current_user)):
    _read(decision_id, user)
    graph = db.get_version_snapshot(decision_id, version)
    if graph is None:
        raise HTTPException(404, 'Decision version not found')
    return {'version': version, 'graph': graph}


@http_router.get('/models/{decision_id}/diff')
def diff(decision_id: str, v1: int = Query(..., ge=1), v2: int = Query(..., ge=1), user=Depends(current_user)):
    _read(decision_id, user)
    graphs = [db.get_version_snapshot(decision_id, value) for value in (v1, v2)]
    if any(graph is None for graph in graphs):
        raise HTTPException(404, 'Decision version not found')
    rules = [next((node.get('content', {}).get('rules', []) for node in graph.get('nodes', [])
                   if node.get('type') == 'decisionTableNode'), []) for graph in graphs]
    return {'decisionId': decision_id, 'v1': v1, 'v2': v2, 'ruleCountV1': len(rules[0]),
            'ruleCountV2': len(rules[1]), 'rulesV1': rules[0], 'rulesV2': rules[1]}


@http_router.post('/models/{decision_id}/rollback')
def rollback(decision_id: str, version: int = Query(..., ge=1),
             expectedVersion: int = Query(..., ge=1), user=Depends(flow_author)):
    _write(decision_id, user)
    saved = _mutation(db.rollback_decision, decision_id, version, author=_caller(user),
                      expected_version=expectedVersion, is_admin=bool(user.get('is_admin')))
    if saved is None:
        raise HTTPException(404, 'Decision version not found')
    globals().get('broadcast_event', lambda *a: None)({'type': 'model_saved', 'decision': saved, 'author': _caller(user), 'action': 'rollback'})
    return {'status': 'success', 'decision': saved, 'rolledBackBy': _caller(user)}


@http_router.post('/models/{decision_id}/governance')
def set_status(decision_id: str, req: GovernanceStatusRequest, user=Depends(current_user)):
    decision = _read(decision_id, user)
    _revision(decision, req.expectedVersion)
    caller = _caller(user)
    reviewer = bool(user.get('is_admin')) or bool(set(user.get('roles') or ()) & {'decision-approver', 'approver'})
    def validate_locked(conn, current):
        transitions = {'draft': {'in_review'}, 'in_review': {'draft', 'approved'},
                       'approved': {'draft', 'published'}, 'published': {'draft'}}
        if req.status not in transitions[current['status']]:
            raise HTTPException(409, 'Submit, independently approve, then publish this version in order')
        if req.status in {'approved', 'published'}:
            if not reviewer or caller == current['updatedBy']:
                raise HTTPException(403, 'An independent authorized reviewer must approve and publish rule changes')
            snapshot = _gov_snapshot(conn, current)
            if not governance.governance_ready(snapshot, current):
                raise HTTPException(409, 'Verify current governance evidence from the configured services before approval')
            if req.status == 'published':
                engine = _engine_for(current['graph'], user, production=True)
                db.require_passing_tests(conn, current, engine.dependency_manifest)
                db.record_release(conn, current, engine.dependency_manifest, caller)
        elif not user.get('is_admin') and current['owner'] != caller:
            raise HTTPException(403, 'Only the decision owner or administrator can submit changes')
    saved = _mutation(db.update_governance_status, decision_id, req.status, req.environment,
        approver=caller if req.status in {'approved', 'published'} else None,
        author=caller, is_admin=reviewer, expected_version=req.expectedVersion, validate=validate_locked)
    globals().get('broadcast_event', lambda *a: None)({'type': 'model_updated', 'decision': saved, 'author': caller})
    return {'status': 'success', 'decision': saved, 'approver': saved.get('approver')}


@http_router.get('/models/{decision_id}/analytics')
def analytics(decision_id: str, user=Depends(current_user)):
    _read(decision_id, user)
    return db.compute_rule_heatmap(decision_id, user_id=None if user.get('is_admin') else _caller(user))


@http_router.get('/models/{decision_id}/metadata')
def model_metadata(decision_id: str, user=Depends(current_user)):
    """
    Exposes full decision model metadata, schema, and OpenAPI contracts.
    Enables CP4D Generic REST / HTTP connectors to perform automated Metadata Import (MDI)
    and catalog the decision without executing or applying it.
    """
    decision = _read(decision_id, user)
    graph = decision.get('graph') or {}
    nodes = graph.get('nodes', [])
    
    inputs = []
    outputs = []
    rules = []
    hit_policy = 'first'
    watsonx_nodes = []
    
    for n in nodes:
        ntype = n.get('type')
        content = n.get('content') or {}
        if ntype == 'decisionTableNode':
            hit_policy = content.get('hitPolicy', 'first')
            for inp in content.get('inputs', []):
                inputs.append({
                    'id': inp.get('id'),
                    'field': inp.get('field'),
                    'name': inp.get('name') or inp.get('field'),
                    'type': 'string'
                })
            for out in content.get('outputs', []):
                outputs.append({
                    'id': out.get('id'),
                    'field': out.get('field'),
                    'name': out.get('name') or out.get('field'),
                    'type': 'string'
                })
            for r in content.get('rules', []):
                rules.append({
                    'id': r.get('_id'),
                    'description': r.get('_description', ''),
                    'conditions': {k: v for k, v in r.items() if not k.startswith('_') and not k.startswith('out_')},
                    'actions': {k: v for k, v in r.items() if k.startswith('out_')}
                })
        elif ntype in ('watsonxAiNode', 'watsonxMlNode'):
            watsonx_nodes.append({
                'id': n.get('id'),
                'name': n.get('name', n.get('id')),
                'type': ntype,
                'endpoint': content.get('endpoint', ''),
                'modelOrDeployment': content.get('modelId') or content.get('deploymentId', ''),
                'outputField': content.get('outputField', '')
            })

    input_properties = {i['field']: {'type': 'string', 'description': i['name']} for i in inputs}
    output_properties = {o['field']: {'type': 'string', 'description': o['name']} for o in outputs}
    
    return {
        'assetType': 'business_rule',
        'decisionId': decision['id'],
        'name': decision['name'],
        'version': decision['version'],
        'environment': decision.get('environment', 'development'),
        'status': decision.get('status', 'draft'),
        'hitPolicy': hit_policy,
        'graphDigest': _digest(graph),
        'inputs': inputs,
        'outputs': outputs,
        'rulesCount': len(rules),
        'rules': rules,
        'watsonxDependencies': watsonx_nodes,
        'openapi': {
            'openapi': '3.0.3',
            'info': {
                'title': decision['name'],
                'version': str(decision['version']),
                'description': f"Decision Service: {decision['name']} [{decision['id']}]"
            },
            'paths': {
                '/evaluate': {
                    'post': {
                        'summary': f"Evaluate {decision['name']}",
                        'requestBody': {
                            'required': True,
                            'content': {
                                'application/json': {
                                    'schema': {
                                        'type': 'object',
                                        'properties': input_properties
                                    }
                                }
                            }
                        },
                        'responses': {
                            '200': {
                                'description': 'Decision evaluation result',
                                'content': {
                                    'application/json': {
                                        'schema': {
                                            'type': 'object',
                                            'properties': output_properties
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }


@http_router.get('/models/{decision_id}/openapi.json')
def model_openapi(decision_id: str, user=Depends(current_user)):
    """Returns standalone OpenAPI 3.0 specification for CP4D generic REST import."""
    meta = model_metadata(decision_id, user)
    return meta['openapi']


@http_router.get('/cp4d/status')
def cp4d_status():
    return governance.connection_status()


@http_router.get('/admin/integrations')
def admin_settings(user=Depends(administrator)):
    return get_public_settings()


@http_router.put('/admin/integrations/{provider}')
def save_admin_settings(provider: str, req: ConnectorSettings, user=Depends(administrator)):
    return update_admin_settings(provider, req.model_dump(), _caller(user))


@http_router.post('/admin/integrations/{provider}/test')
def test_admin_settings(provider: str, user=Depends(administrator)):
    return test_admin_connection(provider, _caller(user))


@http_router.get('/cp4d/catalogs')
def catalogs(provider: Literal['ikc', 'wxdi'] = 'ikc'):
    return governance.list_catalogs(provider)


@http_router.get('/cp4d/terms')
def terms(provider: Literal['ikc', 'wxdi'] = 'ikc'):
    return governance.list_terms(provider)


@http_router.get('/cp4d/governance/{decision_id}')
def governance_record(decision_id: str, user=Depends(current_user)):
    decision = _read(decision_id, user)
    with db.connection() as conn:
        return _gov_snapshot(conn, decision)


def _lock_for_governance(conn, decision_id, expected, user):
    row = conn.execute('SELECT owner,version FROM decisions.decisions WHERE id=%s FOR UPDATE', (decision_id,)).fetchone()
    if not row or not user.get('is_admin') and row['owner'] != _caller(user):
        raise HTTPException(403, 'Only the decision owner or administrator can change governance mappings')
    if row['version'] != expected:
        raise HTTPException(409, 'Decision changed. Refresh its governance evidence.')


@http_router.post('/cp4d/governance/{decision_id}/map-term')
def map_term(decision_id: str, req: MapTermRequest, user=Depends(current_user)):
    decision = _write(decision_id, user)
    with db.connection() as conn:
        _lock_for_governance(conn, decision_id, req.expectedVersion, user)
        _gov_snapshot(conn, decision)
        db._event(conn, decision_id, _caller(user), 'governance.term_mapped',
                  {'field': req.field, 'provider': req.provider, 'termId': req.termId, 'version': req.expectedVersion})
        mappings = governance.update_cp4d_term_mapping(conn, decision_id, req.field, req.termId, provider=req.provider)
    globals().get('broadcast_event', lambda *a: None)({'type': 'governance_synced', 'decisionId': decision_id, 'author': _caller(user)})
    return {'status': 'success', 'termMappings': mappings}


@http_router.post('/cp4d/sync/{decision_id}')
def sync(decision_id: str, req: SyncCP4DRequest, user=Depends(current_user)):
    decision = _write(decision_id, user)
    _revision(decision, req.expectedVersion)
    with db.connection() as conn:
        _lock_for_governance(conn, decision_id, req.expectedVersion, user)
        db._event(conn, decision_id, _caller(user), 'governance.sync_requested', {'version': req.expectedVersion})
        result = governance.sync_decision_to_cp4d(conn, decision_id, decision['name'], decision['graph'],
                                                version=decision['version'])
    globals().get('broadcast_event', lambda *a: None)({'type': 'governance_synced', 'decisionId': decision_id, 'author': _caller(user)})
    return result


@http_router.post('/cp4d/governance/{decision_id}/reconcile')
def reconcile(decision_id: str, req: ReconcileRequest, user=Depends(administrator)):
    _read(decision_id, user)
    with db.connection() as conn:
        _lock_for_governance(conn, decision_id, req.expectedVersion, user)
        result = governance.adopt_remote_asset(conn, decision_id, req.provider, req.assetId)
        db._event(conn, decision_id, _caller(user), 'governance.asset_reconciled',
                  {'provider': req.provider, 'assetId': req.assetId, 'version': req.expectedVersion})
    globals().get('broadcast_event', lambda *a: None)({'type': 'governance_synced', 'decisionId': decision_id, 'author': _caller(user)})
    return result


@http_router.get('/cp4d/lineage/{decision_id}')
def lineage(decision_id: str, user=Depends(current_user)):
    return governance_record(decision_id, user).get('lineageManifest', {})


def _engine_for(graph, user, production=False):
    registry, manifest, descendants_cache = {}, {}, {}
    references = 0
    def collect(current, path):
        nonlocal references
        validate_graph(current)
        dependencies = {}
        for node in current.get('nodes', []):
            if node.get('type') != 'decisionNode':
                continue
            references += 1
            if references > 256:
                raise HTTPException(422, 'Nested decision reference budget exceeded')
            content = node.get('content', {})
            key = content.get('key') or content.get('decisionId')
            if not key or key in path or len(path) >= 8:
                raise HTTPException(422, 'Invalid or recursive nested decision')
            child = _read(key, user)  # Historical versions still require current read permission.
            version = content.get('version')
            if version is None:
                if production:
                    raise HTTPException(409, 'Resave nested decisions to pin their dependency versions before publishing')
                version, child_graph = child['version'], child['graph']
            else:
                if type(version) is not int or version < 1:
                    raise HTTPException(422, 'Invalid nested decision version')
                child_graph = db.get_version_snapshot(key, version)
                if child_graph is None:
                    raise HTTPException(409, 'Pinned nested decision version is unavailable')
            binding = {'version': version, 'graphDigest': _digest(child_graph)}
            if content.get('graphDigest') and content['graphDigest'] != binding['graphDigest']:
                raise HTTPException(409, 'Nested decision integrity check failed')
            if key in manifest and manifest[key] != binding:
                raise HTTPException(422, 'A graph cannot use conflicting versions of the same nested decision')
            if key not in registry:
                registry[key] = child_graph
                manifest[key] = binding
                if len(registry) > 16:
                    raise HTTPException(422, 'Nested decision limit exceeded')
            if key not in descendants_cache:
                descendants_cache[key] = collect(child_graph, (*path, key))
            descendants = descendants_cache[key]
            if production:
                release = db.get_release(key, version)
                if not release or release['graph_digest'] != binding['graphDigest'] or release['dependency_manifest'] != descendants:
                    raise HTTPException(409, 'Nested decisions require an immutable published release for the pinned version')
            dependencies.update(descendants)
            dependencies[key] = binding
        return dependencies
    collect(graph, ())
    engine = DecisionEngine(registry)
    engine.dependency_manifest = manifest
    return engine


def _evaluate(req, user):
    _size(req.input)
    decision = _read(req.decisionId, user) if req.decisionId else None
    if decision and req.expectedVersion is not None:
        _revision(decision, req.expectedVersion)
    graph = validate_graph(decision['graph'] if decision else req.graph)
    snapshot = None
    if req.mode == 'production':
        if decision['status'] != 'published' or decision['environment'] != 'production':
            raise HTTPException(409, 'Only published production decisions can be evaluated in production mode')
        snapshot = _require_governance(decision)
    engine = _engine_for(graph, user, req.mode == 'production')
    if req.mode == 'production':
        release = db.get_release(decision['id'], decision['version'])
        if not release or release['graph_digest'] != _digest(graph) or release['dependency_manifest'] != engine.dependency_manifest:
            raise HTTPException(409, 'Publish an immutable tested release before production evaluation')
    result = engine.evaluate(graph, req.input)
    perf = result['performance']
    db.log_evaluation(req.decisionId or 'unsaved-draft', req.input, result.get('result', {}),
        perf['durationMicros'], perf['nodesExecuted'], result.get('trace', []), user_id=_caller(user),
        decision_version=decision['version'] if decision else None, graph_digest=_digest(graph),
        governance_snapshot={'catalog': snapshot, 'dependencies': engine.dependency_manifest})
    return {**result, 'mode': req.mode, 'decisionVersion': decision['version'] if decision else None,
            'graphDigest': _digest(graph), 'governanceVerified': snapshot is not None,
            'dependencyManifest': engine.dependency_manifest}


@http_router.post('/evaluate')
def evaluate(req: EvaluateRequest, user=Depends(current_user)):
    _ad_hoc_graph_allowed(req.graph, user)
    return _evaluate(req, user)


@http_router.post('/evaluate/batch')
def evaluate_batch(req: BatchEvaluateRequest, user=Depends(current_user)):
    _ad_hoc_graph_allowed(req.graph, user)
    _size(req.items, 1024 * 1024)
    results = [_evaluate(EvaluateRequest(decisionId=req.decisionId, graph=req.graph, input=item,
                         expectedVersion=req.expectedVersion), user) for item in req.items]
    total = sum(result['performance']['durationMicros'] for result in results)
    return {'status': 'success', 'decisionId': req.decisionId, 'totalItems': len(results),
            'totalDurationMicros': total, 'avgItemMicros': total / len(results),
            'results': [{'index': index, 'input': req.items[index], 'result': result['result'],
                         'durationMicros': result['performance']['durationMicros']} for index, result in enumerate(results)]}


@http_router.post('/analyze')
def analyze(req: AnalyzeRequest, user=Depends(current_user)):
    _ad_hoc_graph_allowed(req.graph, user)
    if (req.graph is None) == (req.decisionId is None):
        raise HTTPException(422, 'Provide either a decision ID or graph')
    graph = validate_graph(_read(req.decisionId, user)['graph'] if req.decisionId else req.graph)
    diagnostics = analyze_graph(graph)
    return {'status': 'success', 'diagnostics': diagnostics, 'issueCount': len(diagnostics),
            'hasErrors': any(item.get('severity') == 'error' for item in diagnostics),
            'hasWarnings': any(item.get('severity') == 'warning' for item in diagnostics)}


@http_router.get('/models/{decision_id}/test-cases')
def get_test_cases(decision_id: str, user=Depends(current_user)):
    _read(decision_id, user)
    return db.test_suite(decision_id)


@http_router.put('/models/{decision_id}/test-cases')
def save_test_cases(decision_id: str, req: TestSuiteRequest, user=Depends(flow_author)):
    _write(decision_id, user)
    cases = [case.model_dump(mode='json') for case in req.cases]
    _size(cases, 1024 * 1024)
    if len({case['name'].strip() for case in cases}) != len(cases) or any(not case['name'].strip() for case in cases):
        raise HTTPException(422, 'Use unique nonempty test case names')
    return _mutation(db.save_test_suite, decision_id, cases,
                     expected_version=req.expectedVersion, expected_suite_revision=req.expectedSuiteRevision,
                     actor=_caller(user), is_admin=bool(user.get('is_admin')))


@http_router.post('/models/{decision_id}/run-tests')
def run_test_cases(decision_id: str, req: RunTestsRequest, user=Depends(current_user)):
    decision = _read(decision_id, user)
    _revision(decision, req.expectedVersion)
    suite = db.test_suite(decision_id)
    if not suite['cases'] or suite['decisionVersion'] != decision['version']:
        raise HTTPException(409, 'Save test cases against this decision version before running them')
    engine = _engine_for(decision['graph'], user)
    results = []
    for case in suite['cases']:
        try:
            actual = engine.evaluate(decision['graph'], copy.deepcopy(case['input']))['result']
            # JSON equality keeps booleans distinct from numbers and ignores key order.
            passed = json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(case['expected'], sort_keys=True, allow_nan=False)
            results.append({'name': case['name'], 'passed': passed, 'expected': case['expected'], 'actual': actual})
        except (ValueError, TypeError, KeyError, ArithmeticError):
            results.append({'name': case['name'], 'passed': False, 'expected': case['expected'],
                            'actual': None, 'error': 'Evaluation failed; inspect the graph and case inputs'})
    passed = all(item['passed'] for item in results)
    _mutation(db.record_test_run, decision_id, decision['version'], suite['suiteRevision'],
              _digest(decision['graph']), engine.dependency_manifest, passed, _caller(user))
    return {'decisionVersion': decision['version'], 'suiteRevision': suite['suiteRevision'],
            'passed': passed, 'results': results}


@http_router.get('/audit-logs')
def audit_logs(limit: int = Query(50, ge=1, le=200), user=Depends(current_user)):
    return db.get_recent_logs(limit, user_id=None if user.get('is_admin') else _caller(user))


@http_router.post('/evaluate/unary')
def unary(req: dict):
    _size(req)
    if len(str(req.get('test', ''))) > 2048:
        raise HTTPException(422, 'Unary test is too long')
    try:
        return evaluate_unary(req.get('test'), req.get('value'), req.get('context'))
    except Exception as e:
        raise HTTPException(422, f'Unary evaluation failed: {e}')


@http_router.post('/evaluate/expression')
def expression(req: dict):
    _size(req)
    try:
        return {'result': evaluate_expression(req.get('expression'), req.get('context', {})), 'status': 'success'}
    except Exception as e:
        raise HTTPException(422, f'Expression evaluation failed: {e}')


@http_router.post('/evaluate/bal')
def evaluate_bal(req: dict):
    _size(req)
    rule = str(req.get('rule', '')).strip()
    if not rule:
        raise HTTPException(422, 'BAL rule text cannot be empty')
    context = req.get('context', {})
    try:
        from .bal_engine import evaluate_bal_rule
        res = evaluate_bal_rule(rule, context, req.get('vocabulary'))
        return {'status': 'success', 'result': context, 'trace': res}
    except Exception as e:
        raise HTTPException(422, f'BAL rule evaluation failed: {e}')


@http_router.post('/simulation/kpis')
def simulation_kpis(req: dict, user=Depends(current_user)):
    from .simulation_kpis import simulate, validate_simulation, compare_reports
    _size(req, 1024 * 1024)
    allowed = {'decisionId', 'graph', 'expectedVersion', 'cases', 'report',
               'baselineDecisionId', 'baselineExpectedVersion'}
    if set(req) - allowed or (req.get('graph') is None) == (req.get('decisionId') is None):
        raise HTTPException(422, 'Provide either decisionId or graph, cases and report configuration')
    try:
        for field in ('decisionId', 'baselineDecisionId'):
            if field in req and req[field] is not None and (not isinstance(req[field], str) or not req[field] or len(req[field]) > 200):
                raise ValueError('Decision IDs must be nonempty strings of at most 200 characters')
        for field in ('expectedVersion', 'baselineExpectedVersion'):
            if field in req and req[field] is not None and (type(req[field]) is not int or req[field] < 1):
                raise ValueError('Expected versions must be positive integers')
        cases, config = req.get('cases'), req.get('report')
        validate_simulation(cases, config)
        decision = _read(req['decisionId'], user) if req.get('decisionId') else None
        if decision and req.get('expectedVersion') is not None:
            _revision(decision, req['expectedVersion'])
        graph = validate_graph(decision['graph'] if decision else req['graph'])
        engine = _engine_for(graph, user)
        report = simulate(engine, graph, cases, config)
        report.update({'graphDigest': _digest(graph),
                       'decisionVersion': decision['version'] if decision else None,
                       'dependencyManifest': engine.dependency_manifest})
        baseline_id = req.get('baselineDecisionId')
        if baseline_id:
            baseline = _read(baseline_id, user)
            if req.get('baselineExpectedVersion') is not None:
                _revision(baseline, req['baselineExpectedVersion'])
            baseline_graph = validate_graph(baseline['graph'])
            baseline_engine = _engine_for(baseline_graph, user)
            baseline_report = simulate(baseline_engine, baseline_graph, cases, config)
            baseline_report.update({'graphDigest': _digest(baseline_graph), 'decisionVersion': baseline['version'],
                                    'dependencyManifest': baseline_engine.dependency_manifest})
            report['baseline'] = baseline_report
            report['comparison'] = compare_reports(report, baseline_report)
        # Simulation reports are ad hoc evidence; they cannot satisfy saved regression gates.
        return report
    except (ValueError, TypeError, KeyError, SyntaxError) as error:
        raise HTTPException(422, str(error)) from error


@http_router.get('/simulation/workbook-template')
def simulation_workbook_template(user=Depends(current_user)):
    from .scenario_workbook import workbook_template
    return Response(workbook_template(),
                    media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    headers={'Content-Disposition': 'attachment; filename="decision-scenarios.xlsx"'})


@http_router.post('/simulation/import-workbook')
def simulation_import_workbook(req: dict, user=Depends(current_user)):
    import base64
    import binascii
    _size(req, 2 * 1024 * 1024)
    from .scenario_workbook import import_workbook
    try:
        encoded = req.get('contentBase64')
        if not isinstance(encoded, str):
            raise ValueError('Provide contentBase64 containing an XLSX workbook')
        content = base64.b64decode(encoded, validate=True)
        return {'cases': import_workbook(content)}
    except (ValueError, binascii.Error) as error:
        raise HTTPException(422, str(error)) from error


@http_router.post('/dvs/evaluate')
def dvs_evaluate(req: dict, user=Depends(current_user)):
    _size(req, 1024 * 1024)
    _ad_hoc_graph_allowed(req.get('graph'), user)
    decision_id = req.get('decisionId')
    graph = req.get('graph')
    if (graph is None) == (decision_id is None):
        raise HTTPException(422, 'Provide either a decision ID or graph')
    scenarios = req.get('scenarios', [])
    if not isinstance(scenarios, list) or len(scenarios) > 500:
        raise HTTPException(422, 'Provide a list of up to 500 test scenarios')
    decision_graph = validate_graph(_read(decision_id, user)['graph'] if decision_id else graph)
    from .dvs_engine import evaluate_dvs_suite
    scorecard = evaluate_dvs_suite(decision_graph, scenarios)
    return {'status': 'success', **scorecard}


@http_router.post('/assistant/generate-flow')
def assistant_generate_flow(req: dict, user=Depends(flow_author)):
    _size(req)
    prompt = str(req.get('prompt', '')).strip()
    if not prompt:
        raise HTTPException(422, 'Provide a prompt describing the flow you want Bob to design.')
    from .flow_designer import generate_decision_flow
    generated = generate_decision_flow(prompt, req.get('currentGraph'))
    validate_graph(generated['graph'])
    globals().get('broadcast_event', lambda *a: None)({'type': 'flow_generated', 'name': generated.get('name'), 'author': _caller(user)})
    return {'status': 'success', **generated}


@http_router.post('/watsonx/test')
def test_watsonx_inference(req: dict, user=Depends(administrator)):
    _size(req)
    kind = req.get('kind', 'watsonx_ai')
    if kind == 'watsonx_ml':
        from .watsonx_inference import execute_watsonx_ml
        return execute_watsonx_ml(req, req.get('context', {}))
    from .watsonx_inference import execute_watsonx_ai
    return execute_watsonx_ai(req, req.get('context', {}))


router.include_router(http_router)


@router.websocket('/ws')
async def decisions_websocket(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    host = websocket.headers.get("host")
    if origin and host and urlsplit(origin).netloc != host:
        await websocket.close(code=1008)
        return
    try:
        user = await current_user(websocket)
    except (HTTPException, Exception):
        await websocket.close(code=1008)
        return

    await manager.connect(websocket)
    try:
        await websocket.send_json({"type": "connected", "user": _caller(user)})
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_text("pong")
    except (WebSocketDisconnect, Exception):
        manager.disconnect(websocket)


def create_app():
    from app.access_boundary import AccessBoundaryMiddleware
    @asynccontextmanager
    async def lifespan(application):
        try:
            manager.loop = asyncio.get_running_loop()
        except Exception:
            pass
        db.init_db()
        yield
    application = FastAPI(title='DecisionsBuddy', version='1.0.0', lifespan=lifespan, docs_url=None, redoc_url=None)
    application.add_middleware(AccessBoundaryMiddleware)
    application.include_router(router)
    @application.exception_handler(GovernanceError)
    async def governance_error(request, exc):
        return __import__('starlette.responses', fromlist=['JSONResponse']).JSONResponse({'detail': str(exc)}, status_code=409)
    @application.exception_handler(ValueError)
    async def validation_error(request, exc):
        return __import__('starlette.responses', fromlist=['JSONResponse']).JSONResponse({'detail': str(exc)}, status_code=422)
    @application.get('/health')
    def liveness():
        return {'ok': True}
    @application.get('/ready')
    def readiness():
        try:
            with db.connection() as conn:
                conn.execute('SELECT 1 FROM decisions.decisions LIMIT 1')
        except Exception:
            raise HTTPException(503, 'DecisionsBuddy database unavailable') from None
        return {'ok': True}
    @application.get('/plugins/manifest')
    def manifest():
        return {'id': 'decisions', 'version': '1.0.0', 'runtime_api': 1, 'schema': 'decisions', 'api_prefix': '/api/decisions'}
    return application


app = create_app()
