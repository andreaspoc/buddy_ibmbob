import unittest
import asyncio
import zipfile
from io import BytesIO
from fastapi import HTTPException, UploadFile
from app.document_comparison import compare_sections, source_lines


class DocumentComparisonTests(unittest.TestCase):
    def test_replacement_addition_removal_and_citations(self):
        result = compare_sections('original.md', [('section 1', 'Keep\nOld policy\nDeleted'), ('section 2', 'End')],
                                  'revised.md', [('section 1', 'Keep\nNew policy'), ('section 2', 'End\nAdded')])
        self.assertEqual(result['summary'], {'added_lines': 2, 'removed_lines': 2, 'unchanged_lines': 2})
        self.assertEqual(result['changes'][0]['kind'], 'modified')
        self.assertEqual(result['changes'][0]['before'][0], {'text': 'Old policy', 'source': 'original.md', 'location': 'section 1', 'line': 2})
        self.assertEqual(result['changes'][1]['after'][0]['location'], 'section 2')
        self.assertEqual(result['changes'][1]['after'][0]['line'], 2)

    def test_empty_lines_ignored_but_line_locations_preserved(self):
        result = compare_sections('a.txt', [('text', 'One\n\nTwo')], 'b.txt', [('text', 'One\nTwo')])
        self.assertEqual(result['changes'], [])
        self.assertEqual(source_lines('a.txt', [('text', 'One\n\nTwo')])[1]['line'], 3)

    def test_limits_and_empty_text(self):
        with self.assertRaises(ValueError): source_lines('a', [('text', ' \n')])
        with self.assertRaises(ValueError): source_lines('a', [('text', 'line\n' * 6001)])

    def test_repeated_text_does_not_suppress_changes(self):
        result = compare_sections('a', [('text', ('same\n' * 300) + 'old')], 'b', [('text', ('same\n' * 300) + 'new')])
        self.assertEqual(result['summary']['unchanged_lines'], 300)
        self.assertEqual(result['changes'][0]['after'][0]['text'], 'new')

    def test_upload_rejects_unsupported_and_empty_documents(self):
        from app.document_comparison import read_document
        for name, content in [('unsafe.html', b'<h1>text</h1>'), ('empty.txt', b'')]:
            with self.assertRaises(HTTPException) as failure:
                asyncio.run(read_document(UploadFile(filename=name, file=BytesIO(content))))
            self.assertEqual(failure.exception.status_code, 422)

    def test_real_text_extraction(self):
        from app.document_comparison import extract_and_compare
        result = extract_and_compare('before.txt', b'Policy\nOld rule', 'after.txt', b'Policy\nNew rule')
        self.assertEqual(result['changes'][0]['before'][0]['line'], 2)
        self.assertEqual(result['changes'][0]['after'][0]['text'], 'New rule')

    def test_docx_body_and_table_extraction_without_docling(self):
        from app.document_comparison import extract_document
        output = BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table value</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
        self.assertEqual(extract_document('fixture.docx', output.getvalue()), [('paragraph 1', 'First paragraph'), ('paragraph 2', 'Table value')])

    def test_pdf_text_page_extraction_without_docling(self):
        from app.document_comparison import extract_document
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=300)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 20 200 Td (Actual PDF text fixture) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        output = BytesIO(); writer.write(output)
        sections = extract_document('fixture.pdf', output.getvalue())
        self.assertEqual(sections[0][0], 'page 1')
        self.assertIn('Actual PDF text fixture', sections[0][1])


if __name__ == '__main__': unittest.main()
