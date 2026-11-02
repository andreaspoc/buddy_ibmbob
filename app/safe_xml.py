"""Parse bounded Office XML parts without document type declarations."""
from xml.etree import ElementTree


class _OfficeTreeBuilder(ElementTree.TreeBuilder):
    def doctype(self, name, pubid, system):
        # The parser calls this before processing an internal subset, including
        # for UTF-16 input. Byte-pattern checks alone miss encoded declarations.
        raise ValueError('Document type declarations are not supported in Office XML')


def office_xml(raw):
    """Reject DTDs/entities; callers must retain their archive size limits."""
    return ElementTree.fromstring(raw, parser=ElementTree.XMLParser(target=_OfficeTreeBuilder()))
