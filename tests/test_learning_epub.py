"""Synthetic EPUB archives test bounded extraction and inert reader HTML."""
import io
import unittest
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
from unittest.mock import patch
from buddy_learning.epub import parse_epub, render_chapter

PNG = b'\x89PNG\r\n\x1a\n' + b'synthetic-raster-fixture'
CONTAINER = b'''<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'''
PACKAGE = b'''<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic Book</dc:title><dc:creator>Fixture Author</dc:creator></metadata><manifest><item id="second" href="two.xhtml" media-type="application/xhtml+xml"/><item id="first" href="one.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="image" href="images/cover.png" media-type="image/png"/><item id="badimage" href="images/bad.png" media-type="image/png"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>'''


def epub(extra=None, first=None, package=None, container=None):
    files = {'mimetype': b'application/epub+zip', 'META-INF/container.xml': container or CONTAINER,
             'OPS/book.opf': package or PACKAGE,
             'OPS/one.xhtml': first or b'<html><head><title>Old title</title></head><body><h1>Chapter One</h1><p>Chapter text.</p><a href="two.xhtml#part">Next</a><img src="images/cover.png" alt="Cover"/></body></html>',
             'OPS/two.xhtml': b'<html><body><h1 id="part">Chapter Two</h1></body></html>',
             'OPS/nav.xhtml': b'<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="one.xhtml">First section</a></li><li><a href="two.xhtml">Second section</a></li></ol></nav></body></html>',
             'OPS/images/cover.png': PNG, 'OPS/images/bad.png': b'<svg onload="bad()"/>'}
    files.update(extra or {})
    output = io.BytesIO()
    with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


class EpubTests(unittest.TestCase):
    def test_metadata_spine_order_navigation_and_raster(self):
        book = parse_epub(epub())
        self.assertEqual((book['title'], book['author']), ('Synthetic Book', 'Fixture Author'))
        self.assertEqual([c['path'] for c in book['chapters']], ['OPS/one.xhtml', 'OPS/two.xhtml'])
        self.assertEqual([c['title'] for c in book['chapters']], ['First section', 'Second section'])
        self.assertIn('OPS/images/cover.png', book['assets'])
        self.assertNotIn('OPS/images/bad.png', book['assets'])
        chapter = render_chapter(book, '0', 'book-id')
        self.assertIn('Chapter text.', chapter)
        self.assertIn('/api/learning/books/book-id/chapters/1#part', chapter)
        self.assertIn('/api/learning/books/book-id/assets/OPS/images/cover.png', chapter)

    def test_scripts_forms_svg_styles_events_and_remote_resources_are_removed(self):
        source = b'''<html><head><style>body{background:url(https://bad.test/track)}</style><script>bad()</script></head><body onload="bad()"><h1 style="color:red" onclick="bad()">Safe title</h1><script>scriptsecret</script><svg><foreignObject>svgsecret</foreignObject></svg><form action="https://bad.test"><input/><p>formsecret</p></form><iframe src="https://bad.test">framesecret</iframe><p>Safe text &amp; more</p><a href="javascript:bad()">Click</a><a href="https://bad.test/">External</a><img src="https://bad.test/track"/><img src="data:image/svg+xml,bad"/><img src="images/cover.png" onerror="bad()"/><div id="part" class="unsafe">Target</div></body></html>'''
        result = render_chapter(parse_epub(epub(first=source)), '0', 'id')
        for forbidden in ('onload', 'onclick', 'onerror', 'https://', 'javascript:', 'data:image', '<script', '<svg', '<form', '<iframe', 'scriptsecret', 'svgsecret', 'formsecret', 'framesecret', 'class="unsafe"', 'color:red'):
            self.assertNotIn(forbidden, result)
        self.assertIn('Safe text &amp; more', result)
        self.assertIn('id="part"', result)

    def test_escape_paths_duplicates_symlinks_and_invalid_zip_are_rejected(self):
        for name in ('../escape', '/absolute', 'OPS/../escape', 'OPS\\escape', 'OPS//double'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                parse_epub(epub({name: b'invalid'}))
        output = io.BytesIO()
        with ZipFile(output, 'w') as archive:
            entry = ZipInfo('link')
            entry.external_attr = (0o120777 << 16)
            archive.writestr(entry, 'target')
        with self.assertRaises(ValueError):
            parse_epub(output.getvalue())
        with self.assertRaises(ValueError):
            parse_epub(b'not a zip')
        output = io.BytesIO(epub())
        with ZipFile(output, 'a') as archive:
            archive.writestr('mimetype', b'application/epub+zip')
        with self.assertRaises(ValueError):
            parse_epub(output.getvalue())

    def test_drm_entities_and_external_package_uris_are_rejected(self):
        for name in ('META-INF/encryption.xml', 'META-INF/rights.xml'):
            with self.assertRaises(ValueError):
                parse_epub(epub({name: b'<encryption/>'}))
        with self.assertRaises(ValueError):
            parse_epub(epub(container=b'<!DOCTYPE root [<!ENTITY x "secret">]><container>&x;</container>'))
        with self.assertRaises(ValueError):
            parse_epub(epub(package=PACKAGE.replace(b'href="one.xhtml"', b'href="https://bad.test/book"')))
        with self.assertRaises(ValueError):
            parse_epub(epub(first=b'<!DOCTYPE html [<!ENTITY x "secret">]><html>&x;</html>'))
        # External XHTML and NCX DTD identifiers are inert: ElementTree and HTMLParser never fetch them.
        result = render_chapter(parse_epub(epub(first=b'<!DOCTYPE html PUBLIC "old" "https://bad.test/dtd"><html><body>Safe</body></html>')), '0', 'id')
        self.assertNotIn('bad.test', result)
        self.assertIn('Safe', result)
        ncx_dtd = b'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:test"/></head><docTitle><text>Test Title</text></docTitle><navMap><navPoint id="p1"><navLabel><text>Start Section</text></navLabel><content src="one.xhtml"/></navPoint></navMap></ncx>'
        ncx_package = PACKAGE.replace(b'<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>', b'<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        book_with_ncx = parse_epub(epub({'OPS/toc.ncx': ncx_dtd}, package=ncx_package))
        self.assertEqual(book_with_ncx['chapters'][0]['title'], 'Start Section')

    def test_expansion_and_entry_limits(self):
        with self.assertRaises(ValueError):
            parse_epub(epub({'OPS/bomb': b'x' * (2 * 1024 * 1024)}))
        with patch('buddy_learning.epub.MAX_ENTRY', 100), self.assertRaises(ValueError):
            parse_epub(epub())
        with patch('buddy_learning.epub.MAX_EXPANDED', 100), self.assertRaises(ValueError):
            parse_epub(epub())
        with patch('buddy_learning.epub.MAX_ENTRIES', 2), self.assertRaises(ValueError):
            parse_epub(epub())
        with patch('buddy_learning.epub.MAX_UPLOAD', 100), self.assertRaises(ValueError):
            parse_epub(epub())

    def test_unknown_chapters_font_bounds_and_local_fragment(self):
        book = parse_epub(epub(first=b'<p id="part">Read</p><a href="#part">Jump</a><a href="../../outside">No</a>'))
        with self.assertRaises(ValueError):
            render_chapter(book, 'missing', 'id')
        result = render_chapter(book, '0', 'id', 999)
        self.assertIn('font:32px', result)
        self.assertIn('/chapters/0#part', result)
        self.assertNotIn('../../outside', result)
        self.assertIn('font:18px', render_chapter(book, '0', 'id', 'invalid'))

    def test_monolithic_epub_splits_into_heading_chapters(self):
        single_doc = b'''<html><head><title>Full Doc</title></head><body>
            <p>Welcome to the guide.</p>
            <h1>Part One</h1><p>First section text.</p>
            <h1>Part Two</h1><p>Second section text.</p>
        </body></html>'''
        single_package = b'''<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Single Book</dc:title></metadata><manifest><item id="main" href="main.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="main"/></spine></package>'''
        book = parse_epub(epub({'OPS/main.xhtml': single_doc}, package=single_package))
        self.assertEqual(len(book['chapters']), 3)
        self.assertEqual(book['chapters'][0]['title'], 'Welcome to the guide.')
        self.assertEqual(book['chapters'][1]['title'], 'Part One')
        self.assertEqual(book['chapters'][2]['title'], 'Part Two')
        ch1 = render_chapter(book, '1', 'book-id')
        self.assertIn('First section text.', ch1)
        self.assertNotIn('Second section text.', ch1)


if __name__ == '__main__':
    unittest.main()
