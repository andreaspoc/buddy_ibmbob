"""Bounded public-web collection and integrity-checked research evidence.

Signatures detect altered or invented evidence files. They are not a sandbox
boundary: Buddy's local tools run with the worker's operating-system privileges.
"""
from __future__ import annotations
import argparse
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import shlex
import socket
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import urlsplit, urljoin
import re
import httpx
from .mcp_search import brave_web_search, _strip_html
from .safe_http import sync_transport, validate_url as safe_validate_url, resolve

MAX_BYTES = 2_000_000
MAX_TEXT = 50_000
NATIVE_FETCH_TOOL = 'mcp__brave_search__fetch_web_page'
_CLI_FETCH = ('python3', '-m', 'app.mcp_client', 'call', 'brave_search', 'fetch_web_page', '--arguments')


def _key() -> bytes:
    value = os.environ.get('RESEARCH_EVIDENCE_SECRET') or os.environ.get('BOB_API_KEY') or os.environ.get('BUDDY_MEMORY_SIGNING_KEY')
    if not value:
        raise ValueError('Research evidence signing requires a configured server key')
    return hashlib.sha256(('research-evidence-v1:' + value).encode()).digest()


def _signature(record: dict) -> str:
    data = {k: v for k, v in record.items() if k != 'signature'}
    return hmac.new(_key(), json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def validate_public_url(url: str) -> None:
    safe_validate_url(url)
    parsed = urlsplit(url)
    resolve(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))


def fetch_source(url: str) -> dict:
    current = url
    # Every redirect destination is revalidated; environment proxy routes are disabled.
    with httpx.Client(transport=sync_transport(), timeout=httpx.Timeout(15, connect=5), follow_redirects=False, trust_env=False) as client:
        for _ in range(6):
            validate_public_url(current)
            with client.stream('GET', current, headers={'User-Agent': 'BuddyResearch/1.0', 'Accept': 'text/html,text/plain,application/json,application/pdf'}) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get('location')
                    if not location:
                        raise ValueError('Redirect has no destination')
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                content_type = response.headers.get('content-type', '').split(';')[0].lower()
                if content_type not in {'text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/pdf'}:
                    raise ValueError('Unsupported page format; HTML, text, and PDF sources are supported')
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError('Page exceeds research download limit')
                    chunks.append(chunk)
                if content_type == 'application/pdf':
                    import io
                    from pypdf import PdfReader
                    try:
                        reader = PdfReader(io.BytesIO(b''.join(chunks)))
                        if len(reader.pages) > 200:
                            raise ValueError('PDF exceeds 200-page research limit')
                        raw = '\n\n'.join(page.extract_text() or '' for page in reader.pages)
                    except Exception as exc:
                        raise ValueError('PDF could not be read: ' + str(exc)[:200]) from exc
                else:
                    raw = b''.join(chunks).decode(response.encoding or 'utf-8', errors='replace')
                title_match = re.search(r'<title[^>]*>(.*?)</title>', raw, re.I | re.S)
                title = _strip_html(title_match.group(1)) if title_match else urlsplit(current).hostname
                text = _strip_html(raw) if 'html' in content_type else raw
                text = text.strip()
                if not text:
                    raise ValueError('Page has no readable text')
                record = {'version': 1, 'kind': 'web', 'url': current, 'requested_url': url, 'title': title,
                          'text': text[:MAX_TEXT], 'truncated': len(text) > MAX_TEXT,
                          'fetched_at': datetime.now(timezone.utc).isoformat(), 'content_type': content_type,
                          'content_sha256': hashlib.sha256(text[:MAX_TEXT].encode()).hexdigest()}
                record['signature'] = _signature(record)
                return record
    raise ValueError('Too many redirects')


def _cli_fetch_url(command):
    """Return the URL of an exact page-reader CLI call; pipelines and redirects never qualify."""
    try:
        parts = shlex.split(command) if isinstance(command, str) else []
        if len(parts) != len(_CLI_FETCH) + 1 or tuple(parts[:-1]) != _CLI_FETCH:
            return None
        url = json.loads(parts[-1]).get('url')
    except (ValueError, AttributeError):
        return None
    return url if isinstance(url, str) else None


def _cli_page_text(output):
    """Unwrap the JSON that the page-reader CLI prints into the shell tool result."""
    try:
        result = json.loads(output.get('result', '')) if isinstance(output, dict) else None
    except (TypeError, ValueError):
        return None
    if not isinstance(result, dict) or result.get('isError') or not isinstance(result.get('content'), list):
        return None
    return '\n'.join(item.get('text', '') for item in result['content']
                     if isinstance(item, dict) and item.get('type') == 'text')


def _page_output(event, commands):
    """Return page-reader output from the native MCP tool or its exact CLI equivalent."""
    if event.get('name') == NATIVE_FETCH_TOOL:
        output = event.get('output')
        return output if isinstance(output, str) else _cli_page_text(output), None
    requested = _cli_fetch_url((commands or {}).get(event.get('id')))
    return (_cli_page_text(event.get('output')), requested) if requested else (None, None)


def record_page_event(workspace, event, commands=None, fetched_at=None):
    """Capture real page-reader results from the bridge, never model prose.

    Shell tool updates identify a call only by id, so ``commands`` carries the
    command announced by that call's earlier event across the stream.
    """
    if event.get('type') != 'tool': return False
    command = (event.get('input') or {}).get('command') if isinstance(event.get('input'), dict) else None
    if commands is not None and command:
        commands[event.get('id')] = command
    if event.get('status') not in {'success', 'completed'}: return False
    output, requested = _page_output(event, commands)
    if not output: return False
    match = re.match(r'### Extracted content from: (https?://[^\s]+)\s*\n+(.*)', output, re.S)
    if not match or not match.group(2).strip(): return False
    url, text = match.group(1), match.group(2).strip()[:MAX_TEXT]
    if requested and requested != url: return False
    validate_public_url(url)
    record = {'version':1, 'kind':'web', 'url':url, 'requested_url':url,
              'title':urlsplit(url).hostname, 'text':text, 'truncated':True,
              'fetched_at':fetched_at or datetime.now(timezone.utc).isoformat(),
              'content_type':'text/plain', 'collector':'mcp_page_reader',
              'content_sha256':hashlib.sha256(text.encode()).hexdigest()}
    record['signature'] = _signature(record)
    path = Path(workspace) / 'research-sources' / (hashlib.sha256(url.encode()).hexdigest() + '.json')
    write_record(path, record, base=workspace)
    return True


def restore_recorded_pages(workspace, username, session_id):
    """Re-sign pages an earlier attempt already read so a resumed report does not pay again."""
    from app import job_queue
    with job_queue._connect() as db:
        rows = db.execute("""SELECT e.event,e.created_at FROM bob_job_events e JOIN bob_jobs j ON j.id=e.job_id
            WHERE j.username=%s AND j.workspace_id=%s AND j.payload ? 'research'
            AND e.event->>'type'='tool' AND e.event->>'phase'='Evidence' ORDER BY e.id""",
                          (username, session_id)).fetchall()
    commands, restored = {}, 0
    for row in rows:
        try:
            restored += record_page_event(workspace, row['event'], commands, row['created_at'].isoformat())
        except (ValueError, OSError):
            continue
    return restored


def write_record(path: str | Path, record: dict, *, base: str | Path | None = None) -> None:
    target = Path(path).resolve()
    if base is not None:
        base_resolved = Path(base).resolve()
        if not target.is_relative_to(base_resolved):
            raise ValueError(f'Research record path escapes workspace: {path}')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent,
                                         prefix='.research-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(record, output, ensure_ascii=False, indent=2)
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_verified_evidence(workspace: str | Path) -> list[dict]:
    root = Path(workspace).resolve()
    records, seen = [], set()
    for path in sorted(root.rglob('*.json')):
        try:
            if path.is_symlink() or not path.resolve().is_relative_to(root) or path.stat().st_size > MAX_BYTES:
                continue
            record = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(record, dict) or record.get('kind') not in {'web', 'knowledge', 'office'} or record.get('version') != 1:
                continue
            if not hmac.compare_digest(str(record.get('signature', '')), _signature(record)):
                continue
            text = record.get('text')
            if not isinstance(text, str) or not text or hashlib.sha256(text.encode()).hexdigest() != record.get('content_sha256'):
                continue
            if record['url'] in seen:
                continue
            seen.add(record['url'])
            record.pop('signature', None)
            record['id'] = f'S{len(records) + 1}'
            records.append(record)
        except (ValueError, OSError, KeyError, TypeError):
            continue
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--search')
    group.add_argument('--fetch')
    parser.add_argument('--output')
    args = parser.parse_args()
    try:
        if args.search:
            if os.getenv('BOB_MCP_SOCKET'):
                import asyncio
                from app.mcp_broker import request
                result = asyncio.run(request(os.environ['BOB_MCP_SOCKET'], {'action': 'call', 'server': 'brave_search', 'tool': 'brave_web_search', 'arguments': {'query': args.search, 'count': 8}}))
                if result.get('isError'):
                    raise ValueError('Web search failed or access was denied')
                results = '\n'.join(item.get('text', '') for item in result.get('content', []) if item.get('type') == 'text')
            elif os.getenv('BOB_KNOWLEDGE_SOCKET'):
                raise ValueError('Authenticated MCP gateway required for web search')
            else:
                results = brave_web_search(args.search, count=8)
            if results.startswith('Error:'):
                raise ValueError(results)
            record = {'kind': 'search_candidates', 'query': args.search, 'results': results,
                      'note': 'Search snippets are discovery only. Fetch pages before citing.'}
        else:
            record = fetch_source(args.fetch)
        if args.output:
            write_record(args.output, record)
        elif args.fetch:
            raise ValueError("Fetching evidence requires --output")
        print(json.dumps(record, ensure_ascii=False))
        return 0
    except (ValueError, OSError, httpx.HTTPError) as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())


async def collect_knowledge(workspace, username, query):
    """Snapshot only passages returned by the authenticated retrieval policy."""
    if not username:
        raise ValueError('Internal research requires an authenticated user')
    from app.rag import retrieve
    passages = await retrieve(username, 'shared', query[:2000])
    for passage in passages:
        text = passage['text'][:MAX_TEXT]
        record = {'version': 1, 'kind': 'knowledge',
                  'url': '/knowledge/' + str(passage['id']) + '/file',
                  'title': passage['filename'] + ' — ' + passage['location'],
                  'text': text, 'document_id': str(passage['id']),
                  'citation_id': passage['citation_id'],
                  'fetched_at': datetime.now(timezone.utc).isoformat(),
                  'content_sha256': hashlib.sha256(text.encode()).hexdigest()}
        record['signature'] = _signature(record)
        filename = 'knowledge-' + hashlib.sha256(str(passage['citation_id']).encode()).hexdigest() + '.json'
        write_record(Path(workspace) / 'research-sources' / filename, record, base=workspace)
    return len(passages)


def office_available(username):
    from app.mcp_access import get_authorized_server
    from app.microsoft_auth import _user_token_file
    from app import postgres_storage as storage
    if not get_authorized_server(username, 'microsoft365'):
        return False
    content = storage.read_user_file(_user_token_file(username))
    try:
        return bool(content and json.loads(content).get('access_token'))
    except (ValueError, TypeError):
        return False


def collect_office(workspace, username, query, timeout_seconds=90):
    """Read bounded OneDrive matches using the requesting user's token and access."""
    from app.mcp_access import get_authorized_server
    from app.microsoft_auth import _user_token_file
    from app.mcp_microsoft import _load_and_refresh_token, GRAPH_BASE
    from app.rag import extract, EXTENSIONS
    from urllib.parse import quote
    if not username or not get_authorized_server(username, 'microsoft365'):
        raise PermissionError('Microsoft research is not available for this user')
    import time
    deadline = time.monotonic() + min(180, max(1, timeout_seconds))
    def request_timeout():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('Office research collection reached its time budget')
        return min(30, remaining)
    token_file = _user_token_file(username)
    def headers():
        request_timeout()
        token = _load_and_refresh_token(token_file)
        if not token or not token.get('access_token'):
            raise PermissionError('Connect your Microsoft account before researching Office documents')
        return {'Authorization': 'Bearer ' + token['access_token']}
    # Search terms remain inside a single OData string literal and URL segment.
    terms = ' '.join(re.findall(r'[\w-]+', query)[:16])[:250]
    if not terms:
        return 0
    endpoint = GRAPH_BASE + "/me/drive/root/search(q='" + quote(terms.replace("'", "''"), safe='') + "')"
    count = 0
    with httpx.Client(timeout=30, trust_env=False) as client:
        response = client.get(endpoint, params={'$top': 6}, headers=headers(), timeout=request_timeout())
        response.raise_for_status()
        for item in response.json().get('value', [])[:6]:
            name = item.get('name', '')
            if 'file' not in item or Path(name).suffix.lower() not in EXTENSIONS or int(item.get('size', 0)) > MAX_BYTES:
                continue
            item_url = GRAPH_BASE + '/me/drive/items/' + quote(str(item['id']), safe='')
            # Recheck permission and current metadata for each candidate; search snippets are never evidence.
            if not get_authorized_server(username, 'microsoft365'):
                raise PermissionError('Microsoft research access was revoked')
            metadata = client.get(item_url, params={'$select':'id,name,size,webUrl,file'}, headers=headers(), timeout=request_timeout())
            metadata.raise_for_status()
            current = metadata.json()
            if 'file' not in current or int(current.get('size', 0)) > MAX_BYTES:
                continue
            name = current.get('name', name)
            if Path(name).suffix.lower() not in EXTENSIONS:
                continue
            chunks, size = [], 0
            # httpx strips Authorization when Microsoft redirects to another host.
            with client.stream('GET', item_url + '/content', headers=headers(), follow_redirects=True, timeout=request_timeout()) as download:
                download.raise_for_status()
                for chunk in download.iter_bytes():
                    request_timeout()
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError('Office document exceeds the 2 MB research limit')
                    chunks.append(chunk)
            request_timeout()
            content = b''.join(chunks)
            suffix = Path(name).suffix.lower()
            if suffix == '.pdf':
                import io
                from pypdf import PdfReader
                reader = PdfReader(io.BytesIO(content))
                if reader.is_encrypted or len(reader.pages) > 200:
                    continue
                sections = []
                extracted_size = 0
                for number, page in enumerate(reader.pages, 1):
                    request_timeout()
                    passage = page.extract_text() or ''
                    sections.append((f'page {number}', passage))
                    extracted_size += len(passage)
                    if extracted_size >= MAX_TEXT:
                        break
            elif suffix == '.docx':
                import io
                import zipfile
                from app.safe_xml import office_xml
                with zipfile.ZipFile(io.BytesIO(content)) as archive:
                    info = archive.getinfo('word/document.xml')
                    if info.file_size > 10 * MAX_BYTES:
                        continue
                    document = office_xml(archive.read(info))
                namespace = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
                passage = '\n'.join(''.join(node.itertext()) for node in document.iter(namespace + 'p'))
                sections = [('document', passage)]
            else:
                sections = extract(name, content)
            text = '\n\n'.join(f'{location}\n{passage}' for location, passage in sections).strip()[:MAX_TEXT]
            if not text:
                continue
            url = current.get('webUrl', '')
            if urlsplit(url).scheme != 'https':
                continue
            request_timeout()
            if not get_authorized_server(username, 'microsoft365'):
                raise PermissionError('Microsoft research access was revoked')
            record = {'version':1, 'kind':'office', 'url':url, 'title':name,
                      'text':text,'fetched_at':datetime.now(timezone.utc).isoformat(),
                      'content_sha256':hashlib.sha256(text.encode()).hexdigest()}
            record['signature'] = _signature(record)
            write_record(Path(workspace) / 'research-sources' / ('office-' + hashlib.sha256(url.encode()).hexdigest() + '.json'), record, base=workspace)
            count += 1
    return count
