"""Deterministic uploaded-data checks; run in the application environment."""
import unittest
from fastapi import HTTPException
from app.productivity import CsvInput, explore_csv, import_xlsx

class CsvTests(unittest.TestCase):
    def test_quoted_cells_bom_filter_and_finite_aggregates(self):
        result = explore_csv(CsvInput(content='\ufeffname,value\n"North, team",2\nNorth,4\nSouth,9\nNorth,NaN\nNorth,\n', filter_text='north', column=1))
        self.assertEqual(result['matched_rows'], 4)
        self.assertEqual(result['rows'][0][0], 'North, team')
        self.assertEqual(result['stats']['sum'], 6)
        self.assertEqual(result['stats']['mean'], 3)
        self.assertEqual(result['stats']['excluded'], 2)

    def test_ragged_and_missing_columns_are_rejected(self):
        for body in (CsvInput(content='a,b\nx\n'), CsvInput(content='a\nx', column=1)):
            with self.assertRaises(HTTPException) as caught:
                explore_csv(body)
            self.assertEqual(caught.exception.status_code, 422)

    def test_empty_and_overflow_are_rejected(self):
        for text in ('', 'a\n1e308\n1e308\n'):
            with self.assertRaises(Exception):
                explore_csv(CsvInput(content=text, column=0))

    def test_no_matches_preserves_headers(self):
        result = explore_csv(CsvInput(content='item,n\na,2\n', filter_text='missing', column=1))
        self.assertEqual(result['rows'], [])
        self.assertEqual(result['headers'], ['item', 'n'])
        self.assertIsNone(result['stats']['mean'])

class WorkbookTests(unittest.TestCase):
    def workbook_bytes(self):
        import io
        import openpyxl
        book = openpyxl.Workbook()
        book.active.title = 'First'
        book.active.append(['name', 'value'])
        book.active.append(['alpha', 2])
        book.active.append(['formula', '=1+1'])
        other = book.create_sheet('Second')
        other.append(['metric'])
        other.append([7])
        stream = io.BytesIO()
        book.save(stream)
        book.close()
        return stream.getvalue()

    def test_sheet_selection_and_uncached_formula(self):
        result = import_xlsx(self.workbook_bytes())
        self.assertEqual(result['sheets'], ['First', 'Second'])
        self.assertEqual(result['exploration']['rows'][1], ['formula', ''])
        self.assertEqual(import_xlsx(self.workbook_bytes(), 'Second')['exploration']['rows'], [['7']])

    def test_invalid_workbook_and_sheet(self):
        for raw, sheet in ((b'invalid', None), (self.workbook_bytes(), 'missing')):
            with self.assertRaises(HTTPException) as caught:
                import_xlsx(raw, sheet)
            self.assertEqual(caught.exception.status_code, 422)

if __name__ == '__main__':
    unittest.main()
