"""Bounded EPUB extraction and inert, same-origin reader HTML.

Never serve archived XHTML directly. Only render_chapter output and verified raster
images are intended for the reader; archived scripts, styles and fonts are ignored.
"""
from __future__ import annotations

import html
import io
import posixpath
import re
import stat
from html.parser import HTMLParser
from pathlib import PurePosixPath
from urllib.parse import quote, unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

MAX_UPLOAD = 50 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
MAX_ENTRY = 20 * 1024 * 1024
MAX_ENTRIES = 2000
RASTER_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}
XHTML_TYPES = {'application/xhtml+xml', 'text/html'}


def _xml(raw):
    if len(raw) > MAX_ENTRY or b'\x00' in raw:
        raise ValueError('EPUB XML contains unsupported document declarations')
    if re.search(br'<!\s*ENTITY\b', raw, re.I) or re.search(br'<!\s*DOCTYPE\s++[^>\[]*+\[', raw, re.I):
        raise ValueError('EPUB XML contains unsupported document declarations')
    try:
        return ET.fromstring(raw)
    except (ET.ParseError, UnicodeError, ValueError):
        raise ValueError('EPUB contains invalid XML') from None


def _local_path(base, href):
    """Resolve local package URIs, refusing absolute/external/archive escapes."""
    if not isinstance(href, str) or len(href) > 2048 or '\\' in href or any(ord(c) < 32 for c in href):
        return None
    try:
        parts = urlsplit(href)
    except ValueError:
        return None
    if parts.scheme or parts.netloc or parts.query:
        return None
    path = unquote(parts.path)
    if path.startswith('/') or '\\' in path or any(ord(c) < 32 for c in path):
        return None
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(base), path)) if path else base
    if resolved in ('.', '..') or resolved.startswith('../'):
        return None
    return resolved


def _raster_type(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if raw.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if raw.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if len(raw) >= 12 and raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp'
    return None


def _split_monolithic_xhtml(content: bytes, base_path: str, base_label: str) -> list[tuple[str, bytes]]:
    """Split a single monolithic XHTML file (e.g. from ONLYOFFICE) into chapters by headings."""
    try:
        text = content.decode('utf-8-sig')
    except UnicodeError:
        return [(base_label, content)]

    tag = 'h1' if re.search(r'<h1\b', text, re.I) else ('h2' if re.search(r'<h2\b', text, re.I) else None)
    if not tag:
        return [(base_label, content)]

    pattern = rf'(<{tag}\b[^>]*>.*?</{tag}>)'
    parts = re.split(pattern, text, flags=re.I | re.S)
    if len(parts) <= 2:
        return [(base_label, content)]

    results = []
    intro = parts[0].strip()
    intro_body = re.sub(r'<head\b[^>]*>.*?</head>', '', intro, flags=re.I | re.S)
    intro_text = html.unescape(re.sub(r'<[^>]*>', '', intro_body)).strip()
    if intro_text:
        lines = [line.strip() for line in intro_text.splitlines() if line.strip()]
        intro_title = lines[0][:100] if lines else base_label
        intro_html = f'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{html.escape(intro_title)}</title></head><body>{intro}</body></html>'
        results.append((intro_title, intro_html.encode('utf-8')))

    for i in range(1, len(parts), 2):
        heading = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ''
        title_match = re.search(r'<[^>]*>(.*?)</', heading, re.I | re.S)
        raw_title = html.unescape(re.sub(r'<[^>]*>', '', title_match.group(1) if title_match else heading)).strip()
        title = ' '.join(raw_title.split())[:150] or f'Section {len(results) + 1}'
        section_html = f'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{html.escape(title)}</title></head><body>{heading}{body}</body></html>'
        results.append((title, section_html.encode('utf-8')))

    return results if results else [(base_label, content)]


def parse_epub(raw: bytes) -> dict:
    if not raw or len(raw) > MAX_UPLOAD:
        raise ValueError('Upload an EPUB file no larger than 50 MB')
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES:
                raise ValueError('EPUB contains too many archive entries')
            names, total = set(), 0
            for entry in entries:
                name = entry.filename
                path = PurePosixPath(name)
                mode = entry.external_attr >> 16
                if (not name or name.startswith('/') or '\\' in name or '..' in path.parts or
                        any(ord(c) < 32 for c in name) or name in names or
                        str(path) != name.rstrip('/') or stat.S_ISLNK(mode)):
                    raise ValueError('EPUB contains an unsafe or duplicate archive path')
                names.add(name)
                total += entry.file_size
                if entry.flag_bits & 1:
                    raise ValueError('Encrypted EPUB files are not supported')
                if entry.file_size > MAX_ENTRY or total > MAX_EXPANDED:
                    raise ValueError('EPUB expanded content exceeds the reader limits')
                if entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 250:
                    raise ValueError('EPUB archive compression ratio exceeds the reader limits')
            if 'META-INF/encryption.xml' in names or 'META-INF/rights.xml' in names:
                raise ValueError('Encrypted or DRM-protected EPUB files are not supported')
            if 'mimetype' not in names or archive.read('mimetype').strip() != b'application/epub+zip':
                raise ValueError('Upload a valid EPUB book')
            if 'META-INF/container.xml' not in names:
                raise ValueError('EPUB is missing its package container')
            container = _xml(archive.read('META-INF/container.xml'))
            roots = container.findall('.//{*}rootfile')
            package_path = roots[0].get('full-path') if roots else None
            if not package_path or package_path not in names or _local_path('', package_path) != package_path:
                raise ValueError('EPUB package document is missing or invalid')
            package = _xml(archive.read(package_path))
            metadata = package.find('{*}metadata')
            title_node = metadata.find('{*}title') if metadata is not None else None
            author_node = metadata.find('{*}creator') if metadata is not None else None
            title = ''.join(title_node.itertext()).strip()[:300] if title_node is not None else 'Untitled book'
            author = ''.join(author_node.itertext()).strip()[:300] if author_node is not None else ''
            manifest = {}
            for node in package.findall('./{*}manifest/{*}item'):
                item_id = node.get('id')
                path = _local_path(package_path, node.get('href', ''))
                if not item_id or item_id in manifest or path not in names:
                    raise ValueError('EPUB contains an invalid manifest entry')
                manifest[item_id] = {'path': path, 'media_type': node.get('media-type', ''), 'properties': node.get('properties', '')}
            labels = {}
            # Navigation documents are parsed as XML only; never rendered directly.
            for item in manifest.values():
                if 'nav' in item['properties'].split():
                    navigation = _xml(archive.read(item['path']))
                    for link in navigation.findall('.//{*}a'):
                        path = _local_path(item['path'], link.get('href', ''))
                        label = ' '.join(''.join(link.itertext()).split())[:300]
                        if path and label:
                            labels.setdefault(path, label)
                elif item['media_type'] == 'application/x-dtbncx+xml':
                    navigation = _xml(archive.read(item['path']))
                    for point in navigation.findall('.//{*}navPoint'):
                        target, label = point.find('{*}content'), point.find('{*}navLabel/{*}text')
                        if target is not None and label is not None:
                            path = _local_path(item['path'], target.get('src', ''))
                            if path and label.text:
                                labels.setdefault(path, label.text.strip()[:300])
            chapters, assets = [], {}
            raw_spine_items = []
            for ref in package.findall('./{*}spine/{*}itemref'):
                item = manifest.get(ref.get('idref'))
                if not item or item['media_type'] not in XHTML_TYPES:
                    raise ValueError('EPUB reading order contains unsupported chapter content')
                path = item['path']
                content = archive.read(path)
                # Restrict to UTF-8 text and disallow XML DTDs/entities before HTML parsing.
                if b'\x00' in content or re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', content, re.I):
                    # HTMLParser ignores external DTD declarations; reject entity definitions and internal subsets.
                    if re.search(br'<!\s*ENTITY\b', content, re.I) or re.search(br'<!\s*DOCTYPE\s++[^>\[]*+\[', content, re.I) or b'\x00' in content:
                        raise ValueError('EPUB chapter contains unsupported document declarations')
                try:
                    decoded = content.decode('utf-8-sig')
                except UnicodeError:
                    raise ValueError('EPUB chapters must use UTF-8 text') from None
                label = labels.get(path)
                if not label:
                    heading = re.search(r'<(?:h[1-6]|title)\b[^>]*>(.*?)</(?:h[1-6]|title)>', decoded, re.I | re.S)
                    label = html.unescape(re.sub('<[^>]*>', '', heading.group(1))).strip()[:300] if heading else ''
                raw_spine_items.append((path, content, label))

            if len(raw_spine_items) == 1:
                path, content, label = raw_spine_items[0]
                split_sections = _split_monolithic_xhtml(content, path, label)
                if len(split_sections) > 1:
                    for idx, (sec_title, sec_content) in enumerate(split_sections):
                        sec_path = f'{path}#part_{idx}'
                        chapters.append({'id': str(len(chapters)), 'title': sec_title, 'path': sec_path})
                        assets[sec_path] = {'content': sec_content, 'media_type': 'application/xhtml+xml'}
                    assets[path] = {'content': content, 'media_type': 'application/xhtml+xml'}
                else:
                    chapters.append({'id': '0', 'title': label or 'Chapter 1', 'path': path})
                    assets[path] = {'content': content, 'media_type': 'application/xhtml+xml'}
            else:
                for path, content, label in raw_spine_items:
                    chapters.append({'id': str(len(chapters)), 'title': label or f'Chapter {len(chapters) + 1}', 'path': path})
                    assets[path] = {'content': content, 'media_type': 'application/xhtml+xml'}

            if not chapters:
                raise ValueError('EPUB has no readable chapters')
            for item in manifest.values():
                if item['media_type'] in RASTER_TYPES:
                    content = archive.read(item['path'])
                    if _raster_type(content) == item['media_type']:
                        assets[item['path']] = {'content': content, 'media_type': item['media_type']}
            return {'title': title or 'Untitled book', 'author': author, 'chapters': chapters, 'assets': assets}
    except (BadZipFile, KeyError, RuntimeError, NotImplementedError, OverflowError):
        raise ValueError('Upload a valid, unencrypted EPUB book') from None


class _ChapterHTML(HTMLParser):
    allowed = {'p', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
               'span', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'blockquote', 'q', 'cite', 'code', 'pre',
               'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
               'figure', 'figcaption', 'a', 'img', 'br', 'hr', 'abbr'}
    blocked = {'head', 'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'foreignobject', 'form', 'textarea',
               'button', 'select', 'option', 'template', 'noscript', 'audio', 'video', 'canvas'}
    void = {'img', 'br', 'hr', 'input', 'embed', 'meta', 'link', 'source', 'track', 'wbr', 'area', 'base', 'col', 'param'}

    def __init__(self, parsed, chapter, book_id):
        super().__init__(convert_charrefs=True)
        self.parsed, self.chapter, self.book_id = parsed, chapter, quote(str(book_id), safe='')
        self.output, self.stack = [], []
        self.suppressed = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self.suppressed:
            if tag not in self.void:
                self.suppressed += 1
            return
        if tag in self.blocked:
            if tag not in self.void:
                self.suppressed = 1
            return
        if tag not in self.allowed:
            return
        values, clean = dict(attrs), []
        if values.get('id') and re.fullmatch(r'[A-Za-z][A-Za-z0-9_.:-]{0,100}', values['id']):
            clean.append(('id', values['id']))
        if tag in ('td', 'th'):
            for key in ('colspan', 'rowspan'):
                if values.get(key, '').isdigit() and 1 <= int(values[key]) <= 100:
                    clean.append((key, values[key]))
        if tag == 'a':
            href = values.get('href', '')
            path = _local_path(self.chapter['path'], href)
            try:
                fragment = urlsplit(href).fragment
            except ValueError:
                fragment = ''
            match = next((c for c in self.parsed['chapters'] if c['path'] == path), None)
            if match:
                url = f'/api/learning/books/{self.book_id}/chapters/{quote(match["id"], safe="")}'
                if fragment:
                    url += '#' + quote(unquote(fragment), safe='')
                clean.append(('href', url))
        if tag == 'img':
            path = _local_path(self.chapter['path'], values.get('src', ''))
            asset = self.parsed['assets'].get(path)
            if not asset or asset['media_type'] not in RASTER_TYPES:
                return
            clean.extend([('src', f'/api/learning/books/{self.book_id}/assets/{quote(path, safe="/")}'),
                          ('alt', (values.get('alt') or '')[:500]), ('loading', 'lazy')])
        self.output.append('<' + tag + ''.join(' ' + key + '="' + html.escape(value, quote=True) + '"' for key, value in clean) + '>')
        if tag not in self.void:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.void:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.suppressed:
            self.suppressed -= 1
            return
        if tag in self.stack:
            while self.stack:
                opened = self.stack.pop()
                self.output.append('</' + opened + '>')
                if opened == tag:
                    break

    def handle_data(self, data):
        if not self.suppressed:
            self.output.append(html.escape(data))

    def finish(self):
        while self.stack:
            self.output.append('</' + self.stack.pop() + '>')
        return ''.join(self.output)


def render_chapter(parsed: dict, chapter_id: str, book_id: str, font_size=18) -> str:
    chapter = next((c for c in parsed['chapters'] if c['id'] == str(chapter_id)), None)
    if chapter is None:
        raise ValueError('Chapter not found')
    try:
        size = max(12, min(32, int(font_size)))
    except (ValueError, TypeError):
        size = 18
    parser = _ChapterHTML(parsed, chapter, book_id)
    parser.feed(parsed['assets'][chapter['path']]['content'].decode('utf-8-sig'))
    parser.close()
    body = parser.finish()
    title = html.escape(chapter['title'])
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>{title}</title><style>html{{color-scheme:light}}body{{font:{size}px/1.8 Georgia,serif;max-width:52rem;margin:0 auto;padding:32px 24px;color:#24212b;background:#ffffff;overflow-wrap:anywhere}}'
            'img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid #ddd;padding:8px}'
            'pre{white-space:pre-wrap}a{color:#6941a5}h1,h2,h3{line-height:1.3}blockquote{border-left:3px solid #b9a5d1;padding-left:20px}</style></head>'
            f'<body><main>{body}</main></body></html>')
