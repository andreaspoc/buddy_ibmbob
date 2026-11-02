"""Bounded document reader tests using only synthetic, in-memory data."""
import base64
import io
import unittest
import zlib
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile
from types import SimpleNamespace

from buddy_learning import documents


class Stream(dict):
    def __init__(self, data, filters=()):
        super().__init__({'/Filter': filters})
        self._data = data

    def get_object(self):
        return self


class PdfDictionary(dict):
    def get_object(self):
        return self


class DocumentLimitsTests(unittest.TestCase):
    def test_pdf_stream_supported_encodings_and_shared_budget(self):
        budget = [0]
        content = b'BT hello ET'
        for data, name in [(zlib.compress(content), '/FlateDecode'),
                           (base64.a85encode(content, adobe=True), '/ASCII85Decode'),
                           (content.hex().encode() + b'>', '/ASCIIHexDecode')]:
            self.assertEqual(documents._bounded_pdf_stream(Stream(data, name), budget), len(content))
        self.assertEqual(budget[0], 3 * len(content))

    def test_pdf_stream_rejects_bad_compression_unsupported_filter_and_budgets(self):
        with self.assertRaisesRegex(ValueError, 'invalid compressed'):
            documents._bounded_pdf_stream(Stream(b'not-zlib', '/FlateDecode'), [0])
        with self.assertRaisesRegex(ValueError, 'unsupported compression'):
            documents._bounded_pdf_stream(Stream(b'abc', '/LZWDecode'), [0])
        with patch.object(documents, 'MAX_ENTRY', 4):
            with self.assertRaisesRegex(ValueError, 'page content'):
                documents._bounded_pdf_stream(Stream(zlib.compress(b'123456'), '/FlateDecode'), [0])
        with patch.object(documents, 'MAX_EXPANDED', 4):
            with self.assertRaisesRegex(ValueError, 'expanded text'):
                documents._bounded_pdf_stream(Stream(b'12345'), [0])

    def test_pdf_resource_traversal_limits_nested_forms(self):
        form = Stream(b'embedded')
        form['/Subtype'] = '/Form'
        form['/Resources'] = PdfDictionary({'/XObject': {'/Self': form}})
        budget = [0]
        documents._bounded_pdf_resources(PdfDictionary({'/XObject': {'/First': form}}), set(), budget)
        self.assertEqual(budget, [len(b'embedded')])
        with self.assertRaisesRegex(ValueError, 'nesting limit'):
            documents._bounded_pdf_resources({}, set(), [0], depth=9)

    def test_csv_row_and_column_limits(self):
        with patch.object(documents, 'MAX_SHEET_ROWS', 2):
            with self.assertRaisesRegex(ValueError, '5,000 rows'):
                documents.parse_document(b'a,b\nc,d\ne,f', 'data.csv')
        with patch.object(documents, 'MAX_SHEET_COLUMNS', 2):
            with self.assertRaisesRegex(ValueError, '50 columns'):
                documents.parse_document(b'a,b,c\nd,e,f', 'data.csv')

    def test_rejects_mismatched_binary_and_unsafe_html(self):
        for raw, name, expected in [(b'PK\x03\x04binary', 'notes.txt', 'does not match'),
                                    (b'not an html document', 'notes.html', 'valid UTF-8 HTML'),
                                    (b'<!DOCTYPE html [<!ENTITY e "x">]><html></html>', 'notes.html', 'entity declarations')]:
            with self.subTest(name=name, expected=expected):
                with self.assertRaisesRegex(ValueError, expected):
                    documents.parse_document(raw, name)

    def test_office_zip_rejects_duplicate_paths_and_traversal(self):
        for names in [['word/document.xml', 'word/document.xml'], ['../outside.xml']]:
            output = io.BytesIO()
            with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
                for name in names:
                    archive.writestr(name, '<xml/>')
            with self.subTest(names=names):
                with self.assertRaisesRegex(ValueError, 'unsafe or duplicate'):
                    documents._package(output.getvalue())

    def test_document_book_enforces_section_and_text_limits(self):
        with self.assertRaisesRegex(ValueError, 'between 1 and 500'):
            documents._book('empty', [])
        with patch.object(documents, 'MAX_TEXT', 4):
            with self.assertRaisesRegex(ValueError, 'text exceeds'):
                documents._book('large', [('A', '<p>12345</p>')])
        with patch.object(documents, 'MAX_ENTRY', 20):
            with self.assertRaisesRegex(ValueError, 'section exceeds'):
                documents._book('large', [('A', '<p>ok</p>')])

    def test_relationship_target_must_be_local(self):
        for target in ['https://example.invalid/x', '//example.invalid/x', '../../escape']:
            with self.subTest(target=target):
                with self.assertRaises(ValueError):
                    documents._part('ppt/presentation.xml', target)
        self.assertEqual(documents._part('ppt/presentation.xml', 'slides/slide1.xml'), 'ppt/slides/slide1.xml')

    def test_spreadsheet_cleanup_on_success_and_limits(self):
        sheet = SimpleNamespace(title='Forecast <2026>', max_row=2, max_column=2,
                                iter_rows=lambda **kw: iter([('Name', 'Value'), ('A&B', 42)]))
        workbook = SimpleNamespace(worksheets=[sheet], close=unittest.mock.Mock())
        with patch('openpyxl.load_workbook', return_value=workbook):
            result = documents._xlsx(b'ignored', 'Budget')
        workbook.close.assert_called_once()
        self.assertEqual(result['chapters'][0]['title'], 'Forecast <2026>')
        content = result['assets']['document/section-0.xhtml']['content'].decode()
        self.assertIn('A&amp;B', content)
        self.assertIn('42', content)
        workbook.close.reset_mock()
        sheet.max_column = documents.MAX_SHEET_COLUMNS + 1
        with patch('openpyxl.load_workbook', return_value=workbook):
            with self.assertRaisesRegex(ValueError, '50 columns'):
                documents._xlsx(b'ignored', 'Budget')
        workbook.close.assert_called_once()

    def test_spreadsheet_loader_failure_is_user_facing_error(self):
        with patch('openpyxl.load_workbook', side_effect=RuntimeError('internal detail')):
            with self.assertRaisesRegex(ValueError, 'valid Excel workbook'):
                documents._xlsx(b'bad', 'Budget')


if __name__ == '__main__':
    unittest.main()
