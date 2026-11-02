"""Bounded text projection for workspace search; never index hidden internals."""
import re
from pathlib import PurePosixPath

MAX_SEARCH_BYTES = 1024 * 1024
TEXT_SUFFIXES = {'.txt', '.md', '.html', '.htm', '.csv', '.tsv', '.json', '.mmd', '.mermaid', '.bobdeck'}


def searchable_text(path, content):
    parts = PurePosixPath(path).parts
    if any(part.startswith('.') or part in {'node_modules', '__pycache__', 'vendor'} for part in parts):
        return ''
    if PurePosixPath(path).suffix.lower() not in TEXT_SUFFIXES:
        return ''
    try:
        text = bytes(content[:MAX_SEARCH_BYTES]).decode('utf-8', errors='ignore')
    except (TypeError, ValueError):
        return ''
    if '\x00' in text:
        return ''
    if PurePosixPath(path).suffix.lower() in {'.html', '.htm'}:
        text = re.sub(r'<(script|style)\b[^>]*>.*?</\1\s*>', ' ', text, flags=re.I | re.S)
        text = re.sub(r'<[^>]+>', ' ', text)
    return text
