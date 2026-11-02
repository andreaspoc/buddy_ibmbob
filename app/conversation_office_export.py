"""Export the owner's saved conversation snapshot without inventing live content."""
from app.branding import brand_text
import re

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app import sessions

MAX_TURNS = 100
MAX_CHARACTERS = 200000


def saved_chat(username, workspace_id, content="conversation"):
    if content not in ("conversation", "latest_answer"):
        raise HTTPException(422, "Choose conversation or latest_answer")
    try:
        record = sessions.get_session(workspace_id, username)
        events = sessions.read_history(workspace_id, username)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, 'Conversation not found') from None
    if record.get('purpose') == 'note_enrichment':
        raise HTTPException(422, 'Select a regular conversation to export')
    turns = []
    current = None
    for event in events:
        kind = event.get('type')
        if kind == 'request':
            if content == "conversation" and len(turns) >= MAX_TURNS:
                raise HTTPException(413, 'Export supports up to 100 saved conversation turns')
            prompt = '' if event.get('user_deleted') else event.get('display_prompt') or event.get('prompt') or ''
            current = {'prompt': prompt if isinstance(prompt, str) else '', 'answer': '', 'status': 'completed' if event.get('assistant_deleted') else 'unfinished', 'assistant_deleted': bool(event.get('assistant_deleted'))}
            turns.append(current)
        elif current is not None and not current['assistant_deleted'] and kind == 'delta' and isinstance(event.get('text'), str):
            current['answer'] = event['text'] if event.get('replace') else current['answer'] + event['text']
        elif current is not None and kind in ('done', 'error'):
            current['status'] = 'completed' if kind == 'done' else 'interrupted'
    turns = [turn for turn in turns if turn['prompt'] or turn['answer']]
    if not turns:
        raise HTTPException(422, 'This conversation has no saved messages to export')
    if content == "latest_answer":
        answer = next((turn for turn in reversed(turns) if turn['status'] == 'completed' and turn['answer'].strip()), None)
        if answer is None:
            raise HTTPException(422, 'No completed saved answer is available to export')
        turns = [answer]
    if sum(len(turn['prompt']) + len(turn['answer']) for turn in turns) > MAX_CHARACTERS:
        raise HTTPException(413, 'Saved conversation exceeds the 200,000 character export limit')
    title = record.get('title') or 'Conversation'
    if content == 'latest_answer':
        sections = [turns[0]['answer']]
    else:
        sections = ['Saved conversation snapshot. Only persisted messages are included; live changes after this export are not included.']
        for index, turn in enumerate(turns, 1):
            if turn['prompt']:
                sections.extend([f'## Turn {index} — You', turn['prompt']])
            if turn['answer']:
                label = brand_text('Buddy') if turn['status'] == 'completed' else brand_text('Buddy — saved partial response (') + turn['status'] + ')'
                sections.extend(['### ' + label, turn['answer']])
            elif turn['status'] != 'completed':
                sections.append('No saved response. This turn is ' + turn['status'] + '.')
    sections.append('Source conversation: /?conversation=' + workspace_id)
    return {'id': workspace_id, 'title': title[:200], 'body': '\n\n'.join(sections), 'collection': 'Conversation export'}


async def export_chat(username, workspace_id, format, *, content='conversation'):
    if format not in ('docx', 'pdf'):
        raise HTTPException(422, 'Choose docx or pdf for conversation export')
    row = await run_in_threadpool(saved_chat, username, workspace_id, content)
    name = re.sub(r'[^\w .-]', '_', row['title']).strip(' .')[:120] or 'Conversation'
    if content == 'latest_answer':
        name += ' - answer'
    from app.visual_document_export import render_document
    raw = await render_document(row['title'], row['body'], format)
    return name + '.' + format, raw
