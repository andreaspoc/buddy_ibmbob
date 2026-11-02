"""Validate HTML source without changing presentation markup, scripts or styles.

Render HTML only in a sandbox. Never allow scripts and same-origin access together.
"""
import re
from fastapi import HTTPException


def validate_html(raw):
    try:
        text = raw.decode('utf-8-sig')
        if '\x00' in text or raw.startswith((b'PK', b'%PDF-')) or not re.search(r'<(?:!doctype\s+html|html|head|body|div|section|p|h[1-6])(?:\s|>)', text, re.I):
            raise ValueError('Not an HTML document')
        return text
    except (UnicodeError, ValueError) as exc:
        raise HTTPException(422, 'Upload a valid UTF-8 HTML presentation') from exc
