"""Utilities for reading, parsing, and summarizing CSV and Excel files."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Any


def summarize_spreadsheet(file_path: Path, max_preview_rows: int = 10, *, file_extension: str | None = None) -> dict[str, Any]:
    """Read a CSV or XLSX file and return sheets, headers, row count, and a Markdown preview."""
    ext = file_extension.lower() if file_extension is not None else file_path.suffix.lower()
    if ext == ".csv":
        return _summarize_csv(file_path, max_preview_rows)
    elif ext in {".xlsx", ".xlsm", ".xltx"}:
        return _summarize_xlsx(file_path, max_preview_rows)
    elif ext == ".tsv":
        return _summarize_csv(file_path, max_preview_rows, delimiter="\t")
    else:
        return {
            "filename": file_path.name,
            "format": ext.lstrip("."),
            "size_bytes": file_path.stat().st_size,
            "error": f"Unsupported spreadsheet format: {ext}. Supported: .csv, .xlsx, .tsv",
        }


def _summarize_csv(file_path: Path, max_preview_rows: int, delimiter: str = ",") -> dict[str, Any]:
    try:
        # Detect encoding
        encoding = "utf-8"
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                f.read(1024)
        except UnicodeDecodeError:
            encoding = "latin-1"

        with open(file_path, "r", encoding=encoding, errors="replace") as f:
            reader = csv.reader(f, delimiter=delimiter)
            rows = []
            for i, row in enumerate(reader):
                rows.append(row)
                if i >= 5000:  # Sample up to 5000 rows for speed
                    break

        if not rows:
            return {
                "filename": file_path.name,
                "format": "csv",
                "total_rows": 0,
                "columns": [],
                "preview_markdown": "_Empty CSV file_",
            }

        headers = [str(c).strip() for c in rows[0]]
        data_rows = rows[1:]
        preview_rows = data_rows[:max_preview_rows]

        # Build Markdown table preview
        md_table = _build_markdown_table(headers, preview_rows)

        return {
            "filename": file_path.name,
            "format": "csv",
            "total_rows": len(data_rows),
            "columns": headers,
            "preview_rows_count": len(preview_rows),
            "preview_markdown": md_table,
        }
    except Exception as exc:
        return {
            "filename": file_path.name,
            "format": "csv",
            "error": f"Error parsing CSV: {exc}",
        }


def _summarize_xlsx(file_path: Path, max_preview_rows: int) -> dict[str, Any]:
    try:
        import openpyxl
    except ImportError:
        return {
            "filename": file_path.name,
            "format": "xlsx",
            "error": "openpyxl library is required to read Excel files.",
        }

    try:
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        sheet_names = wb.sheetnames
        sheets_info = []
        primary_preview = ""

        for idx, sname in enumerate(sheet_names):
            ws = wb[sname]
            rows = []
            for i, r in enumerate(ws.iter_rows(values_only=True)):
                if r and any(c is not None for c in r):
                    rows.append([str(c) if c is not None else "" for c in r])
                if i >= 2000:
                    break

            if not rows:
                sheets_info.append({"sheet_name": sname, "total_rows": 0, "columns": []})
                continue

            headers = rows[0]
            data_rows = rows[1:]
            sheets_info.append({
                "sheet_name": sname,
                "total_rows": len(data_rows),
                "columns": headers,
            })

            if idx == 0:
                primary_preview = _build_markdown_table(headers, data_rows[:max_preview_rows])

        wb.close()

        return {
            "filename": file_path.name,
            "format": "xlsx",
            "sheets_count": len(sheet_names),
            "sheets": sheets_info,
            "active_sheet": sheet_names[0] if sheet_names else "",
            "preview_markdown": primary_preview,
        }
    except Exception as exc:
        return {
            "filename": file_path.name,
            "format": "xlsx",
            "error": f"Error parsing Excel file: {exc}",
        }


def _build_markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    if not headers:
        return ""
    safe_headers = [h.replace("|", "\\|").strip() or f"Col_{i+1}" for i, h in enumerate(headers)]
    lines = [
        "| " + " | ".join(safe_headers) + " |",
        "| " + " | ".join(["---"] * len(safe_headers)) + " |",
    ]
    for r in rows:
        # Match header length
        padded = list(r) + [""] * (len(safe_headers) - len(r))
        padded = padded[:len(safe_headers)]
        safe_cells = [str(c).replace("|", "\\|").replace("\n", " ").strip() for c in padded]
        lines.append("| " + " | ".join(safe_cells) + " |")
    return "\n".join(lines)
