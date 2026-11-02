"""Authenticated, ephemeral comparisons with citations to extracted source lines."""
from __future__ import annotations

from difflib import SequenceMatcher
from pathlib import Path
import io
import zipfile
from app.safe_xml import office_xml

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from app.auth import current_user

router = APIRouter(tags=['document comparison'])
MAX_BYTES = 25 * 1024 * 1024
MAX_LINES = 6000
SUPPORTED = {'.pdf', '.docx', '.md', '.txt'}


def source_lines(filename, sections):
    rows = []
    for location, text in sections:
        for number, line in enumerate(text.splitlines(), 1):
            if line.strip():
                rows.append({'text': line, 'source': filename, 'location': location, 'line': number})
            if len(rows) > MAX_LINES:
                raise ValueError('Compare smaller documents with at most 6,000 non-empty lines each')
    if not rows:
        raise ValueError('Both documents must contain readable text')
    return rows


def compare_sections(before_name, before_sections, after_name, after_sections):
    before = source_lines(before_name, before_sections)
    after = source_lines(after_name, after_sections)
    matcher = SequenceMatcher(None, [r['text'] for r in before], [r['text'] for r in after], autojunk=False)
    changes = []
    counts = {'added_lines': 0, 'removed_lines': 0, 'unchanged_lines': 0}
    for kind, start, end, new_start, new_end in matcher.get_opcodes():
        if kind == 'equal':
            counts['unchanged_lines'] += end - start
            continue
        counts['removed_lines'] += end - start
        counts['added_lines'] += new_end - new_start
        changes.append({'kind': {'replace': 'modified', 'delete': 'removed', 'insert': 'added'}[kind],
                        'before': before[start:end], 'after': after[new_start:new_end]})
    return {'before_name': before_name, 'after_name': after_name, 'summary': counts,
            'changes': changes, 'method': 'Extracted text comparison; empty lines are ignored. Formatting and images are not compared.'}


async def read_document(file):
    name = Path((file.filename or '').replace('\\', '/')).name
    if Path(name).suffix.lower() not in SUPPORTED:
        raise HTTPException(422, 'Choose PDF, DOCX, Markdown or text documents')
    content = await file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise HTTPException(413, 'Each document must be 25 MB or smaller')
    if not content:
        raise HTTPException(422, 'Both documents must contain readable text')
    return name, content


def extract_and_compare(before_name, before_content, after_name, after_content):
    return compare_sections(before_name, extract_document(before_name, before_content),
                            after_name, extract_document(after_name, after_content))


def extract_document(name, content):
    """Use bounded lightweight extraction in the API; OCR remains a worker feature."""
    suffix = Path(name).suffix.lower()
    if suffix == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            raise ValueError('Upload an unlocked PDF')
        if len(reader.pages) > 500:
            raise ValueError('PDFs are limited to 500 pages')
        sections = [(f'page {number}', page.extract_text() or '') for number, page in enumerate(reader.pages, 1)]
    elif suffix == '.docx':
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 100 * 1024 * 1024:
                raise ValueError('The expanded DOCX exceeds 100 MB')
            if archive.getinfo('word/document.xml').file_size > 10 * 1024 * 1024:
                raise ValueError('The DOCX text exceeds 10 MB')
            root = office_xml(archive.read('word/document.xml'))
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        sections = [(f'paragraph {number}', ''.join(node.text or '' for node in paragraph.findall('.//w:t', ns)))
                    for number, paragraph in enumerate(root.findall('.//w:p', ns), 1)]
    else:
        sections = [('text', content.decode('utf-8-sig'))]
    if sum(len(text) for _, text in sections) > 1_000_000:
        raise ValueError('The extracted document exceeds 1 million characters')
    if not any(text.strip() for _, text in sections):
        raise ValueError('No readable text found. Scanned PDFs need OCR before comparison; upload a text-searchable copy.')
    return sections


@router.post('/documents/compare')
async def compare_documents(before: UploadFile = File(...), after: UploadFile = File(...), user: dict = Depends(current_user)):
    before_name, before_content = await read_document(before)
    after_name, after_content = await read_document(after)
    try:
        return await run_in_threadpool(extract_and_compare, before_name, before_content, after_name, after_content)
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception('Document comparison extraction failed')
        raise HTTPException(422, 'Unable to extract both documents. Upload readable, unlocked PDF, DOCX or UTF-8 text files.') from exc
