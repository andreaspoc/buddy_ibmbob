"""Synthetic Office XML verifies declarations fail before entity expansion."""
import unittest
from xml.etree.ElementTree import ParseError

from app.safe_xml import office_xml


class OfficeXmlTests(unittest.TestCase):
    def test_namespaces_and_builtin_entities(self):
        root = office_xml(b'<w:p xmlns:w="urn:word"><w:t>A &amp; B</w:t></w:p>')
        self.assertEqual(root.find('{urn:word}t').text, 'A & B')

    def test_rejects_dtds_in_supported_encodings(self):
        declarations = [
            '<!DOCTYPE root [<!ENTITY value "expanded">]>',
            '<!DOCTYPE root [<!ENTITY value SYSTEM "file:///etc/passwd">]>',
            '<!DOCTYPE root SYSTEM "https://example.invalid/external.dtd">',
            '<!DOCTYPE root>',
        ]
        for encoding in ('utf-8', 'utf-16', 'utf-16-le', 'utf-16-be'):
            for declaration in declarations:
                with self.subTest(encoding=encoding, declaration=declaration):
                    raw = (declaration + '<root>&value;</root>').encode(encoding)
                    with self.assertRaisesRegex(ValueError, 'Document type'):
                        office_xml(raw)

    def test_parser_is_fresh_after_rejection(self):
        with self.assertRaises(ValueError):
            office_xml(b'<!DOCTYPE root><root/>')
        self.assertEqual(office_xml(b'<root>Safe</root>').text, 'Safe')

    def test_malformed_xml_is_rejected(self):
        with self.assertRaises(ParseError):
            office_xml(b'<root>')


if __name__ == '__main__':
    unittest.main()
