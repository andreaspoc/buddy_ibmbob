"""Hold every file download until its content is reviewed for personal data."""
import asyncio
import html
import json
import logging
import re
import zlib
from urllib.parse import parse_qs, unquote

from app import privacy_policy
from app.personal_data import MAX_EXTRACTED_BYTES, UNCHECKED

logger = logging.getLogger('security.personal_data')
CONFIRM_HEADER = b'x-personal-data-confirmed'
CONFIRM_QUERY = 'personal_data_confirmed'
MAX_REVIEW_BYTES = 100 * 1024 * 1024
_EXEMPT = (re.compile(r'^/api/learning/certificates/[^/]+/download$'),)
_FILENAME_STAR = re.compile(r"filename\*=(?:UTF-8'')?([^;]+)", re.I)
_FILENAME = re.compile(r'filename="?([^";]+)"?', re.I)


def _header(headers, name: bytes) -> str:
    return next((value.decode('latin-1') for key, value in headers if key.lower() == name), '')


def _filename(disposition: str) -> str:
    match = _FILENAME_STAR.search(disposition)
    if match:
        return unquote(match.group(1).strip())
    match = _FILENAME.search(disposition)
    return match.group(1).strip() if match else ''


def _confirmed(scope) -> bool:
    headers = scope.get('headers', [])
    if _header(headers, CONFIRM_HEADER) == '1':
        return True
    # A link on another site must not be able to skip the warning.
    query = parse_qs(scope.get('query_string', b'').decode('latin-1'))
    return query.get(CONFIRM_QUERY) == ['1'] and _header(headers, b'sec-fetch-site') != 'cross-site'


def _unchecked():
    return privacy_policy.decide([UNCHECKED], privacy_policy.load_policy())


def _review(start, body: bytes, oversized: bool) -> tuple[list[str], list[str]]:
    if oversized:
        return _unchecked()
    headers = start.get('headers', [])
    encoding = _header(headers, b'content-encoding').lower()
    if encoding == 'gzip':
        decoder = zlib.decompressobj(47)
        body = decoder.decompress(body, MAX_EXTRACTED_BYTES)
        if decoder.unconsumed_tail:
            return _unchecked()
    elif encoding not in {'', 'identity'}:
        return _unchecked()
    return privacy_policy.review_file(_filename(_header(headers, b'content-disposition')), body, 'download',
                                      media_type=_header(headers, b'content-type'))


def _blocked_page(categories) -> bytes:
    items = ''.join(f'<li>{html.escape(item)}</li>' for item in categories)
    return (f'<!doctype html><html lang="en"><meta charset="utf-8"><title>Download blocked</title>'
            f'<body style="font-family:sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">'
            f'<h1>Your data protection policy blocks this file</h1><ul>{items}</ul></body></html>').encode('utf-8')


def _review_page(scope, categories) -> bytes:
    query = scope.get('query_string', b'').decode('latin-1')
    target = html.escape('?' + (query + '&' if query else '') + CONFIRM_QUERY + '=1', quote=True)
    items = ''.join(f'<li>{html.escape(item)}</li>' for item in categories)
    return (f'<!doctype html><html lang="en"><meta charset="utf-8"><title>Review download</title>'
            f'<body style="font-family:sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">'
            f'<h1>This file may contain personal data</h1><ul>{items}</ul>'
            f'<p><a href="{target}">Download anyway</a></p></body></html>').encode('utf-8')


class DownloadReviewMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or any(rule.match(scope.get('path', '')) for rule in _EXEMPT):
            await self.app(scope, receive, send)
            return
        confirmed = _confirmed(scope)
        start, chunks, size, finished = None, [], 0, False

        async def hold(message):
            nonlocal start, size, finished
            if message['type'] == 'http.response.start':
                disposition = _header(message.get('headers', []), b'content-disposition').lower()
                if not disposition.startswith('attachment'):
                    await send(message)
                    return
                start = message
                return
            if start is None:
                await send(message)
                return
            if finished:
                return
            size += len(message.get('body', b''))
            if size <= MAX_REVIEW_BYTES:
                chunks.append(message.get('body', b''))
            else:
                chunks.clear()
            if not message.get('more_body'):
                finished = True
                await self._release(scope, send, start, b''.join(chunks), size > MAX_REVIEW_BYTES, confirmed)

        await self.app(scope, receive, hold)

    @staticmethod
    async def _release(scope, send, start, body, oversized, confirmed=False):
        blocked, ask = await asyncio.to_thread(_review, start, body, oversized)
        if not blocked and (confirmed or not ask):
            if ask:
                logger.info('download_released_after_confirmation path=%r', scope.get('path'))
            await send(start)
            await send({'type': 'http.response.body', 'body': body})
            return
        categories = blocked or ask
        logger.info('download_held path=%r blocked=%r categories=%r', scope.get('path'), bool(blocked), categories)
        navigating = _header(scope.get('headers', []), b'sec-fetch-mode') == 'navigate'
        if navigating:
            content = _blocked_page(categories) if blocked else _review_page(scope, categories)
            media_type = b'text/html; charset=utf-8'
        else:
            code = 'personal_data_blocked' if blocked else 'personal_data_download'
            message = 'Your data protection policy blocks this file.' if blocked else 'This file may contain personal data.'
            content = json.dumps({'detail': {'code': code, 'categories': categories, 'message': message}}).encode('utf-8')
            media_type = b'application/json'
        await send({'type': 'http.response.start', 'status': 403 if blocked else 409, 'headers': [
            (b'content-type', media_type), (b'content-length', str(len(content)).encode('ascii')),
            (b'cache-control', b'no-store'), (b'x-personal-data-review', b'blocked' if blocked else b'download')]})
        await send({'type': 'http.response.body', 'body': content})
