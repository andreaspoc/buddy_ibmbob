"""Bounded, offline rendering of the report's already rendered print document."""
import asyncio
import os
import re
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

MAX_BODY_BYTES = 30_001_000  # JSON escaping can expand a character to six bytes.
_render_slots = asyncio.Semaphore(2)


class ResearchPDFSpec(BaseModel):
    html: str = Field(min_length=1, max_length=5_000_000)
    format: Literal['pdf', 'html'] = 'pdf'
    ui_language: str = Field(default='en', pattern=r'^(en|el|hi|mt)$')


async def bounded_payload(request: Request):
    try:
        if int(request.headers.get('content-length', '0')) > MAX_BODY_BYTES:
            raise HTTPException(413, 'Report document is too large')
    except ValueError:
        raise HTTPException(400, 'Invalid Content-Length')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(413, 'Report document is too large')
    try:
        return ResearchPDFSpec.model_validate_json(bytes(body))
    except ValidationError as exc:
        raise HTTPException(422, 'Supply report HTML and a supported UI language') from exc


def pdf_filename(title):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', ' ', str(title or 'Research report'))
    name = ' '.join(name.split()).strip('. ') or 'Research report'
    return name[:196].rstrip('. ') + '.pdf'


async def _render(document):
    from playwright.async_api import async_playwright
    # First policy wins cumulatively, even if the supplied document includes CSP.
    policy = ("default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
              "img-src data:; font-src data:; frame-src 'none'; object-src 'none'; "
              "connect-src 'none'; base-uri 'none'; form-action 'none'")
    protected = '<meta http-equiv="Content-Security-Policy" content="' + policy + '">' + document
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(
            executable_path=os.getenv('RESEARCH_CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'])
        try:
            context = await browser.new_context(java_script_enabled=False, service_workers='block', offline=True)
            await context.route('**/*', lambda route: route.abort())
            page = await context.new_page()
            page.set_default_timeout(20_000)
            await page.set_content(protected, wait_until='load', timeout=20_000)
            await page.emulate_media(media='print')
            return await page.pdf(format='A4', print_background=True, prefer_css_page_size=True)
        finally:
            await browser.close()


async def render_pdf(document):
    acquired = False
    try:
        await asyncio.wait_for(_render_slots.acquire(), timeout=0.25)
        acquired = True
        return await asyncio.wait_for(_render(document), timeout=45)
    except Exception as exc:
        raise HTTPException(503, 'PDF creation is temporarily unavailable. Please try again.') from exc
    finally:
        if acquired:
            _render_slots.release()
