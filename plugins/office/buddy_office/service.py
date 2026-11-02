"""Office's independently released ASGI application."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import Depends
from fastapi.staticfiles import StaticFiles
from app.auth import current_user
from app.plugin_host import application
from . import __version__


def create_app():
    from .office import router as office, ensure_schema
    from .office_app_actions import router as app_actions
    from .office_ai import router as ai
    from .office_assistant import router as assistant
    from .office_proxy import router as editor

    @asynccontextmanager
    async def lifespan(app):
        await asyncio.to_thread(ensure_schema)
        yield

    app = application('office', __version__, lifespan)
    for router in (office, ai, assistant, editor, app_actions):
        app.include_router(router)

    @app.get('/api/office/chat-capabilities')
    async def capabilities(user: dict = Depends(current_user)):
        return {'version': 1, 'max_files': 3, 'read_only_snapshots': True,
                'import_conversation': True}

    for directory in ('office', 'office-bridge'):
        app.mount('/static/' + directory,
                  StaticFiles(directory=Path(__file__).parent / 'static' / directory), name=directory)
    return app
