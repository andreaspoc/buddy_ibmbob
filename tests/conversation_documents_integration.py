"""Private attachment preparation with real Docling in an isolated database schema.
Run inside knowledge-worker; all document contents are explicitly synthetic fixtures.
"""
import asyncio
import os
import secrets
from unittest.mock import patch
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from app import conversation_documents as docs, postgres_storage as storage
from app.sessions import create_session, storage_scope
import io

from docx import Document
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject



def text_pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 16 Tf 50 740 Td (Project Juniper) Tj 0 -35 Td (Emergency access code: ORCHID-742.) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def word_table():
    doc = Document()
    doc.add_heading("Service desk hours", level=1)
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Day"
    table.cell(0, 1).text = "Opening time"
    table.cell(1, 0).text = "Monday"
    table.cell(1, 1).text = "09:15"
    output = io.BytesIO()
    doc.save(output)
    return output.getvalue()


def scanned_pdf():
    image = Image.new("RGB", (1200, 1600), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
    draw.text((90, 100), "Service desk opens at 09:15 on Monday.", fill="black", font=font)
    output = io.BytesIO()
    image.save(output, "PDF", resolution=150)
    return output.getvalue()


def main():
    original = os.environ['DATABASE_URL']
    schema = 'attachment_extract_' + secrets.token_hex(6)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    try:
        with patch.dict(os.environ, {'DATABASE_URL': make_conninfo(original, options=f'-c search_path={schema}'), 'BOB_BLOB_STORAGE': 'postgres'}):
            docs._schema_ready = False
            owner = 'attachment-fixture'
            sid = create_session(owner)['id']
            scope = storage_scope(sid, owner)
            for filename, content, expected in (
                ('brief.md', b'# Synthetic document\n\nReview milestone: Thursday.\n', 'Thursday'),
                ('juniper.pdf', text_pdf(), 'ORCHID-742'),
                ('hours.docx', word_table(), '09:15'),
                ('scanned.pdf', scanned_pdf(), '09:15'),
            ):
                storage.put_file(owner, scope, filename, content, session_id=sid)
                assert docs.enqueue(owner, scope, filename, sid)['status'] == 'queued'
                row = docs.claim()
                assert row and row['path'] == filename
                print(f'Preparing synthetic {filename}', flush=True)
                asyncio.run(docs.process(row))
                preview = docs.get_preview(owner, scope, filename)
                assert preview['status'] == 'ready', preview
                assert expected in preview['text'], preview
                assert storage.get_file(owner, scope, filename)['content'] == content
                assert storage.get_file('attachment-other', scope, preview['prepared_path']) is None
                assert storage.get_file(owner, 'session:other', preview['prepared_path']) is None
                if filename.endswith('.docx'):
                    assert 'Monday' in preview['text'] and '|' in preview['text']
                assert preview['prepared_path'] in docs.context_manifest(owner, scope)
            for filename, content in (('broken.pdf', b'not a PDF'), ('empty.md', b''), ('invalid.md', b'\xff\xfe')):
                storage.put_file(owner, scope, filename, content, session_id=sid)
                docs.enqueue(owner, scope, filename, sid)
                asyncio.run(docs.process(docs.claim()))
                preview = docs.get_preview(owner, scope, filename)
                assert preview['status'] == 'failed' and preview['error'] and not preview['text'], preview
            # A source replacement must invalidate its old preview and in-flight result.
            filename = 'brief.md'
            docs.enqueue(owner, scope, filename, sid)
            stale = docs.claim()
            storage.put_file(owner, scope, filename, b'# Replacement synthetic document', session_id=sid)
            assert docs.status(owner, scope, filename)['status'] == 'unprepared'
            assert not docs.save(stale, 'Stale result must never become available')
            docs.enqueue(owner, scope, filename, sid)
            asyncio.run(docs.process(docs.claim()))
            assert 'Replacement synthetic document' in docs.get_preview(owner, scope, filename)['text']
            docs.enqueue(owner, scope, filename, sid)
            deleted = docs.claim()
            storage.delete_file(owner, scope, filename, session_id=sid)
            assert not docs.save(deleted, 'Deleted source must never become available')
            assert 'brief.md' not in docs.context_manifest(owner, scope)
            with storage.job_queue._connect() as db:
                assert db.execute("SELECT to_regclass('bob_knowledge_documents') AS name").fetchone()['name'] is None
        print('Attachment extraction integration passed: Markdown, PDF, DOCX tables, scanned PDF OCR; failures; original preservation; private scope; replacement and deletion guards; no shared knowledge index.', flush=True)
    finally:
        docs._schema_ready = False
        with psycopg.connect(original, autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
