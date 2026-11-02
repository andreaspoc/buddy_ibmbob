"""Bounded XLSX interchange for the simulator's independent regression cases.

This is a DecisionsBuddy format, not an IBM DVS workbook compatibility layer.
"""
from io import BytesIO
import json
from zipfile import ZipFile

MAX_CASES = 100
MAX_FILE_BYTES = 1024 * 1024
MAX_EXPANDED_BYTES = 8 * 1024 * 1024


def import_workbook(content: bytes) -> list[dict]:
    if not content or len(content) > MAX_FILE_BYTES:
        raise ValueError('Import an XLSX file no larger than 1 MB')
    try:
        with ZipFile(BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 256 or sum(item.file_size for item in entries) > MAX_EXPANDED_BYTES:
                raise ValueError('Workbook expanded size limit exceeded')
        from openpyxl import load_workbook
        workbook = load_workbook(BytesIO(content), read_only=True, data_only=False, keep_links=False)
    except Exception as error:
        if isinstance(error, ValueError):
            raise
        raise ValueError('Invalid XLSX workbook') from error
    try:
        if 'Scenarios' not in workbook.sheetnames:
            raise ValueError('Workbook must contain a Scenarios sheet')
        sheet = workbook['Scenarios']
        if sheet.max_column and sheet.max_column > 3:
            raise ValueError('Scenarios columns must be name, input, expected')
        if sheet.max_row and sheet.max_row > MAX_CASES + 1:
            raise ValueError('Import at most 100 scenarios')
        rows = sheet.iter_rows(max_row=MAX_CASES + 2, max_col=4)
        header = next(rows, ())
        if [cell.value for cell in header] != ['name', 'input', 'expected', None]:
            raise ValueError('Scenarios header must be name, input, expected')
        cases = []
        for row_number, cells in enumerate(rows, 2):
            values = [cell.value for cell in cells]
            if all(value is None for value in values):
                continue
            if len(cases) >= MAX_CASES or values[3] is not None:
                raise ValueError('Import at most 100 scenarios with three columns')
            if any(cell.data_type == 'f' for cell in cells):
                raise ValueError(f'Row {row_number}: formulas are not supported; use JSON values')
            name, raw_input, raw_expected = values[:3]
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f'Row {row_number}: provide a scenario name')
            try:
                case_input = json.loads(raw_input)
                expected = json.loads(raw_expected)
            except (TypeError, ValueError) as error:
                raise ValueError(f'Row {row_number}: input and expected must contain JSON') from error
            if not isinstance(case_input, dict):
                raise ValueError(f'Row {row_number}: input must be a JSON object')
            # Reject nonstandard JSON numbers accepted by Python's decoder.
            try:
                json.dumps([case_input, expected], allow_nan=False)
            except ValueError as error:
                raise ValueError(f'Row {row_number}: nonfinite numbers are not supported') from error
            cases.append({'name': name, 'input': case_input, 'expected': expected})
        if not cases:
            raise ValueError('Provide at least one scenario')
        return cases
    finally:
        workbook.close()


def workbook_template() -> bytes:
    from openpyxl import Workbook
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Scenarios'
    sheet.append(['name', 'input', 'expected'])
    sheet.append(['Example: replace with your own case', '{"age": 20}', '{"approved": true}'])
    sheet.column_dimensions['A'].width = 44
    sheet.column_dimensions['B'].width = 55
    sheet.column_dimensions['C'].width = 55
    sheet.freeze_panes = 'A2'
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()
