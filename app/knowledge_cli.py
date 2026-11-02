"""Read shared knowledge through the run's restricted local capability."""
import asyncio
import json
import os
import sys

MAX_QUERY_BYTES = 8192
MAX_RESPONSE_BYTES = 1024 * 1024


async def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        raise SystemExit('Usage: knowledge_cli.py "search question"')
    query = sys.argv[1]
    if len(query.encode()) > MAX_QUERY_BYTES:
        raise ValueError('Knowledge query too large')
    path = os.environ.get('BOB_KNOWLEDGE_SOCKET')
    if not path:
        raise RuntimeError('Knowledge capability unavailable')
    reader, writer = await asyncio.open_unix_connection(path, limit=MAX_RESPONSE_BYTES)
    try:
        writer.write(json.dumps({'query': query}).encode() + b'\n')
        await writer.drain()
        response = json.loads(await asyncio.wait_for(reader.readline(), 95))
        if 'error' in response:
            raise RuntimeError(response['error'])
        print(response['text'])
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception:
        print('Knowledge search failed. Check source readiness and the embedding service.', file=sys.stderr)
        raise SystemExit(1)
