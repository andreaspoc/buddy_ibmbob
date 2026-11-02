"""Catch dashboards whose scripts cannot run, so people never get silently blank charts."""
from app.branding import brand_name
import hashlib
import html
import logging
import re
import subprocess  # nosec B404 - runs the fixed local node binary with no shell
import tempfile
from html.parser import HTMLParser
from pathlib import Path

logger = logging.getLogger(__name__)
BANNER_ID = 'bob-script-error'
CHECK_SECONDS = 20
MAX_REPORTED = 3
_BANNER = re.compile(r'<div id="' + BANNER_ID + r'"[^>]*>.*?</div>', re.S)
_JS_TYPES = {'', 'text/javascript', 'application/javascript', 'module'}
_SCRIPT = re.compile(r'(<script\b[^>]*>)(.*?)(</script>)', re.S | re.I)
_PAIRS = {'(': ')', '[': ']'}
CHART_VERSION = '4.4.4'
CHART_LIBRARY = Path(__file__).with_name('vendor').joinpath('chart.umd.min.js').read_text(encoding='utf-8')
MAX_EMBEDDED_BYTES = 1_900_000
# Only major version 4 or an unversioned URL: older pages may rely on an incompatible API.
_CHART_CDN_TAG = re.compile(
    r"""<script\b[^>]*\bsrc=["']https://(?:cdn\.jsdelivr\.net/npm/chart\.js|unpkg\.com/chart\.js|cdnjs\.cloudflare\.com/ajax/libs/Chart\.js/)"""
    r"""(?:@?4[^"'/]*|(?<=\.js/)4[^"'/]*)?(?:/[^"']*)?["'][^>]*>\s*</script>""", re.I)


def _is_identifier(char):
    return char.isalnum() or char in '_$'


class _InlineScripts(HTMLParser):
    """Collect inline JavaScript with the line it starts on; data blocks and external scripts are skipped."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts = []
        self._current = None

    def handle_starttag(self, tag, attrs):
        if tag != 'script':
            return
        values = dict(attrs)
        kind = (values.get('type') or '').strip().lower()
        if 'src' not in values and kind in _JS_TYPES:
            self._current = {'line': self.getpos()[0], 'module': kind == 'module', 'parts': []}

    def handle_data(self, data):
        if self._current is not None:
            self._current['parts'].append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self._current is not None:
            self.scripts.append(self._current)
            self._current = None


def inline_scripts(source):
    parser = _InlineScripts()
    parser.feed(source)
    parser.close()
    return parser.scripts


def _skip_non_code(code, start):
    """Index just past a string or comment starting at start, or start when there is none."""
    char = code[start]
    if code.startswith('//', start):
        end = code.find('\n', start)
        return len(code) if end < 0 else end
    if code.startswith('/*', start):
        end = code.find('*/', start + 2)
        return len(code) if end < 0 else end + 2
    if char not in '"\'`':
        return start
    index = start + 1
    while index < len(code):
        if code[index] == '\\':
            index += 1
        elif code[index] == char:
            return index + 1
        index += 1
    return len(code)


def _match_forward(code, opening):
    stack = []
    index = opening
    while index < len(code):
        following = _skip_non_code(code, index)
        if following != index:
            index = following
            continue
        char = code[index]
        if char in _PAIRS:
            stack.append(_PAIRS[char])
        elif char in _PAIRS.values():
            if not stack or stack.pop() != char:
                return -1
            if not stack:
                return index
        index += 1
    return -1


def _match_backward(code, closing):
    stack = []
    for index in range(closing, -1, -1):
        char = code[index]
        if char in _PAIRS.values():
            stack.append(char)
        elif char in _PAIRS:
            if not stack or stack.pop() != _PAIRS[char]:
                return -1
            if not stack:
                return index
    return -1


def _chain_start(code, end):
    index = end - 1
    while index >= 0:
        char = code[index]
        if char in _PAIRS.values():
            index = _match_backward(code, index)
            if index < 0:
                return -1
            index -= 1
        elif _is_identifier(char) or char == '.' or (char == '?' and code[index + 1:index + 2] == '.'):
            index -= 1
        else:
            break
    start = index + 1
    return start if start < end and not code[start].isdigit() else -1


def _assigned_member(code, after_operator):
    """Return (final member start, chain end) when the chain after ?. is assigned to."""
    index = last = after_operator
    while index < len(code):
        last = index
        if code[index] == '[':
            close = _match_forward(code, index)
            if close < 0:
                return None
            index = close + 1
        else:
            begin = index
            while index < len(code) and _is_identifier(code[index]):
                index += 1
            if begin == index:
                return None
        while code[index:index + 1] == '(':
            close = _match_forward(code, index)
            if close < 0:
                return None
            index = close + 1
        if code[index:index + 1] == '[':
            continue
        if code[index:index + 1] == '.':
            index += 1
            continue
        if code.startswith('?.', index):
            index += 2
            continue
        break
    after = index
    while after < len(code) and code[after].isspace():
        after += 1
    if code[after:after + 1] != '=' or code[after + 1:after + 2] in ('=', '>') or code[index - 1] == ')':
        return None
    return last, index


def repair_optional_assignments(code):
    """Rewrite the invalid a?.b.c = 1 as (a?.b ?? {}).c = 1, so one mistake cannot stop a whole script."""
    output = []
    copied = index = 0
    while index < len(code):
        following = _skip_non_code(code, index)
        if following != index:
            index = following
            continue
        member = None
        if code.startswith('?.', index) and not code[index + 2:index + 3].isdigit():
            member = _assigned_member(code, index + 2)
        start = _chain_start(code, index) if member else -1
        if member and start >= copied:
            last, end = member
            target = code[start:index if last == index + 2 else last]
            target = target[:-2] if target.endswith('?.') else target[:-1] if target.endswith('.') else target
            accessor = '' if code[last] == '[' else '.'
            output.append(f'{code[copied:start]}({target} ?? {{}}){accessor}{code[last:end]}')
            copied = index = end
        else:
            index += 1
    return ''.join(output) + code[copied:] if copied else code


def repair_scripts(source):
    """Repair inline JavaScript only; data blocks, external scripts and page text are left alone."""
    def fix(match):
        opening = match[1]
        kind = re.search(r"""\btype\s*=\s*["']?([^"'\s>]*)""", opening, re.I)
        if re.search(r'\bsrc\s*=', opening, re.I) or (kind and kind[1].lower() not in _JS_TYPES):
            return match[0]
        return opening + repair_optional_assignments(match[2]) + match[3]
    return _SCRIPT.sub(fix, source)


def _node_error(code, module, directory):
    path = Path(directory) / ('check.mjs' if module else 'check.cjs')
    path.write_text(code, encoding='utf-8')
    done = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True, timeout=CHECK_SECONDS, check=False)  # nosec B603 B607
    if done.returncode == 0:
        return None
    lines = done.stderr.splitlines()
    match = re.search(r':(\d+)\s*$', lines[0]) if lines else None
    message = next((line.strip() for line in lines if re.match(r'\s*\w*Error\b', line)), 'Syntax error')
    return (int(match[1]) if match else 1, message)


def script_errors(source):
    """Return syntax errors as page-relative messages. Checking is skipped, not failed, if node is unavailable."""
    errors = []
    try:
        with tempfile.TemporaryDirectory(prefix='dashboard-check-') as directory:
            for script in inline_scripts(source):
                found = _node_error(''.join(script['parts']), script['module'], directory)
                if found:
                    errors.append(f"line {script['line'] + found[0] - 1}: {found[1]}")
    except (OSError, subprocess.SubprocessError):
        logger.warning('Dashboard script check could not run', exc_info=True)
        return []
    return errors


def _banner(errors):
    details = '; '.join(html.escape(error) for error in errors[:MAX_REPORTED])
    return (f'<div id="{BANNER_ID}" role="alert" style="background:#ffe8eb;color:#9e1b2e;padding:14px 20px;'
            'font:600 14px/1.5 system-ui,sans-serif;border-bottom:2px solid #9e1b2e">'
            'This dashboard has a script error, so its charts and interactive parts cannot run. '
            f'Ask {brand_name()} to fix it. Details: {details}</div>')


def flag_script_errors(source):
    """Repair known script mistakes, then add a warning for what still cannot run, or remove a stale one."""
    clean = repair_scripts(_BANNER.sub('', source))
    errors = script_errors(clean)
    if not errors:
        return clean, []
    body = re.search(r'<body\b[^>]*>', clean, re.I)
    at = body.end() if body else 0
    return clean[:at] + _banner(errors) + clean[at:], errors


def embed_chart_library(source):
    """Replace a Chart.js 4 CDN tag with the bundled copy, so saved files draw charts with no internet access."""
    if len(source) + len(CHART_LIBRARY) > MAX_EMBEDDED_BYTES:
        return source
    embedded = f'<script id="buddy-chartjs" data-buddy-embedded="chart.js@{CHART_VERSION}">{CHART_LIBRARY}</script>'
    return _CHART_CDN_TAG.sub(lambda _: embedded, source)


def _candidates(workspace):
    return [path for path in Path(workspace).rglob('*.htm*') if path.is_file() and not path.is_symlink() and '.bob' not in path.parts]


def html_versions(workspace):
    return {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in _candidates(workspace)}


def flag_changed_html(workspace, before):
    """Check only HTML this job created or changed."""
    flagged = {}
    for path, digest in html_versions(workspace).items():
        if before.get(path) == digest:
            continue
        try:
            source = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        updated, errors = flag_script_errors(source)
        updated = embed_chart_library(updated)
        if updated != source:
            path.write_text(updated, encoding='utf-8')
        if errors:
            logger.warning('Generated page %s has script errors: %s', path.name, errors[:MAX_REPORTED])
            flagged[path.name] = errors
    return flagged
