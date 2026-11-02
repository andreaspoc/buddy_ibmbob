"""Deterministic personal-data detection for outgoing email and file downloads.

Findings are category labels only. Matched values must never reach logs, errors,
approval titles or audit records. Detection is pattern based: free-text names and
similar unlabelled data are outside what it can recognise.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import re
import unicodedata
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree

logger = logging.getLogger('security.personal_data')

UNCHECKED = 'Content that could not be checked'
MAX_ARCHIVE_DEPTH = 2
MAX_ARCHIVE_MEMBERS = 500
MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
APPROVAL_KEY_ENV = 'BUDDY_PERSONAL_DATA_APPROVAL_KEY'
_TEXT_SUFFIXES = ('.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.yaml', '.yml', '.log', '.svg', '.bobdeck')
_OFFICE_TEXT_PART = re.compile(r'(word/(document|header\d*|footer\d*)|ppt/slides/slide\d+|ppt/notesSlides/notesSlide\d+)\.xml$')
_ROLE_MAILBOXES = frozenset({'info', 'support', 'noreply', 'no-reply', 'donotreply', 'admin', 'sales', 'contact', 'helpdesk', 'hello', 'office'})
_RECIPIENT_KEYS = frozenset({'to', 'cc', 'bcc', 'recipient', 'recipients'})
_IBAN_LENGTHS = {
    'AT': 20, 'BE': 16, 'BG': 22, 'CH': 21, 'CY': 28, 'CZ': 24, 'DE': 22, 'DK': 18, 'EE': 20, 'ES': 24,
    'FI': 18, 'FR': 27, 'GB': 22, 'GR': 27, 'HR': 21, 'HU': 28, 'IE': 22, 'IT': 27, 'LT': 20, 'LU': 20,
    'LV': 21, 'MT': 31, 'NL': 18, 'NO': 15, 'PL': 28, 'PT': 25, 'RO': 24, 'SE': 24, 'SI': 19, 'SK': 24,
}

_CARD = re.compile(r'(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])')
_IBAN = re.compile(r'(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}')
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}")
_PHONE = re.compile(r'(?<![\w+])(?:\+|00)\d[\d ()./-]{6,20}\d(?!\w)')
_PATTERNS = {
    'Social insurance number': re.compile(r'(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])|\b(?:ssn|social (?:security|insurance)(?: (?:number|no\.?))?|amka|αμκα|κοινωνικων ασφαλισεων)\b[^\w\n]{0,5}\w*\d[\w-]{3,}', re.I),
    'Tax identification number': re.compile(r'(?<![\w-])\d{8}[A-Z](?![\w-])|\b(?:tax (?:id|number|identification)|tin|αφμ|α\.φ\.μ\.?)\b[^\w\n]{0,5}\w*\d[\w-]{3,}'),
    'Identity document number': re.compile(r'\b(?:national id|id (?:number|no\.?|card)|identity (?:number|card)|passport(?: (?:number|no\.?))?|ταυτοτητ\w*|διαβατηρι\w*)\b[^\w\n]{0,12}[A-Za-z]{0,3}\d[\w-]{3,}', re.I),
    'Date of birth': re.compile(r'\b(?:date of birth|birth ?date|dob|born on|ημερομηνια γεννησης|ημ/νια γεννησης)\b[^\w\n]{0,5}\d{1,4}(?:[/.-]\d{1,2}[/.-]\d{1,4}| \w{3,12} \d{4})', re.I),
    'Phone number': re.compile(r'(?<![\w-])9[4-9]\d{6}(?![\w-])|\b(?:phone|tel|telephone|mobile|fax|τηλ\w*|κινητο)\b[^\w\n]{0,5}\d[\d ./-]{5,}', re.I),
    'Named person details': re.compile(r'\b(?:full name|first name|last name|surname|ονοματεπωνυμο|ονομα|επωνυμο)\s*[:=]\s*\S', re.I),
    'Home address': re.compile(r'\b(?:home address|residential address|postal address|διευθυνση κατοικιας)\s*[:=]\s*\S', re.I),
    'Salary or medical details': re.compile(r'\b(?:salary|diagnosis|medical record|μισθος|διαγνωση)\s*[:=]\s*\S', re.I),
}


CATEGORIES = (*_PATTERNS, 'Payment card number', 'Bank account number (IBAN)', 'Email address', UNCHECKED)


class PersonalDataBlocked(ValueError):
    """The administrator's policy forbids this content leaving; nobody can confirm it."""

    def __init__(self, categories):
        self.categories = sorted(set(categories))
        super().__init__('Blocked by data protection policy: this content contains ' + ', '.join(self.categories)
                         + '. It cannot be sent. Do not reword, split or encode the content to avoid this check.')


class PersonalDataFound(ValueError):
    """Sending needs an explicit decision by the person who owns the action."""

    def __init__(self, categories):
        self.categories = sorted(set(categories))
        super().__init__('Not sent: this email appears to contain personal data ('
                         + ', '.join(self.categories)
                         + '). The user must confirm before it can be sent. Do not reword, split or encode the content to avoid this check.')


class _HtmlText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        self.parts.extend(value for name, value in attrs if value and name in {'alt', 'title', 'href', 'value', 'placeholder', 'content'})


def _normalize(text: str) -> str:
    # Removes accents and invisible characters so simple obfuscation and Greek
    # tonos variants match the same patterns.
    decomposed = unicodedata.normalize('NFKD', text)
    return ''.join(char for char in decomposed if unicodedata.category(char) not in {'Mn', 'Cf'})


def normalized(text: str) -> str:
    return _normalize(text).casefold()


def _luhn(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2:
            value = value * 2 - 9 if value > 4 else value * 2
        total += value
    return total % 10 == 0


def _valid_card(match: str) -> bool:
    digits = re.sub(r'\D', '', match)
    return 13 <= len(digits) <= 19 and len(set(digits)) > 1 and _luhn(digits)


def _valid_iban(match: str) -> bool:
    compact = re.sub(r'[ -]', '', match).upper()
    length = _IBAN_LENGTHS.get(compact[:2])
    if not length or len(compact) < length:
        return False
    candidate = compact[:length]
    return int(''.join(str(int(char, 36)) for char in candidate[4:] + candidate[:4])) % 97 == 1


def _valid_phone(match: str) -> bool:
    return 8 <= len(re.sub(r'\D', '', match)) <= 15


def _third_party_email(address: str, allowed: frozenset[str]) -> bool:
    address = address.lower()
    return address not in allowed and address.partition('@')[0] not in _ROLE_MAILBOXES


def _scan_plain(text: str, allowed: frozenset[str]) -> set[str]:
    found = {label for label, pattern in _PATTERNS.items() if pattern.search(text)}
    if any(_valid_card(match) for match in _CARD.findall(text)):
        found.add('Payment card number')
    if any(_valid_iban(match) for match in _IBAN.findall(text)):
        found.add('Bank account number (IBAN)')
    if any(_valid_phone(match) for match in _PHONE.findall(text)):
        found.add('Phone number')
    if any(_third_party_email(match, allowed) for match in _EMAIL.findall(text)):
        found.add('Email address')
    return found


def _html_text(text: str) -> str:
    parser = _HtmlText()
    parser.feed(text)
    parser.close()
    return ' '.join(parser.parts)


def scan_text(text: str, recipients=(), detector=None) -> list[str]:
    """Return sorted categories. Recipients' own addresses are not findings.

    detector adds findings from administrator rules.
    """
    allowed = frozenset(item.strip().lower() for item in recipients if item.strip())
    found = _scan_plain(_normalize(text), allowed)
    if '<' in text or '&' in text:
        found |= _scan_plain(_normalize(_html_text(text)), allowed)
    if detector:
        found |= detector(text)
    return sorted(found)


def _xml_text(data: bytes) -> str:
    # Office parts never need a DTD; refusing one prevents entity-expansion attacks.
    if b'<!DOCTYPE' in data.upper():
        raise ValueError('document type declarations are not accepted')
    return ' '.join(text for text in ElementTree.fromstring(data).itertext() if text.strip())


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError('encrypted')
    text = '\n'.join(page.extract_text() or '' for page in reader.pages)
    if not text.strip():
        raise ValueError('no extractable text')
    return text


def _xlsx_text(data: bytes) -> str:
    from openpyxl import load_workbook
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        return '\n'.join(' | '.join('' if cell is None else str(cell) for cell in row)
                         for sheet in workbook.worksheets for row in sheet.iter_rows(values_only=True))
    finally:
        workbook.close()


def _archive_categories(data: bytes, recipients, depth: int, detector=None) -> set[str]:
    found: set[str] = set()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        # Declared sizes are bounded before any member is expanded (zip bombs).
        if (depth >= MAX_ARCHIVE_DEPTH or len(members) > MAX_ARCHIVE_MEMBERS
                or sum(item.file_size for item in members) > MAX_EXTRACTED_BYTES):
            return {UNCHECKED}
        for item in members:
            found.update(_scan_file(item.filename, archive.read(item), recipients, depth + 1, detector=detector))
    return found


def _office_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = [item for item in archive.infolist() if _OFFICE_TEXT_PART.match(item.filename)]
        if sum(item.file_size for item in members) > MAX_EXTRACTED_BYTES:
            raise ValueError('document too large')
        return '\n'.join(_xml_text(archive.read(item)) for item in members)


def _is_text(name: str, media_type: str) -> bool:
    return media_type.startswith('text/') or name.endswith(_TEXT_SUFFIXES) or media_type.split(';')[0].strip() in {
        'application/json', 'application/xml', 'application/javascript', 'image/svg+xml'}


def extract_text(filename: str, data: bytes, media_type: str = '') -> str:
    """Return a document's text; raises for anything that cannot be read."""
    name = (filename or '').lower()
    media_type = (media_type or '').lower()
    if name.endswith('.pdf') or media_type.startswith('application/pdf'):
        return _pdf_text(data)
    if name.endswith('.xlsx'):
        return _xlsx_text(data)
    if name.endswith(('.docx', '.pptx')):
        return _office_text(data)
    if _is_text(name, media_type):
        return data.decode('utf-8', errors='replace')
    raise ValueError('unsupported file type')


def _scan_file(filename: str, data: bytes, recipients, depth: int, media_type: str = '', detector=None) -> set[str]:
    try:
        if (filename or '').lower().endswith('.zip') or (media_type or '').lower().startswith('application/zip'):
            return _archive_categories(data, recipients, depth, detector)
        return set(scan_text(extract_text(filename, data, media_type), recipients, detector))
    except Exception:  # Malformed, encrypted and unsupported files fail safe to a person's review.
        logger.info('personal_data_unchecked_file')
    return {UNCHECKED}


def scan_file(filename: str, data: bytes, recipients=(), media_type: str = '', detector=None) -> list[str]:
    """Scan one file. Content that cannot be read is reported, never treated as clean."""
    return sorted(_scan_file(filename, data, recipients, 0, media_type, detector))


def is_email_tool(tool) -> bool:
    name = str(tool or '').lower()
    return 'mail' in name and any(verb in name for verb in ('send', 'reply', 'forward'))


def _recipient_values(value) -> list[str]:
    if isinstance(value, str):
        return [item for item in re.split(r'[,;]', value) if item.strip()]
    if isinstance(value, list):
        return [item for entry in value for item in _recipient_values(entry)]
    return []


def scan_tool_arguments(arguments: dict, detector=None) -> list[str]:
    """Scan every text value in an email tool call, including unknown connectors' fields."""
    recipients = [item for key, value in arguments.items() if str(key).lower() in _RECIPIENT_KEYS
                  for item in _recipient_values(value)]
    parts: list[str] = []

    def collect(value):
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect({key: value for key, value in arguments.items() if str(key).lower() not in _RECIPIENT_KEYS})
    return scan_text('\n'.join(parts), recipients, detector)


def _approval_digest(key: str, to, subject, body, is_html) -> str:
    encoded = json.dumps([to, subject, body, bool(is_html)], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hmac.new(key.encode('utf-8'), encoded, hashlib.sha256).hexdigest()


def approval_token(key: str, to, subject, body, is_html=False) -> str:
    """Prove to a connector process that the owner approved this exact email."""
    return _approval_digest(key, to, subject, body, is_html)


def approval_valid(key, token, to, subject, body, is_html=False) -> bool:
    return bool(key and token) and hmac.compare_digest(str(token), _approval_digest(key, to, subject, body, is_html))
