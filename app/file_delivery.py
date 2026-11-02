"""Response policy for untrusted workspace files, independent of fetch/read access."""
from pathlib import PurePosixPath
from urllib.parse import quote

_ACTIVE_DOCUMENTS = {'.html', '.htm', '.xhtml', '.xml', '.xsl', '.xslt'}
_ACTIVE_MIME = {'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml'}


def file_headers(path, media_type):
    headers = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in _ACTIVE_DOCUMENTS or media_type in _ACTIVE_MIME:
        # Fetch still returns original bytes to the isolated editor/live preview.
        # Direct navigation must never execute an uploaded app-origin document.
        filename = PurePosixPath(path).name
        headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + quote(filename, safe='')
        headers['Content-Security-Policy'] = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    elif suffix == '.svg' or media_type == 'image/svg+xml':
        # Keep SVG figures usable as images while denying document privileges,
        # scripts, frames, forms, and external resources on direct navigation.
        headers['Content-Security-Policy'] = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    return headers
