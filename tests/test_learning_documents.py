"""Synthetic files exercise Learning's inert, bounded document reader."""
import io
import unittest
import zlib
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from buddy_learning.documents import parse_document, supported_extensions
from buddy_learning.epub import render_chapter

TYPES = {
    'docx': ('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
    'pptx': ('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),
}


def package(extension, files):
    path, mime = TYPES[extension]
    result = io.BytesIO()
    with ZipFile(result, 'w', compression=ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{path}" ContentType="{mime}"/></Types>')
        for name, raw in files.items():
            archive.writestr(name, raw)
    return result.getvalue()


def pdf(text=None, compressed=False):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    if text is not None:
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 44 700 Td (' + text + b') Tj ET')
        if compressed:
            stream = stream.flate_encode()
        page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class DocumentReaderTests(unittest.TestCase):
    def test_unicode_text_markdown_csv_and_html_are_inert(self):
        for extension in ('txt', 'md'):
            book = parse_document('Καλημέρα दुनिया <script>bad()</script>'.encode(), 'Notes.' + extension)
            result = render_chapter(book, '0', 'book')
            self.assertIn('Καλημέρα दुनिया', result)
            self.assertIn('&lt;script&gt;', result)
        book = parse_document('Όνομα,Κατάσταση\nΆννα,Νέα'.encode(), 'Customers.csv')
        result = render_chapter(book, '0', 'book')
        self.assertIn('<table>', result)
        self.assertIn('Άννα', result)
        raw = b'<html><body><script>secret()</script><h1 onclick="bad()">Read</h1><img src="https://tracker.invalid/x"/></body></html>'
        result = render_chapter(parse_document(raw, 'Book.html'), '0', 'book')
        for blocked in ('secret()', 'onclick', 'tracker.invalid', '<script'):
            self.assertNotIn(blocked, result)
        self.assertIn('<h1>Read</h1>', result)

    def test_docx_sections_and_unicode(self):
        word = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Εισαγωγή</w:t></w:r></w:p><w:p><w:r><w:t>Κείμενο &amp; सुरक्षा</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Δεύτερο</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Τιμή</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'''
        book = parse_document(package('docx', {'word/document.xml': word.encode()}), 'Book.docx')
        self.assertEqual([c['title'] for c in book['chapters']], ['Εισαγωγή', 'Δεύτερο'])
        self.assertIn('Κείμενο &amp; सुरक्षा', render_chapter(book, '0', 'book'))
        self.assertIn('<table>', render_chapter(book, '1', 'book'))

    def test_pptx_follows_slide_relationship_order(self):
        files = {
            'ppt/presentation.xml': b'<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rIdB"/><p:sldId id="2" r:id="rIdA"/></p:sldIdLst></p:presentation>',
            'ppt/_rels/presentation.xml.rels': b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rIdB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
            'ppt/slides/slide1.xml': b'<slide xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second page</a:t></a:r></a:p></slide>',
            'ppt/slides/slide2.xml': '<slide xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Πρώτη σελίδα</a:t></a:r></a:p></slide>'.encode(),
        }
        book = parse_document(package('pptx', files), 'Slides.pptx')
        self.assertEqual(len(book['chapters']), 2)
        self.assertIn('Πρώτη σελίδα', render_chapter(book, '0', 'book'))
        self.assertIn('Second page', render_chapter(book, '1', 'book'))

    def test_xlsx_renders_sheets_without_executing_formulas(self):
        from openpyxl import Workbook
        workbook = Workbook()
        workbook.active.title = 'Δεδομένα'
        workbook.active.append(['Όνομα', 'Τιμή'])
        workbook.active.append(['Άννα', 0])
        workbook.create_sheet('Other').append(['=HYPERLINK("https://bad.invalid", "bad")'])
        output = io.BytesIO()
        workbook.save(output)
        book = parse_document(output.getvalue(), 'Workbook.xlsx')
        self.assertEqual(len(book['chapters']), 2)
        result = render_chapter(book, '0', 'book')
        self.assertIn('Άννα', result)
        self.assertIn('<td>0</td>', result)
        self.assertNotIn('bad.invalid', render_chapter(book, '1', 'book'))

    def test_pdf_text_and_scanned_pdf_error(self):
        book = parse_document(pdf(b'Synthetic learning text', compressed=True), 'Book.pdf')
        self.assertEqual(book['chapters'][0]['title'], 'Page 1')
        self.assertIn('Synthetic learning text', render_chapter(book, '0', 'book'))
        with self.assertRaisesRegex(ValueError, 'OCR'):
            parse_document(pdf(), 'Scanned.pdf')
        with patch('buddy_learning.documents.MAX_ENTRY', 100), self.assertRaisesRegex(ValueError, 'size limit'):
            parse_document(pdf(b'A' * 2000, compressed=True), 'Oversized.pdf')

    def test_signatures_legacy_paths_entities_and_limits(self):
        self.assertTrue({'pdf', 'docx', 'pptx', 'xlsx', 'epub'} <= supported_extensions)
        for extension in ('doc', 'ppt', 'xls'):
            with self.assertRaisesRegex(ValueError, 'Convert'):
                parse_document(b'legacy', 'File.' + extension)
        for extension in ('pdf', 'docx', 'pptx', 'xlsx'):
            with self.assertRaises(ValueError):
                parse_document(b'wrong signature', 'Wrong.' + extension)
        for raw in (pdf(b'Example'), b'PK\x03\x04invalid', b'\xd0\xcf\x11\xe0invalid'):
            with self.assertRaises(ValueError):
                parse_document(raw, 'Wrong.txt')
        valid = b'<document><body><p>Example</p></body></document>'
        for bad in ('../escape', '/absolute', 'word\\escape'):
            with self.assertRaises(ValueError):
                parse_document(package('docx', {'word/document.xml': valid, bad: b'bad'}), 'Wrong.docx')
        with self.assertRaises(ValueError):
            parse_document(package('docx', {'word/document.xml': b'<!DOCTYPE root [<!ENTITY x "bad">]><root>&x;</root>'}), 'Wrong.docx')
        with self.assertRaises(ValueError):
            parse_document(package('docx', {'word/document.xml': valid}), 'Wrong.pptx')
        with patch('buddy_learning.documents.MAX_TEXT', 20), self.assertRaises(ValueError):
            parse_document(b'A' * 100, 'Large.txt')
        with self.assertRaises(ValueError):
            parse_document(b'bad\x00text', 'Bad.txt')


if __name__ == '__main__':
    unittest.main()
