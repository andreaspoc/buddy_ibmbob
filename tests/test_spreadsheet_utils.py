"""Unit tests for app.spreadsheet_utils reading, parsing, and Markdown table generation."""
import tempfile
import unittest
from pathlib import Path

from app.spreadsheet_utils import summarize_spreadsheet, _build_markdown_table


class SpreadsheetUtilsTests(unittest.TestCase):
    def test_unsupported_format(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            f.write(b"dummy")
            f.flush()
            res = summarize_spreadsheet(Path(f.name))
            self.assertIn("Unsupported spreadsheet format", res["error"])
            self.assertEqual(res["format"], "pdf")

    def test_empty_csv(self):
        with tempfile.NamedTemporaryFile(suffix=".csv", mode="w", encoding="utf-8") as f:
            f.flush()
            res = summarize_spreadsheet(Path(f.name))
            self.assertEqual(res["format"], "csv")
            self.assertEqual(res["total_rows"], 0)
            self.assertEqual(res["columns"], [])
            self.assertEqual(res["preview_markdown"], "_Empty CSV file_")

    def test_valid_csv_summary(self):
        content = "Name,Age,Role\nAlice,30,Developer\nBob,25,Designer\nCharlie,35,Manager\n"
        with tempfile.NamedTemporaryFile(suffix=".csv", mode="w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            res = summarize_spreadsheet(Path(f.name), max_preview_rows=2)
            self.assertEqual(res["format"], "csv")
            self.assertEqual(res["total_rows"], 3)
            self.assertEqual(res["columns"], ["Name", "Age", "Role"])
            self.assertEqual(res["preview_rows_count"], 2)
            self.assertIn("| Name | Age | Role |", res["preview_markdown"])
            self.assertIn("| Alice | 30 | Developer |", res["preview_markdown"])

    def test_valid_tsv_summary(self):
        content = "ID\tProject\tStatus\n1\tAlpha\tActive\n2\tBeta\tPaused\n"
        with tempfile.NamedTemporaryFile(suffix=".tsv", mode="w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            res = summarize_spreadsheet(Path(f.name))
            self.assertEqual(res["format"], "csv")
            self.assertEqual(res["total_rows"], 2)
            self.assertEqual(res["columns"], ["ID", "Project", "Status"])
            self.assertIn("| Alpha | Active |", res["preview_markdown"])

    def test_latin1_csv_fallback(self):
        content = "Employee,City\nRené,Montréal\n".encode("latin-1")
        with tempfile.NamedTemporaryFile(suffix=".csv") as f:
            f.write(content)
            f.flush()
            res = summarize_spreadsheet(Path(f.name))
            self.assertEqual(res["format"], "csv")
            self.assertEqual(res["total_rows"], 1)

    def test_build_markdown_table_empty_headers(self):
        self.assertEqual(_build_markdown_table([], []), "")

    def test_build_markdown_table_escaping_and_padding(self):
        headers = ["Col|1", ""]
        rows = [["Val|A", "Val\nB"], ["OnlyOne"]]
        md = _build_markdown_table(headers, rows)
        self.assertIn("Col\\|1", md)
        self.assertIn("Col_2", md)
        self.assertIn("Val\\|A", md)
        self.assertIn("Val B", md)

    def test_xlsx_summary(self):
        import openpyxl

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Summary"
        ws.append(["Metric", "Q1", "Q2"])
        ws.append(["Revenue", 100, 150])
        ws.append(["Expenses", 80, 90])

        ws2 = wb.create_sheet(title="EmptySheet")

        with tempfile.NamedTemporaryFile(suffix=".xlsx") as f:
            wb.save(f.name)
            res = summarize_spreadsheet(Path(f.name), max_preview_rows=5)
            self.assertEqual(res["format"], "xlsx")
            self.assertEqual(res["sheets_count"], 2)
            self.assertEqual(res["active_sheet"], "Summary")
            self.assertIn("| Metric | Q1 | Q2 |", res["preview_markdown"])
            self.assertIn("| Revenue | 100 | 150 |", res["preview_markdown"])


if __name__ == "__main__":
    unittest.main()
