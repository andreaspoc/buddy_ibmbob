"""Restricted service-to-service Office actions with a fixed authenticated owner."""
import base64
import hashlib
import json
import re
from psycopg.types.json import Jsonb
from uuid import UUID

import jwt
from fastapi.encoders import jsonable_encoder
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix='/api/office', tags=['office'])
MAX_REQUEST = 70 * 1024 * 1024


def execute(username, operation, arguments):
    if operation not in {'save', 'save_chat', 'create_folder', 'create_form'}:
        return jsonable_encoder(_execute(username, operation, arguments))
    from . import office
    from app import job_queue
    arguments = dict(arguments)
    key = arguments.pop('action_key', None)
    if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{64}', key):
        raise ValueError('Write action key required')
    digest_arguments = arguments
    if operation == 'save_chat':
        intent = arguments.pop('intent_digest', None)
        if not isinstance(intent, str) or not re.fullmatch(r'[a-f0-9]{64}', intent):
            raise ValueError('Chat save intent required')
        digest_arguments = {'intent_digest': intent, 'name': arguments.get('name'), 'folder_id': arguments.get('folder_id')}
    digest = hashlib.sha256(json.dumps([operation, digest_arguments], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    office.ensure_schema()
    with job_queue._connect() as db:
        db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ('office-action:' + username + ':' + key,))
        previous = db.execute('SELECT digest,result FROM office.bob_app_action_receipts WHERE username=%s AND action_key=%s', (username, key)).fetchone()
        if previous:
            if previous['digest'] != digest:
                raise ValueError('This Office action index already saved different content; use a new index')
            return previous['result']
        result = jsonable_encoder(_execute(username, operation, arguments, db=db))
        db.execute('INSERT INTO office.bob_app_action_receipts(username,action_key,digest,result) VALUES(%s,%s,%s,%s)', (username, key, digest, Jsonb(result)))
        return result


def _execute(username, operation, arguments, *, db=None):
    from . import office
    from .office_chat import chat_context
    user = {'username': username}
    if operation == 'list':
        from pydantic import BaseModel, ConfigDict, Field
        class ListFiles(BaseModel):
            model_config = ConfigDict(extra='forbid')
            query: str = Field(default='', max_length=200)
            folder_id: UUID | None = None
            offset: int = Field(default=0, ge=0)
            limit: int = Field(default=25, ge=1, le=100)
        args = ListFiles.model_validate(arguments)
        items = office.files(user=user)['items']
        if args.query.strip():
            items = [item for item in items if args.query.strip().casefold() in item['name'].casefold()]
        if args.folder_id:
            items = [item for item in items if str(item.get('folder_id')) == str(args.folder_id)]
        total = len(items)
        page = items[args.offset:args.offset + args.limit]
        return {'items': [{**item, 'url': '/office/files/' + str(item['id'])} for item in page],
                'total': total, 'next_offset': args.offset + args.limit if args.offset + args.limit < total else None}
    if operation == 'folders':
        if arguments: raise ValueError('Unexpected folder arguments')
        return office.folders(user=user)
    if operation == 'info':
        if set(arguments) != {'file_id'}: raise ValueError('Invalid file arguments')
        return office.file_info(UUID(arguments['file_id']), user=user)
    if operation == 'read':
        if set(arguments) != {'file_id'}: raise ValueError('Invalid read arguments')
        context, references = chat_context(username, [UUID(arguments['file_id'])])
        return {'context': context, 'references': references}
    if operation in {'save', 'save_chat'}:
        if not set(arguments) <= {'name', 'content', 'content_base64', 'folder_id'} or 'name' not in arguments:
            raise ValueError('Invalid save arguments')
        if ('content' in arguments) == ('content_base64' in arguments):
            raise ValueError('Supply one content representation')
        raw = arguments['content'].encode('utf-8') if 'content' in arguments else base64.b64decode(arguments['content_base64'], validate=True)
        if len(raw) > office.MAX_BYTES: raise ValueError('Office file too large')
        folder = UUID(arguments['folder_id']) if arguments.get('folder_id') else None
        result = office.store_new(username, arguments['name'], raw, folder, db=db)
        return {**result, 'url': '/office/files/' + str(result['id'])}
    if operation == 'create_form':
        from app.office_forms import FormSpec
        from .office_forms import render_form
        spec = FormSpec.model_validate(arguments)
        try:
            raw = render_form(spec)
        except UnicodeEncodeError:
            raise ValueError('PDF form labels currently support Windows ANSI characters; use Latin-script labels') from None
        name = spec.name if spec.name.lower().endswith('.pdf') else spec.name + '.pdf'
        result = office.store_new(username, name, raw, spec.folder_id, db=db)
        return {**result, 'url': '/office/files/' + str(result['id']), 'field_count': len(spec.fields)}
    if operation == 'create_folder':
        req = office.NewFolder.model_validate(arguments)
        if db is not None:
            from .office_folders import create
            return create(db, username, req.name, req.parent_id)
        return office.create_folder(req, user=user)
    raise ValueError('Unsupported Office action')


@router.post('/app-actions')
async def app_actions(request: Request):
    from .office import secret
    authorization = request.headers.get('authorization', '')
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, 'Office action capability required')
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_REQUEST:
            raise HTTPException(413, 'Office action too large')
    try:
        claims = jwt.decode(authorization[7:], secret(), algorithms=['HS256'], audience='buddy-office-actions',
                            options={'require': ['sub', 'iat', 'exp', 'body_sha256']})
        if not isinstance(claims['sub'], str) or not claims['sub'] or claims['exp'] - claims['iat'] > 60:
            raise ValueError('Invalid capability lifetime')
        if claims['body_sha256'] != hashlib.sha256(raw).hexdigest():
            raise ValueError('Capability body mismatch')
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(401, 'Invalid Office action capability') from None
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != {'operation', 'arguments'} or not isinstance(payload['arguments'], dict):
            raise ValueError('Invalid action')
        return await run_in_threadpool(execute, claims['sub'], payload['operation'], payload['arguments'])
    except (ValueError, TypeError, KeyError):
        raise HTTPException(422, 'Invalid Office action') from None
