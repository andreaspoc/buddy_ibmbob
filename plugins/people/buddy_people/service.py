"""People chat's independently released ASGI application."""
import asyncio
from contextlib import asynccontextmanager
from app.plugin_host import application
from . import __version__


def create_app():
    from .community import router, ensure_schema

    @asynccontextmanager
    async def lifespan(app):
        await asyncio.to_thread(ensure_schema)
        yield

    app = application('people', __version__, lifespan)
    app.include_router(router)
    return app
