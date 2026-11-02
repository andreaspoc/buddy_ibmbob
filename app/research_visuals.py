"""Bounded, read-only screenshots of public research sources."""
import asyncio
import hashlib
import os
from pathlib import Path
from datetime import datetime, timezone
from app.research_sources import validate_public_url

async def capture_screenshot(url, workspace):
    from playwright.async_api import async_playwright
    await asyncio.to_thread(validate_public_url, url)
    path = 'research-images/' + hashlib.sha256(url.encode()).hexdigest()[:24] + '.png'
    target = Path(workspace) / path
    target.parent.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('RESEARCH_CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            context = await browser.new_context(viewport={'width':1280,'height':900}, accept_downloads=False, service_workers='block')
            async def guard(route):
                if route.request.method not in {'GET','HEAD'}:
                    await route.abort(); return
                try:
                    await asyncio.to_thread(validate_public_url, route.request.url)
                    await route.continue_()
                except (ValueError, OSError):
                    await route.abort()
            await context.route('**/*', guard)
            async def block_socket(socket):
                await socket.close()
            await context.route_web_socket('**/*', block_socket)
            page = await context.new_page()
            async with asyncio.timeout(40):
                response = await page.goto(url, wait_until='domcontentloaded', timeout=25000)
                if not response or response.status >= 400: raise ValueError('Source could not be opened for screenshot')
                await asyncio.to_thread(validate_public_url, page.url)
                await page.screenshot(path=str(target), full_page=False, animations='disabled', timeout=10000)
                return {'path':path,'url':page.url,'requested_url':url,'title':await page.title(), 'captured_at':datetime.now(timezone.utc).isoformat(),'kind':'website_screenshot'}
        finally:
            await browser.close()
