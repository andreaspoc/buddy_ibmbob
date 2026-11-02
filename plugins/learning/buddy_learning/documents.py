"""Convert supported uploads to the inert Learning reader chapter contract.

This reader extracts text and tables; it never starts Office, fetches linked
resources, executes macros, or claims to preserve source document layout.
"""
from __future__ import annotations

import csv
import base64
import zlib
import html
import io
import re
import stat
from pathlib import PurePath, PurePosixPath
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

from .epub import MAX_UPLOAD, MAX_EXPANDED, MAX_ENTRY, MAX_ENTRIES, _xml, _local_path, parse_epub

supported_extensions = frozenset({'epub', 'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'html', 'htm', 'txt', 'md'})
MAX_TEXT = 1_000_000
MAX_CHAPTERS = 500
MAX_SHEET_ROWS = 5000
MAX_SHEET_COLUMNS = 50


def _text(raw):
    if b'\x00' in raw:
        raise ValueError('Upload a UTF-8 text document without binary content')
    try:
        return raw.decode('utf-8-sig')
    except UnicodeError:
        raise ValueError('Text documents must use UTF-8 encoding') from None


def _package(raw):
    if not raw.startswith(b'PK\x03\x04'):
        raise ValueError('The uploaded file does not match its Office document extension')
    try:
        archive = ZipFile(io.BytesIO(raw))
        entries = archive.infolist()
        if len(entries) > MAX_ENTRIES:
            raise ValueError('Document contains too many archive entries')
        names, total = set(), 0
        for entry in entries:
            path, mode = PurePosixPath(entry.filename), entry.external_attr >> 16
            if (not entry.filename or entry.filename.startswith('/') or '\\' in entry.filename or
                    '..' in path.parts or any(ord(c) < 32 for c in entry.filename) or
                    str(path) != entry.filename.rstrip('/') or entry.filename in names or stat.S_ISLNK(mode)):
                raise ValueError('Document contains an unsafe or duplicate archive path')
            names.add(entry.filename)
            total += entry.file_size
            if entry.flag_bits & 1:
                raise ValueError('Encrypted documents are not supported')
            if entry.file_size > MAX_ENTRY or total > MAX_EXPANDED:
                raise ValueError('Document expanded content exceeds the reader limits')
            if entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 250:
                raise ValueError('Document archive compression ratio exceeds the reader limits')
        # Preflight ALL XML before a third-party reader can parse entities/DTDs.
        for entry in entries:
            if entry.filename.endswith(('.xml', '.rels')) and not entry.is_dir():
                _xml(archive.read(entry.filename))
        if '[Content_Types].xml' not in names:
            raise ValueError('Office document is missing its package content types')
        return archive
    except (BadZipFile, KeyError, RuntimeError, NotImplementedError):
        if 'archive' in locals():
            archive.close()
        raise ValueError('Upload a valid, unencrypted Office document') from None
    except Exception:
        if 'archive' in locals():
            archive.close()
        raise


def _require_type(archive, extension):
    expected = {
        'docx': ('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
        'pptx': ('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),
        'xlsx': ('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),
    }[extension]
    root = _xml(archive.read('[Content_Types].xml'))
    matches = [item for item in root.findall('{*}Override') if item.get('PartName', '').lstrip('/') == expected[0]]
    if len(matches) != 1 or matches[0].get('ContentType') != expected[1] or expected[0] not in archive.namelist():
        raise ValueError('The Office package does not match the uploaded filename extension')


def _part(base, target):
    if not target or urlsplit(target).scheme or urlsplit(target).netloc:
        raise ValueError('External document relationships are not supported')
    path = _local_path('', target[1:]) if target.startswith('/') else _local_path(base, target)
    if not path:
        raise ValueError('Document contains an unsafe relationship target')
    return path


def _paragraph(value):
    return '<p>' + html.escape(value).replace('\n', '<br>') + '</p>'


def _table(rows):
    return '<table><tbody>' + ''.join('<tr>' + ''.join('<td>' + html.escape(str(value or '')) + '</td>' for value in row) + '</tr>' for row in rows) + '</tbody></table>'


def _book(title, chapters, author=''):
    if not chapters or len(chapters) > MAX_CHAPTERS:
        raise ValueError('Document needs between 1 and 500 readable sections')
    total = sum(len(body) for _, body in chapters)
    if total > MAX_TEXT * 6:
        # Escaping can increase text up to sixfold; the final plaintext budget is
        # enforced below independently of HTML serialization overhead.
        raise ValueError('Document text exceeds the reader limit of 1,000,000 characters')
    text_total = sum(len(html.unescape(re.sub('<[^>]+>', '', body))) for _, body in chapters)
    if text_total > MAX_TEXT:
        raise ValueError('Document text exceeds the reader limit of 1,000,000 characters')
    assets, entries = {}, []
    for index, (label, body) in enumerate(chapters):
        path = f'document/section-{index}.xhtml'
        entries.append({'id': str(index), 'title': label[:300], 'path': path})
        content = ('<html><body>' + body + '</body></html>').encode('utf-8')
        if len(content) > MAX_ENTRY:
            raise ValueError('A document section exceeds the reader size limit')
        assets[path] = {'content': content, 'media_type': 'application/xhtml+xml'}
    return {'title': title[:300], 'author': author[:300], 'chapters': entries, 'assets': assets}


def _docx(archive, title):
    root = _xml(archive.read('word/document.xml'))
    body = root.find('{*}body')
    if body is None:
        raise ValueError('Word document has no readable body')
    chapters, content, label = [], [], 'Word document'
    for child in body:
        kind = child.tag.rsplit('}', 1)[-1]
        if kind == 'p':
            value = ''.join(node.text or '' for node in child.iter() if node.tag.rsplit('}', 1)[-1] == 't')
            style = child.find('./{*}pPr/{*}pStyle')
            style_name = next(iter(style.attrib.values()), '') if style is not None else ''
            if value.strip() and re.fullmatch(r'(?i)(?:heading|title)\s*1?', style_name):
                if content:
                    chapters.append((label, ''.join(content)))
                label, content = value.strip(), ['<h1>' + html.escape(value) + '</h1>']
            elif value:
                content.append(_paragraph(value))
        elif kind == 'tbl':
            rows = []
            for row in child.findall('{*}tr'):
                rows.append([' '.join(node.text or '' for node in cell.iter() if node.tag.rsplit('}', 1)[-1] == 't') for cell in row.findall('{*}tc')])
            content.append(_table(rows))
    if content:
        chapters.append((label, ''.join(content)))
    if not chapters:
        raise ValueError('Word document contains no extractable text')
    return _book(title, chapters)


def _pptx(archive, title):
    root = _xml(archive.read('ppt/presentation.xml'))
    relationships = _xml(archive.read('ppt/_rels/presentation.xml.rels'))
    targets = {}
    for rel in relationships:
        if rel.get('Type', '').endswith('/slide'):
            if rel.get('TargetMode') == 'External':
                raise ValueError('External presentation slides are not supported')
            targets[rel.get('Id')] = _part('ppt/presentation.xml', rel.get('Target', ''))
    chapters = []
    ids = root.findall('./{*}sldIdLst/{*}sldId')
    if len(ids) > MAX_CHAPTERS:
        raise ValueError('Presentations may contain at most 500 slides')
    for index, slide in enumerate(ids):
        reference = next((v for k, v in slide.attrib.items() if k.endswith('}id')), None)
        path = targets.get(reference)
        if not path or path not in archive.namelist():
            raise ValueError('Presentation contains an invalid slide relationship')
        data = _xml(archive.read(path))
        paragraphs = [''.join(n.text or '' for n in p.findall('.//{*}t')) for p in data.findall('.//{*}p')]
        label = f'Slide {index + 1}'
        chapters.append((label, '<h1>' + label + '</h1>' + ''.join(_paragraph(p) for p in paragraphs if p)))
    return _book(title, chapters)


def _xlsx(raw, title):
    from openpyxl import load_workbook
    try:
        workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True, keep_links=False)
    except Exception:
        raise ValueError('Upload a valid Excel workbook') from None
    try:
        if len(workbook.worksheets) > MAX_CHAPTERS:
            raise ValueError('Workbook contains too many sheets')
        chapters, total = [], 0
        for sheet in workbook.worksheets:
            if (sheet.max_row or 0) > MAX_SHEET_ROWS or (sheet.max_column or 0) > MAX_SHEET_COLUMNS:
                raise ValueError('Readable spreadsheets are limited to 5,000 rows and 50 columns per sheet')
            rows = []
            for row in sheet.iter_rows(values_only=True):
                values = [str(value) if value is not None else '' for value in row]
                total += sum(len(value) for value in values)
                if total > MAX_TEXT or len(rows) >= MAX_SHEET_ROWS or len(values) > MAX_SHEET_COLUMNS:
                    raise ValueError('Workbook exceeds the readable spreadsheet limits')
                rows.append(values)
            chapters.append((sheet.title, '<h1>' + html.escape(sheet.title) + '</h1>' + _table(rows)))
        return _book(title, chapters)
    finally:
        workbook.close()


def _bounded_pdf_stream(stream, budget):
    """Check decompressed PDF text resources before pypdf allocates their output."""
    data = stream.get_object()._data
    filters = stream.get('/Filter', [])
    if isinstance(filters, str):
        filters = [filters]
    for filter_name in filters:
        if filter_name in ('/FlateDecode', '/Fl'):
            decoder = zlib.decompressobj()
            try:
                data = decoder.decompress(data, MAX_ENTRY + 1)
            except zlib.error:
                raise ValueError('PDF contains an invalid compressed text stream') from None
            if decoder.unconsumed_tail:
                raise ValueError('PDF page content exceeds the reader size limit')
        elif filter_name in ('/ASCII85Decode', '/A85'):
            data = base64.a85decode(data, adobe=data.rstrip().endswith(b'~>'))
        elif filter_name in ('/ASCIIHexDecode', '/AHx'):
            value = re.sub(br'\s+', b'', data).rstrip(b'>')
            if len(value) % 2:
                value += b'0'
            data = bytes.fromhex(value.decode('ascii'))
        else:
            raise ValueError('PDF text uses an unsupported compression format')
        if len(data) > MAX_ENTRY:
            raise ValueError('PDF page content exceeds the reader size limit')
    if len(data) > MAX_ENTRY:
        raise ValueError('PDF page content exceeds the reader size limit')
    budget[0] += len(data)
    if budget[0] > MAX_EXPANDED:
        raise ValueError('PDF expanded text resources exceed the reader size limit')
    return len(data)


def _bounded_pdf_resources(resources, seen, budget, depth=0):
    if depth > 8:
        raise ValueError('PDF resources exceed the reader nesting limit')
    if resources is None:
        return
    resources = resources.get_object()
    fonts = resources.get('/Font', {})
    fonts = fonts.get_object() if hasattr(fonts, 'get_object') else fonts
    for font in fonts.values():
        mapping = font.get_object().get('/ToUnicode')
        if mapping is not None:
            _bounded_pdf_stream(mapping.get_object(), budget)
    objects = resources.get('/XObject', {})
    objects = objects.get_object() if hasattr(objects, 'get_object') else objects
    for ref in objects.values():
        obj = ref.get_object()
        if obj.get('/Subtype') != '/Form' or id(obj) in seen:
            continue
        seen.add(id(obj))
        _bounded_pdf_stream(obj, budget)
        _bounded_pdf_resources(obj.get('/Resources'), seen, budget, depth + 1)


def parse_document(raw: bytes, name: str) -> dict:
    extension = PurePath(name).suffix.lower().lstrip('.')
    if extension in {'doc', 'ppt', 'xls'}:
        raise ValueError('Convert legacy Office files to DOCX, PPTX, or XLSX before uploading')
    if extension not in supported_extensions:
        raise ValueError('Unsupported document format')
    if not raw or len(raw) > MAX_UPLOAD:
        raise ValueError('Upload a document no larger than 50 MB')
    title = PurePath(name).stem[:300] or 'Untitled document'
    if extension == 'epub':
        return parse_epub(raw)
    if extension == 'pdf':
        if not raw.startswith(b'%PDF-'):
            raise ValueError('The uploaded file does not match its PDF extension')
        from pypdf import PdfReader
        try:
            reader = PdfReader(io.BytesIO(raw))
            if reader.is_encrypted:
                raise ValueError('Encrypted PDFs are not supported')
            if len(reader.pages) > MAX_CHAPTERS:
                raise ValueError('PDFs may contain at most 500 pages')
            chapters, found, total = [], False, 0
            pdf_budget = [0]
            for index, page in enumerate(reader.pages):
                content = page.get('/Contents')
                # pypdf extraction can expand compressed content streams; cap
                # their declared archive-independent output before text parsing.
                if content is not None:
                    stream = content.get_object()
                    streams = stream if isinstance(stream, list) else [stream]
                    if sum(_bounded_pdf_stream(item.get_object(), pdf_budget) for item in streams) > MAX_ENTRY:
                        raise ValueError('PDF page content exceeds the reader size limit')
                _bounded_pdf_resources(page.get('/Resources'), set(), pdf_budget)
                text = page.extract_text() or ''
                total += len(text)
                if total > MAX_TEXT:
                    raise ValueError('PDF text exceeds the reader limit of 1,000,000 characters')
                found = found or bool(text.strip())
                chapters.append((f'Page {index + 1}', _paragraph(text if text.strip() else '[No extractable text on this page; OCR is required.]')))
            if not found:
                raise ValueError('This PDF has no extractable text. Scanned PDFs need OCR before upload.')
            metadata_title = str(reader.metadata.title) if reader.metadata and reader.metadata.title else title
            return _book(metadata_title, chapters)
        except ValueError:
            raise
        except Exception:
            raise ValueError('Upload a valid, unencrypted PDF document') from None
    if extension in {'docx', 'pptx', 'xlsx'}:
        try:
            with _package(raw) as archive:
                _require_type(archive, extension)
                if extension == 'docx':
                    return _docx(archive, title)
                if extension == 'pptx':
                    return _pptx(archive, title)
            return _xlsx(raw, title)
        except (KeyError, BadZipFile):
            raise ValueError('Upload a valid Office document matching its filename extension') from None
    if raw.startswith((b'PK\x03\x04', b'%PDF-', b'\xd0\xcf\x11\xe0')):
        raise ValueError('The uploaded content does not match its text document extension')
    content = _text(raw)
    if len(content) > MAX_TEXT:
        raise ValueError('Document text exceeds the reader limit of 1,000,000 characters')
    if extension in {'html', 'htm'}:
        if not re.search(r'<(?:!doctype\s+html|html|body|head|div|p|h[1-6]|section)(?:\s|>)', content, re.I):
            raise ValueError('Upload a valid UTF-8 HTML document')
        if re.search(r'<!\s*ENTITY\b|<!\s*DOCTYPE\s++[^>\[]*+\[', content, re.I):
            raise ValueError('HTML document contains unsupported entity declarations')
        return _book(title, [('Document', content)])
    if extension == 'csv':
        try:
            sample = content[:8192]
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=',;\t|')
            except csv.Error:
                dialect = csv.excel
            rows = []
            for row in csv.reader(io.StringIO(content), dialect):
                if len(rows) >= MAX_SHEET_ROWS or len(row) > MAX_SHEET_COLUMNS:
                    raise ValueError('CSV documents are limited to 5,000 rows and 50 columns')
                rows.append(row)
            return _book(title, [('CSV table', _table(rows))])
        except csv.Error:
            raise ValueError('Upload a valid UTF-8 CSV document') from None
    return _book(title, [('Document', '<pre>' + html.escape(content) + '</pre>')])
