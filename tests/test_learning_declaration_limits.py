"""Untrusted declaration checks retain rejection behavior without quadratic retries."""
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest


class DeclarationLimitTests(unittest.TestCase):
    def test_declaration_pattern_preserves_security_decisions(self):
        previous = re.compile(r'<!\s*DOCTYPE\s+[^>]*\[', re.I)
        hardened = re.compile(r'<!\s*DOCTYPE\s++[^>\[]*+\[', re.I)
        for gap in ('', ' ', '\t\n', '   '):
            for name in ('html', '', 'html PUBLIC "external"', '[', 'html>'):
                for tail in ('', '[', '[]>', '> [', '\n[subset]>'):
                    value = '<!' + gap + 'DOCTYPE' + gap + name + tail
                    with self.subTest(value=value):
                        self.assertEqual(bool(previous.search(value)), bool(hardened.search(value)))

    def test_long_near_misses_finish_in_bounded_subprocess(self):
        root = Path(__file__).resolve().parents[1]
        script = '''
from buddy_learning.epub import _xml, parse_epub
from buddy_learning.documents import parse_document
from tests.test_learning_epub import epub
source = b'<!DOCTYPE ' + b' ' * 800000 + b'html><html><body>Safe</body></html>'
try:
    _xml(source)
except ValueError:
    pass
book = parse_document(source, 'near-miss.html')
assert book['chapters']
book = parse_epub(epub(first=source))
assert book['chapters']
for bad in (b'<!DOCTYPE html [', b'<!DOCTYPE ' + b' ' * 800000 + b'html ['):
    try:
        parse_document(bad + b'<html>unsafe</html>', 'bad.html')
    except ValueError:
        pass
    else:
        raise AssertionError('Internal subset was accepted')
'''
        env = dict(os.environ, PYTHONPATH=os.pathsep.join([str(root / 'plugins/learning'), str(root)]))
        subprocess.run([sys.executable, '-c', script], cwd=root, env=env,
                       check=True, timeout=10, capture_output=True, text=True)
