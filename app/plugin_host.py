"""Shared authentication and readiness contract for versioned feature packages."""
import asyncio
from fastapi import FastAPI, HTTPException
from app.access_boundary import AccessBoundaryMiddleware


def application(service, version, lifespan):
    app = FastAPI(title=f'Buddy {service} plugin', version=version,
                  lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(AccessBoundaryMiddleware)

    @app.get('/health')
    async def health():
        return {'ok': True}

    @app.get('/ready')
    async def ready():
        def probe():
            from app import job_queue
            with job_queue._connect() as db:
                db.execute('SELECT 1')
        try:
            await asyncio.to_thread(probe)
        except Exception:
            raise HTTPException(503, 'Database unavailable') from None
        return {'ok': True}

    @app.get('/plugins/manifest')
    async def manifest():
        return {'id': service, 'version': version, 'runtime_api': 1,
                'schema': {'office': 'office', 'people': 'people_chat', 'projects': 'projects', 'learning': 'learning'}[service],
                'api_prefix': {'office': '/api/office', 'people': '/api/community', 'projects': '/api/projects', 'learning': '/api/learning'}[service]}
    return app
