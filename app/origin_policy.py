"""Shared full-origin guard for browser writes."""
from fastapi import HTTPException, Request
from app.browser_security import browser_write_allowed


def same_origin(request: Request):
    if not browser_write_allowed(request):
        raise HTTPException(403, 'Cross-origin writes are not allowed')
