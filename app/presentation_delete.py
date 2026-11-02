"""Delete presentation artifacts and remove their embedded conversation previews."""
import json
import re
from pathlib import PurePosixPath
from app import postgres_storage as storage


def _strip_source(text, html):
    def strip_block(match):
        language, body = match.group(1).lower(), match.group(2)
        if html and (language == 'html' or '<html' in body.lower()): return ''
        if not html and (language == 'bobdeck' or (language in ('json', '') and re.search(r'"slides"\s*:', body))): return ''
        return match.group(0)
    text = re.sub(r'```([^\n]*)\n([\s\S]*?)(?:\n```|$)', strip_block, text)
    if html:
        text = re.sub(r'<!doctype\s+html[\s\S]*?</html>|<html\b[\s\S]*?</html>', '', text, flags=re.I)
    else:
        decoder = json.JSONDecoder()
        for match in list(re.finditer(r'\{', text))[::-1]:
            try: deck, length = decoder.raw_decode(text[match.start():])
            except ValueError: continue
            if isinstance(deck, dict) and isinstance(deck.get('slides'), list):
                text = text[:match.start()] + text[match.start()+length:]
    return text.strip()


def _artifact_filename(deck):
    serialized = json.dumps(deck, ensure_ascii=False, separators=(',', ':'))
    value = 2166136261
    units = serialized.encode('utf-16-le')
    for index in range(0, len(units), 2):
        value = ((value ^ int.from_bytes(units[index:index+2], 'little')) * 16777619) & 0xffffffff
    return f'presentation-{value:x}.bobdeck'


def _inline_artifact_matches(content, paths):
    decoder = json.JSONDecoder()
    for match in re.finditer(r'\{', content):
        try: deck, _ = decoder.raw_decode(content[match.start():])
        except ValueError: continue
        if not isinstance(deck, dict) or not isinstance(deck.get('slides'), list): continue
        name = _artifact_filename(deck)
        if name in paths: return True
    return False


def delete_presentation(username, scope, path, session_id):
    extension = PurePosixPath(path).suffix.lower()
    html = extension in ('.html', '.htm')
    related = {path}
    if extension in ('.pptx', '.bobdeck'):
        related.update(str(PurePosixPath(path).with_suffix(suffix)) for suffix in ('.pptx', '.bobdeck'))
    with storage.mutation(username, scope, session_id) as db:
        if not html:
            source_files = db.execute('SELECT content,sha256,object_key,object_bucket,size FROM bob_storage_files WHERE username=%s AND scope=%s AND path=ANY(%s)', (username, scope, list(related))).fetchall()
            for source_file in source_files:
                try:
                    deck = json.loads(storage.blob_storage.read(source_file))
                    if isinstance(deck, dict) and isinstance(deck.get('slides'), list): related.add(_artifact_filename(deck))
                except (ValueError, UnicodeDecodeError): pass
        removed = db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s AND path=ANY(%s) RETURNING path',
                             (username, scope, list(related))).fetchall()
        if not removed: return False
        if scope.startswith('project:'):
            conversations = db.execute("SELECT id FROM bob_conversations WHERE username=%s AND record->>'project_id'=%s", (username,scope.split(':',1)[1])).fetchall()
            ids = [row['id'] for row in conversations]
        else:
            sid = session_id or (scope.split(':', 1)[1] if scope.startswith('session:') else None)
            ids = [sid] if sid else []
        for conversation in ids:
            rows = db.execute('SELECT id,event FROM bob_conversation_history WHERE username=%s AND session_id=%s ORDER BY id', (username,conversation)).fetchall()
            batches = []
            current = []
            for row in rows:
                if row['event'].get('type') == 'request':
                    if current: batches.append(current)
                    current = []
                current.append(row)
            if current: batches.append(current)
            for batch in batches:
                request = next((row for row in batch if row['event'].get('type') == 'request'), None)
                deltas = [row for row in batch if row['event'].get('type') == 'delta']
                content = ''
                for row in deltas:
                    event = row['event']
                    content = event.get('text', '') if event.get('replace') else content + event.get('text', '')
                defaults = {'presentation.html', 'presentation.htm'} if html else {'presentation.bobdeck', 'presentation.pptx'}
                request_event = request['event'] if request else {}
                is_html_request = (
                    request_event.get('presentation_format') == 'html'
                    or request_event.get('skill_name') in {'interactive-presentations', 'presentation-buddy'}
                    or (request_event.get('mode') == 'presentation' and 'html' in str(request_event.get('prompt', '')).lower())
                )
                matching_mode = request_event.get('mode') == 'presentation' and (is_html_request == html)
                inline = ('<html' in content.lower() or '```html' in content.lower()) if html else bool(re.search(r'```bobdeck|"slides"\s*:', content))
                batch_text = json.dumps([r['event'] for r in batch])
                matches = any(name in batch_text for name in related) or (not html and _inline_artifact_matches(content, related)) or (path in defaults and (matching_mode or inline))
                if not matches: continue
                if not html:
                    decoder = json.JSONDecoder()
                    for opening in re.finditer(r'\{', content):
                        try: deck, _ = decoder.raw_decode(content[opening.start():])
                        except ValueError: continue
                        if isinstance(deck, dict) and isinstance(deck.get('slides'), list):
                            db.execute('DELETE FROM bob_storage_files WHERE username=%s AND scope=%s AND path=%s', (username,scope,_artifact_filename(deck)))
                clean = _strip_source(content, html)
                if request:
                    event = dict(request_event)
                    event['deleted_presentations'] = sorted(set(event.get('deleted_presentations', [])) | related)
                    db.execute('UPDATE bob_conversation_history SET event=%s::jsonb WHERE id=%s', (json.dumps(event),request['id']))
                for index, row in enumerate(deltas):
                    event = dict(row['event'])
                    event['text'] = clean if index == 0 else ''
                    if index == 0: event['replace'] = True
                    event['presentation_deleted'] = True
                    db.execute('UPDATE bob_conversation_history SET event=%s::jsonb WHERE id=%s', (json.dumps(event),row['id']))
        # Completed task results carry the same streamed source. Remove it too.
        jobs = db.execute("SELECT id,payload FROM bob_jobs WHERE username=%s AND workspace_id=ANY(%s) AND status NOT IN ('queued','running')", (username, ids)).fetchall()
        for job in jobs:
            events = db.execute('SELECT id,event FROM bob_job_events WHERE job_id=%s ORDER BY id', (job['id'],)).fetchall()
            deltas = [row for row in events if row['event'].get('type') == 'delta']
            content = ''
            for row in deltas:
                event = row['event']
                content = event.get('text', '') if event.get('replace') else content + event.get('text', '')
            job_payload = job['payload'] or {}
            is_job_html = (
                job_payload.get('presentation_format') == 'html'
                or job_payload.get('skill_name') in {'interactive-presentations', 'presentation-buddy'}
                or (job_payload.get('mode') == 'presentation' and 'html' in str(job_payload.get('prompt', '')).lower())
            )
            mode_match = job_payload.get('mode') == 'presentation' and path in ({'presentation.html', 'presentation.htm'} if html else {'presentation.bobdeck', 'presentation.pptx'}) and (is_job_html == html)
            job_text = json.dumps([r['event'] for r in events])
            if not (any(name in job_text for name in related) or _inline_artifact_matches(content, related) or mode_match): continue
            clean = _strip_source(content, html)
            for index, row in enumerate(deltas):
                event = dict(row['event'])
                event['text'] = clean if index == 0 else ''
                if index == 0: event['replace'] = True
                db.execute('UPDATE bob_job_events SET event=%s::jsonb WHERE id=%s', (json.dumps(event),row['id']))
        return True
