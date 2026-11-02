"""Stable routing metadata for a conversation turn, independent of model sessions."""
import json
import re
import uuid

ID_PATTERN = r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
ID_FIELDS = ('correlation_id', 'user_message_id', 'assistant_message_id')


def request_ids(values, header_id=None):
    result = {}
    for name in ID_FIELDS:
        value = values.get(name)
        if value is None and name == 'correlation_id':
            value = header_id
        if value is None:
            value = str(uuid.uuid4())
        if not isinstance(value, str) or not re.fullmatch(ID_PATTERN, value):
            raise ValueError(f'Invalid {name}')
        result[name] = value
    return result


def turn_metadata(payload, workspace_id, job_id=None):
    metadata = {key: payload[key] for key in ID_FIELDS if payload.get(key)}
    if workspace_id is not None:
        metadata.update(workspace_id=workspace_id, chat_id=workspace_id)
    if job_id is not None:
        metadata['job_id'] = str(job_id)
    if metadata.get('assistant_message_id'):
        metadata['message_id'] = metadata['assistant_message_id']
    return metadata


async def correlate_stream(source, metadata):
    """Apply trusted routing fields to every outgoing NDJSON event."""
    from contextlib import aclosing
    async with aclosing(source):
        async for line in source:
            yield json.dumps({**json.loads(line), **metadata}, ensure_ascii=False) + '\n'
