"""Offline Markdown exports with native Word tables and embedded diagram images.

Only the bundled trusted renderer runs JavaScript. User HTML is shown as literal
text, browser network requests are blocked, and external images are omitted.
"""
from __future__ import annotations

from app.branding import brand_text
import asyncio
import html
import io
import os
from pathlib import Path
import re
import struct
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import HTTPException

MAX_TEXT = 200000
MAX_BLOCKS = 10000
MAX_IMAGES = 20
MAX_IMAGE_BYTES = 8 * 1024 * 1024
BUNDLE = Path(__file__).parent / 'static' / 'document-export.bundle.js'
_slots = asyncio.Semaphore(2)

CSS = '''
@page{size:A4;margin:19mm 17mm 20mm}*{box-sizing:border-box}body{font:12px Arial,sans-serif;color:#292334;line-height:1.55;margin:0;padding:0}header{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:700;color:white;background:linear-gradient(120deg,#30104d,#482064);padding:22px 24px;border-radius:12px;margin-bottom:22px;break-after:avoid}header svg{width:25px;height:25px;fill:#d8aeff}header span{color:#d8aeff}h1{font-size:25px;color:#30104d}h2{font-size:20px;color:#51217a}h3{font-size:16px;color:#51217a}h1,h2,h3,h4{break-after:avoid}p{margin:9px 0}table{border-collapse:collapse;width:100%;margin:15px 0;table-layout:fixed;font-size:11px}th,td{border:1px solid #cbb8dc;padding:8px;vertical-align:top;overflow-wrap:anywhere}th{background:#eee0fb;color:#30104d;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f3fa;border:1px solid #e6dced;padding:10px;font-size:10px}code{font-family:monospace}blockquote{border-left:3px solid #b77de5;padding-left:12px;color:#604d6d}.export-diagram{margin:18px 0;padding:12px;border:1px solid #dcc6ed;border-radius:8px;break-inside:avoid;background:white;width:100%}.export-diagram svg{display:block;max-width:100%;max-height:225mm;margin:auto}.export-diagram figcaption{color:#655072;font-size:10px;margin-top:8px;text-align:center}.export-warning{color:#835418;background:#fff6df;padding:8px;border-left:3px solid #d2a148}a{color:#6b24a4;overflow-wrap:anywhere}
'''


def _clean(value):
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(value))


def _run(run, *, header=False):
    props = ''
    if run.get('bold') or header: props += '<w:b/>'
    if run.get('italic'): props += '<w:i/>'
    if run.get('code'): props += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:fill="F4EEF8"/>'
    parts = _clean(run.get('text', '')).split('\n')
    text = '<w:br/>'.join('<w:t xml:space="preserve">' + escape(part) + '</w:t>' for part in parts)
    return '<w:r><w:rPr>' + props + '</w:rPr>' + text + '</w:r>'


def _paragraph(runs, properties='', *, header=False):
    return '<w:p><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/>' + properties + '</w:pPr>' + ''.join(_run(run, header=header) for run in runs) + '</w:p>'


def _png_size(raw):
    if len(raw) < 24 or raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Diagram image is not a PNG')
    return struct.unpack('>II', raw[16:24])


def docx_document(title, blocks, images):
    """Build macro-free OOXML with editable tables and inline PNG relationships."""
    if len(blocks) > MAX_BLOCKS or len(images) > MAX_IMAGES:
        raise HTTPException(413, 'Document export structure exceeds its limit')
    body = [_paragraph([{'text': brand_text('Buddy'), 'bold': True}], '<w:pStyle w:val="Brand"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="10" w:color="7B00E0"/></w:pBdr>'),
            _paragraph([{'text': title, 'bold': True}], '<w:pStyle w:val="Title"/><w:keepNext/>')]
    media = []
    for block in blocks:
        kind = block.get('type')
        if kind == 'table':
            rows = block.get('rows', [])
            columns = max((len(row) for row in rows), default=0)
            if not columns: continue
            if columns > 30 or len(rows) > 3000:
                raise HTTPException(413, 'Table export supports up to 30 columns and 3,000 rows')
            width = 9638 // columns
            table = ['<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>' + ''.join('<w:' + side + ' w:val="single" w:sz="4" w:color="CBB8DC"/>' for side in ('top','left','bottom','right','insideH','insideV')) + '</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' + ('<w:gridCol w:w="' + str(width) + '"/>') * columns + '</w:tblGrid>']
            for row in rows:
                heading = bool(row) and all(cell.get('header') for cell in row)
                table.append('<w:tr><w:trPr>' + ('<w:tblHeader/>' if heading else '') + '</w:trPr>')
                for cell in [*row, *([{'runs': []}] * (columns - len(row)))]:
                    table.append('<w:tc><w:tcPr><w:tcW w:w="' + str(width) + '" w:type="dxa"/>' + ('<w:shd w:fill="EEE0FB"/>' if heading else '') + '</w:tcPr>' + _paragraph(cell.get('runs', []), header=heading) + '</w:tc>')
                table.append('</w:tr>')
            body.append(''.join(table) + '</w:tbl>' + _paragraph([]))
        elif kind == 'image':
            raw = images.get(block.get('id'))
            if not raw:
                body.append(_paragraph([{'text': 'Diagram unavailable in this export.'}]))
                continue
            if len(raw) > MAX_IMAGE_BYTES: raise HTTPException(413, 'Diagram image is too large')
            width, height = _png_size(raw)
            if not width or not height: raise ValueError('Empty diagram image')
            scale = min(6.65 * 914400 / width, 8.7 * 914400 / height)
            cx, cy = int(width * scale), int(height * scale)
            index = len(media) + 1
            media.append(raw)
            alt = escape(_clean(block.get('alt', 'Diagram')), {'"': '&quot;'})
            body.append('<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + str(cx) + '" cy="' + str(cy) + '"/><wp:docPr id="' + str(index) + '" name="Diagram ' + str(index) + '" descr="' + alt + '"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="diagram.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage' + str(index) + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + str(cx) + '" cy="' + str(cy) + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')
            body.append(_paragraph([{'text': block.get('alt', 'Diagram'), 'italic': True}], '<w:jc w:val="center"/>'))
        else:
            properties = ''
            if kind == 'heading': properties = '<w:pStyle w:val="Heading' + str(min(6, max(1, block.get('level', 2)))) + '"/><w:keepNext/>'
            if kind == 'code': properties += '<w:shd w:fill="F7F3FA"/>'
            if block.get('quote'): properties += '<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:color="B77DE5"/></w:pBdr>'
            if block.get('indent'): properties += '<w:ind w:left="' + str(min(10, int(block['indent'])) * 300) + '"/>'
            body.append(_paragraph(block.get('runs', []), properties))
    body.append('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>')
    namespaces = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + namespaces + '><w:body>' + ''.join(body) + '</w:body></w:document>'
    styles = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:color w:val="292334"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
    for style, size, color in [('Brand', 30, '7B00E0'), ('Title', 38, '30104D'), *[('Heading' + str(level), max(24, 36 - level * 2), '51217A') for level in range(1, 7)]]:
        styles += '<w:style w:type="paragraph" w:styleId="' + style + '"><w:name w:val="' + style + '"/><w:rPr><w:b/><w:sz w:val="' + str(size) + '"/><w:color w:val="' + color + '"/></w:rPr></w:style>'
    styles += '</w:styles>'
    relationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + ''.join('<Relationship Id="rIdImage' + str(index) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/diagram' + str(index) + '.png"/>' for index in range(1, len(media) + 1)) + '</Relationships>'
    output = io.BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
        archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr('word/document.xml', document)
        archive.writestr('word/styles.xml', styles)
        archive.writestr('word/_rels/document.xml.rels', relationships)
        for index, raw in enumerate(media, 1): archive.writestr('word/media/diagram' + str(index) + '.png', raw)
    return output.getvalue()


async def _render(title, body, format):
    from playwright.async_api import async_playwright
    if not BUNDLE.is_file():
        raise HTTPException(503, 'Visual document renderer is not built')
    document = '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + brand_text('</style></head><body><header><svg viewBox="0 0 48 46" aria-hidden="true"><path d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z"/></svg><div>Buddy<span> Buddy</span></div></header><h1 id="document-title"></h1><main id="document-body"></main></body></html>')
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('RESEARCH_CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            context = await browser.new_context(viewport={'width': 1100, 'height': 900}, device_scale_factor=1.5, service_workers='block')
            await context.route('**/*', lambda route: route.abort())
            page = await context.new_page()
            page.set_default_timeout(15000)
            await page.set_content(document, wait_until='domcontentloaded')
            await page.add_script_tag(content=BUNDLE.read_text())
            result = await page.evaluate('async ({title,body}) => await window.BuddyDocumentExport.prepare(title,body)', {'title': title, 'body': body})
            if len(result['blocks']) > MAX_BLOCKS:
                raise HTTPException(413, 'Document export structure exceeds its limit')
            if format == 'pdf':
                await page.emulate_media(media='print')
                return await page.pdf(format='A4', print_background=True)
            images = {}
            for block in result['blocks']:
                if block.get('type') == 'image':
                    images[block['id']] = await page.locator('#' + block['id'] + ' svg').screenshot(type='png', animations='disabled')
            return await asyncio.to_thread(docx_document, title, result['blocks'], images)
        finally:
            await browser.close()


async def render_document(title, body, format):
    """Render saved Markdown as a branded DOCX or PDF without external requests."""
    if format not in ('docx', 'pdf'):
        raise HTTPException(422, 'Choose docx or pdf')
    if not isinstance(title, str) or not isinstance(body, str) or len(title) > 500 or len(body) > MAX_TEXT:
        raise HTTPException(413, 'Document export supports a 500 character title and 200,000 character body')
    try:
        async with asyncio.timeout(90):
            async with _slots:
                return await _render(title, body, format)
    except TimeoutError:
        raise HTTPException(503, 'Document rendering timed out; simplify the diagrams or export fewer messages') from None
