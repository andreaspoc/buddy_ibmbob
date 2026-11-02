"""Owner-scoped, bounded downloads of saved notes."""
from app.branding import brand_text
import html
import os
import re
import json
from urllib.parse import urlsplit
from typing import Literal

from pydantic import BaseModel, Field, field_validator
from app import email_review, smtp_settings

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from app.auth import current_user
from app import job_queue, notes

router = APIRouter(prefix='/api/notes', tags=['notes'])
EXPORT_LABELS = {
    'en': {'saved':'Saved notes', 'sources':'Sources', 'tags':'Tags', 'inbox':'Inbox'},
    'el': {'saved':'Αποθηκευμένες σημειώσεις', 'sources':'Πηγές', 'tags':'Ετικέτες', 'inbox':'Εισερχόμενα'},
    'hi': {'saved':'सहेजे गए नोट्स', 'sources':'स्रोत', 'tags':'टैग', 'inbox':'इनबॉक्स'},
    'mt': {'saved':'Noti ssejvjati', 'sources':'Sorsi', 'tags':'Tikketti', 'inbox':'Inbox'},
}


def metadata(row, field):
    value = row.get(field) or []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return value if isinstance(value, list) else []


def safe_url(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        return parsed.scheme in ('https', 'http') and bool(parsed.netloc) and not any(ord(c) < 32 for c in value)
    except ValueError:
        return False


def source_links(row):
    return [source for source in metadata(row, 'sources') if isinstance(source, dict) and safe_url(source.get('url'))]


def printable_body(body):
    """Keep readable Markdown and make real HTTP source links clickable safely."""
    parts, start = [], 0
    for match in re.finditer(r'\[([^\]\n]{1,300})\]\((https?://[^\s)]+)\)', body):
        parts.append(html.escape(body[start:match.start()]))
        label, url = match.groups()
        parts.append('<a href="' + html.escape(url, quote=True) + '">' + html.escape(label) + '</a>'
                     if safe_url(url) else html.escape(match.group()))
        start = match.end()
    parts.append(html.escape(body[start:]))
    return ''.join(parts)


def select_notes(username, ids=None, collections=None):
    notes.ensure_schema()
    selected = []
    if ids is not None:
        if not re.fullmatch(r'[1-9]\d*(?:,[1-9]\d*)*', ids):
            raise HTTPException(422, 'Supply comma-separated positive note IDs')
        selected = list(dict.fromkeys(int(value) for value in ids.split(',')))
        if any(value > 9223372036854775807 for value in selected):
            raise HTTPException(422, 'Invalid note ID')
        if len(selected) > 100:
            raise HTTPException(422, 'Export up to 100 notes at a time')
    if collections and (len(collections) > 100 or any(len(value) > 80 for value in collections)):
        raise HTTPException(422, 'Invalid collection selection')
    query = 'SELECT * FROM bob_notes WHERE username=%s'
    params = [username]
    if selected:
        query += ' AND id = ANY(%s)'
        params.append(selected)
    if collections:
        query += ' AND collection = ANY(%s)'
        params.append(collections)
    query += ' ORDER BY collection, id LIMIT 101'
    with job_queue._connect() as db:
        rows = db.execute(query, tuple(params)).fetchall()
    if selected and len(rows) != len(selected):
        raise HTTPException(404, 'One or more selected notes were not found')
    if not rows:
        raise HTTPException(404, 'No notes found for this export')
    if len(rows) > 100:
        raise HTTPException(422, 'This selection contains more than 100 notes. Select fewer notes or collections.')
    return rows


def markdown_document(rows, language='en'):
    labels = EXPORT_LABELS[language]
    sections = ['# ' + labels['saved']]
    previous = None
    for row in rows:
        collection = row.get('collection') or labels['inbox']
        if collection != previous:
            sections.append('## ' + collection.replace('\n', ' '))
            previous = collection
        detail = '### ' + row['title'].replace('\n', ' ') + '\n\n' + row['body']
        tags = [tag for tag in metadata(row, 'tags') if isinstance(tag, str)]
        if tags:
            detail += '\n\n' + labels['tags'] + ': ' + ', '.join(tags)
        sources = source_links(row)
        if sources:
            detail += '\n\n' + labels['sources'] + ':\n' + '\n'.join('- [' + str(source.get('title') or source['url']).replace(']', '\\]') + '](' + source['url'].replace(')', '%29') + ')' for source in sources)
        sections.append(detail)
    return '\n\n'.join(sections) + '\n'


async def pdf_document(rows, language='en', *, document_title=None):
    from playwright.async_api import async_playwright
    # Escape every source character. PDF uses readable text and never executes or
    # loads note HTML, images, CSS, or linked resources.
    labels = EXPORT_LABELS[language]
    sections = ''.join('<section><p class="collection">' + html.escape(row.get('collection') or labels['inbox']) +
                       '</p><h2>' + html.escape(row['title']) + '</h2><pre>' +
                       printable_body(row['body']) + '</pre>' +
                       ('<p>' + html.escape(labels['tags']) + ': ' + html.escape(', '.join(tag for tag in metadata(row, 'tags') if isinstance(tag, str))) + '</p>' if metadata(row, 'tags') else '') +
                       ('<h3>' + html.escape(labels['sources']) + '</h3>' if source_links(row) else '') +
                       ''.join('<p><a href="' + html.escape(source['url'], quote=True) + '">' + html.escape(str(source.get('title') or source['url'])) + '</a></p>' for source in source_links(row)) +
                       '</section>' for row in rows)
    title = document_title if document_title is not None else labels['saved']
    document = ('<!doctype html><html lang="' + language + brand_text('"><meta charset="utf-8"><style>'
                '@page{size:A4;margin:20mm}body{font:12px Arial,sans-serif;color:#292334}'
                '.brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:#fff}'
                '.brand svg{width:25px;height:25px;fill:#d8aeff}.brand span{color:#d8aeff}'
                'header{background:linear-gradient(120deg,#30104d,#482064);padding:22px 24px;border-radius:12px}'
                'h1{color:#fff;font-size:25px;line-height:1.3;margin:16px 0 0;overflow-wrap:anywhere}'
                'h2{font-size:18px;color:#30104d}a{color:#7b00e0}'
                'pre{font:12px Arial,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}'
                '.collection{color:#7b00e0;font-size:10px}section{border-top:1px solid #dccbea;padding-top:12px;margin-top:24px}'
                'h2,header{break-after:avoid}</style><header><div class="brand">'
                '<svg viewBox="0 0 48 46" aria-hidden="true"><path d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z"/></svg>'
                '<div>Buddy</div></div><h1>') + html.escape(title) + '</h1></header>' + sections + '</html>')
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('RESEARCH_CHROMIUM_PATH', '/usr/bin/chromium'),
                                                headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            context = await browser.new_context(java_script_enabled=False)
            await context.route('**/*', lambda route: route.abort())
            page = await context.new_page()
            await page.set_content(document, wait_until='domcontentloaded')
            return await page.pdf(format='A4', print_background=True)
        finally:
            await browser.close()


@router.get('/export')
async def export_notes(format: Literal['markdown', 'pdf'] = 'markdown', ids: str | None = Query(default=None, max_length=2400),
                       collection: list[str] | None = Query(default=None), language: Literal['en','el','hi','mt'] = 'en', user: dict = Depends(current_user)):
    # DB calls remain short and bounded; move them off the event loop.
    from starlette.concurrency import run_in_threadpool
    rows = await run_in_threadpool(select_notes, user['username'], ids, collection)
    if format == 'markdown':
        content, media_type, suffix = markdown_document(rows, language).encode('utf-8'), 'text/markdown; charset=utf-8', 'md'
    else:
        try:
            from app.visual_document_export import render_document
            content = await render_document(EXPORT_LABELS[language]['saved'], markdown_document(rows, language), 'pdf')
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, 'PDF export is temporarily unavailable. Try Markdown export.') from exc
        media_type, suffix = 'application/pdf', 'pdf'
    return Response(content, media_type=media_type, headers={
        'Content-Disposition': f'attachment; filename="saved-notes.{suffix}"',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


class NoteEmail(BaseModel):
    to: str = Field(max_length=254)
    personal_data_confirmed: bool = False

    @field_validator('to')
    @classmethod
    def valid_recipient(cls, value):
        return smtp_settings.address(value)


@router.post('/{note_id}/email')
def email_note(note_id: int, body: NoteEmail, user: dict = Depends(current_user)):
    rows = select_notes(user['username'], str(note_id))
    row = rows[0]
    title = re.sub(r'[\r\n\x00]+', ' ', row['title']).strip() or 'Note'
    filename = re.sub(r'[^\w .-]', '_', title)[:120].strip(' .') or 'note'
    document = markdown_document([{**row, 'collection': ''}]).split('\n\n', 2)[2]
    document = '# ' + document.removeprefix('### ')
    try:
        message = email_review.send_reviewed(
            user['username'], smtp_settings.load_config(), body.to, title,
            'Your note is attached as a Markdown file.\n\n'
            'On an iPhone with iOS 26 or later, hold the attachment, then choose Share → Notes → Save.\n\n'
            + row['body'], confirmed=body.personal_data_confirmed, markdown_attachment=(filename + '.md', document))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {'message': message}
