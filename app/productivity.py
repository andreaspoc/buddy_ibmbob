"""Additive private recipes and bounded, deterministic CSV exploration."""
import csv
import io
import math
from uuid import UUID, uuid4
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from pydantic import BaseModel, Field
from app import job_queue
from app.auth import current_user

router = APIRouter(prefix='/productivity', tags=['productivity'])

class Recipe(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    instructions: str = Field(min_length=1, max_length=12000)
    sources: str = Field(default='', max_length=4000)
    output: Literal['report', 'presentation', 'spreadsheet'] = 'report'

class CsvInput(BaseModel):
    content: str = Field(min_length=1, max_length=2000000)
    column: int | None = Field(default=None, ge=0, le=199)
    filter_text: str = Field(default='', max_length=200)


def ensure_schema():
    with job_queue._connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS bob_deliverable_recipes (
          id UUID PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL,
          instructions TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '',
          output TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())''')

@router.get('/recipes')
def recipes(user: dict = Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        return db.execute('SELECT id,name,instructions,sources,output FROM bob_deliverable_recipes WHERE username=%s ORDER BY created_at DESC', (user['username'],)).fetchall()

@router.post('/recipes')
def save_recipe(body: Recipe, user: dict = Depends(current_user)):
    if not body.name.strip() or not body.instructions.strip():
        raise HTTPException(422, 'Name and instructions cannot be blank')
    ensure_schema()
    identifier = uuid4()
    with job_queue._connect() as db:
        db.execute('INSERT INTO bob_deliverable_recipes (id,username,name,instructions,sources,output) VALUES (%s,%s,%s,%s,%s,%s)', (identifier,user['username'],body.name.strip(),body.instructions,body.sources,body.output))
    return {'id': str(identifier), **body.model_dump()}

@router.delete('/recipes/{identifier}')
def delete_recipe(identifier: UUID, user: dict = Depends(current_user)):
    ensure_schema()
    with job_queue._connect() as db:
        result = db.execute('DELETE FROM bob_deliverable_recipes WHERE id=%s AND username=%s RETURNING id', (identifier,user['username'])).fetchone()
    if not result:
        raise HTTPException(404, 'Recipe not found')
    return {'deleted': True}


def explore_csv(body: CsvInput):
    try:
        reader = csv.reader(io.StringIO(body.content.lstrip('\ufeff')), strict=True)
        headers = next(reader)
        if not headers or len(headers) > 200:
            raise ValueError('CSV must have between 1 and 200 columns')
        rows = []
        for index, row in enumerate(reader):
            if index >= 10000:
                raise ValueError('CSV exceeds 10,000 rows')
            if len(row) != len(headers):
                raise ValueError(f'Row {index + 2} has a different number of columns')
            rows.append(row)
    except (csv.Error, StopIteration, ValueError) as exc:
        raise HTTPException(422, str(exc) or 'CSV is empty') from exc
    selected = [row for row in rows if not body.filter_text or any(body.filter_text.casefold() in cell.casefold() for cell in row)]
    stats = None
    if body.column is not None:
        if body.column >= len(headers):
            raise HTTPException(422, 'Column does not exist')
        numbers = []
        for row in selected:
            try:
                value = float(row[body.column])
                if math.isfinite(value):
                    numbers.append(value)
            except ValueError:
                pass
        try:
            total = math.fsum(numbers)
        except OverflowError:
            raise HTTPException(422, 'Numeric values exceed supported range')
        if not math.isfinite(total):
            raise HTTPException(422, 'Numeric values exceed supported range')
        stats = {'column': headers[body.column], 'count': len(numbers), 'excluded': len(selected)-len(numbers), 'sum': total, 'mean': total/len(numbers) if numbers else None, 'min': min(numbers) if numbers else None, 'max': max(numbers) if numbers else None}
    return {'headers': headers, 'rows': selected, 'total_rows': len(rows), 'matched_rows': len(selected), 'stats': stats,
            'provenance': {'filter': body.filter_text, 'method': 'Case-insensitive substring across all cells; aggregates use finite numeric cells only; mean = sum / numeric count.', 'source': 'Uploaded CSV; first row treated as headers'}}

@router.post('/csv/explore')
def csv_explore(body: CsvInput, user: dict = Depends(current_user)):
    return explore_csv(body)


def import_xlsx(raw: bytes, sheet: str | None = None):
    """Convert a bounded workbook to CSV without evaluating formulas or macros."""
    import zipfile
    import openpyxl
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if len(archive.infolist()) > 1000 or sum(item.file_size for item in archive.infolist()) > 20000000:
                raise HTTPException(422, 'Workbook expands beyond the supported size')
        workbook = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        try:
            names = workbook.sheetnames
            selected = sheet or names[0]
            if selected not in names:
                raise HTTPException(422, 'Worksheet does not exist')
            worksheet = workbook[selected]
            if (worksheet.max_column or 0) > 200 or (worksheet.max_row or 0) > 10001:
                raise HTTPException(422, 'Worksheet exceeds 10,000 rows or 200 columns')
            output = io.StringIO()
            writer = csv.writer(output)
            for index, row in enumerate(worksheet.iter_rows(values_only=True)):
                if index > 10000 or len(row) > 200:
                    raise HTTPException(422, 'Worksheet exceeds supported limits')
                writer.writerow(['' if cell is None else str(cell) for cell in row])
                if output.tell() > 2000000:
                    raise HTTPException(422, 'Worksheet text exceeds 2 MB')
            content = output.getvalue()
            result = explore_csv(CsvInput(content=content))
            result['provenance']['source'] = 'Uploaded Excel worksheet; first row treated as headers; formula cells use cached values only (missing cached values are blank).'
            return {'content': content, 'sheets': names, 'sheet': selected, 'exploration': result}
        finally:
            workbook.close()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(422, 'Could not read workbook. Upload a valid XLSX file or export it as CSV.') from exc

@router.post('/spreadsheet/import')
async def import_spreadsheet(file: UploadFile = File(...), sheet: str | None = Query(default=None, max_length=100), user: dict = Depends(current_user)):
    from starlette.concurrency import run_in_threadpool
    raw = await file.read(2000001)
    if len(raw) > 2000000:
        raise HTTPException(413, 'Workbook must be under 2 MB')
    if not (file.filename or '').lower().endswith(('.xlsx', '.xlsm', '.xltx')):
        raise HTTPException(422, 'Use XLSX or export legacy XLS as CSV')
    return await run_in_threadpool(import_xlsx, raw, sheet)
