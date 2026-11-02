"""Synthetic fixtures for offline visual DOCX/PDF rendering."""
import asyncio
import base64
import io
import json
import os
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from fastapi import HTTPException

from app.visual_document_export import docx_document, render_document

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aemkAAAAASUVORK5CYII=')
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


class DocxStructureTests(unittest.TestCase):
    def test_native_tables_images_styles_and_xml_escaping(self):
        blocks = [{'type': 'heading', 'level': 2, 'runs': [{'text': 'Readable <heading>'}]},
                  {'type': 'table', 'rows': [[{'runs': [{'text': 'Owner'}], 'header': True}, {'runs': [{'text': 'Status'}], 'header': True}],
                                             [{'runs': [{'text': 'A & B'}]}, {'runs': [{'text': 'Ready', 'bold': True}]}]]},
                  {'type': 'image', 'id': 'diagram', 'alt': 'Flow "overview"'}]
        raw = docx_document('Fixture', blocks, {'diagram': PNG})
        with ZipFile(io.BytesIO(raw)) as archive:
            document = archive.read('word/document.xml')
            root = ET.fromstring(document)
            self.assertEqual(len(root.findall('.//' + W + 'tbl')), 1)
            self.assertEqual(len(root.findall('.//' + W + 'tr')), 2)
            self.assertEqual(len(root.findall('.//' + W + 'tblHeader')), 1)
            self.assertIn('A & B', ''.join(root.itertext()))
            self.assertIn('word/media/diagram1.png', archive.namelist())
            self.assertEqual(archive.read('word/media/diagram1.png'), PNG)
            ET.fromstring(archive.read('word/_rels/document.xml.rels'))
            styles = ET.fromstring(archive.read('word/styles.xml'))
            self.assertIn('7B00E0', archive.read('word/styles.xml').decode())
            self.assertNotIn(b'<w:sz', document)  # Heading sizes inherit styles.
            self.assertNotIn(b'vbaProject', b' '.join(name.encode() for name in archive.namelist()))

    def test_table_and_image_bounds(self):
        with self.assertRaises(HTTPException):
            docx_document('Fixture', [{'type': 'table', 'rows': [[{'runs': []}] * 31]}], {})
        with self.assertRaises(ValueError):
            docx_document('Fixture', [{'type': 'image', 'id': 'broken'}], {'broken': b'not-a-png'})


class ExportBoundsTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_format_and_oversized_body_fail_before_browser(self):
        for args in [('Fixture', 'body', 'exe'), ('Fixture', 'x' * 200001, 'pdf')]:
            with self.assertRaises(HTTPException):
                await render_document(*args)


@unittest.skipUnless(os.getenv('RUN_VISUAL_EXPORT_BROWSER_TESTS') == '1', 'Set RUN_VISUAL_EXPORT_BROWSER_TESTS=1 with Chromium installed')
class VisualBrowserTests(unittest.IsolatedAsyncioTestCase):
    def body(self):
        flow = {'id': 'flow', 'kind': 'flow', 'title': 'Ticket flow', 'direction': 'LR', 'layout': 'swimlane',
                'lanes': [{'id': 'team', 'label': 'Support team'}],
                'nodes': [{'id': 'start', 'label': 'Receive', 'lane': 'team', 'shape': 'rounded'}, {'id': 'end', 'label': 'Resolve', 'lane': 'team', 'shape': 'database'}],
                'edges': [{'id': 'route', 'source': 'start', 'target': 'end', 'label': 'Process'}]}
        sequence = '\n'.join(json.dumps(record) for record in [
            {'type': 'diagram', 'id': 'seq', 'kind': 'sequence', 'title': 'Request', 'direction': 'LR'},
            {'type': 'node', 'id': 'user', 'label': 'User'}, {'type': 'node', 'id': 'buddy', 'label': 'Buddy'},
            {'type': 'edge', 'id': 'send', 'source': 'user', 'target': 'buddy', 'label': 'Create document'}])
        headers = '| ' + ' | '.join('Column ' + str(index) for index in range(1, 13)) + ' |'
        table = headers + '\n|' + '---|' * 12 + '\n| ' + ' | '.join('Value ' + str(index) for index in range(1, 13)) + ' |'
        return ('## Readable report\n\n**Real headings**, lists and tables.\n\n' + table +
                '\n\n```mermaid\nflowchart LR\nA["Review"] -->|"Approve"| B["Publish"]\n```\n\n```bobdiagram\n' + json.dumps(flow) +
                '\n```\n\n```bobdiagram\n' + sequence + '\n```\n\n<script>window.exportAttack=true</script>\n\n![Remote](https://invalid.example/image.png)\n')

    async def test_docx_has_rendered_flow_sequence_and_native_split_tables(self):
        raw = await render_document('Visual fixture', self.body(), 'docx')
        with ZipFile(io.BytesIO(raw)) as archive:
            images = [name for name in archive.namelist() if name.startswith('word/media/')]
            self.assertEqual(len(images), 3)
            root = ET.fromstring(archive.read('word/document.xml'))
            text = ''.join(root.itertext())
            self.assertIn('Column 12', text)
            self.assertIn('first column repeats', text)
            self.assertGreaterEqual(len(root.findall('.//' + W + 'tbl')), 2)
            self.assertIn('External image omitted', text)
            self.assertIn('<script>', text)  # Literal data, not executed HTML.
            self.assertNotIn('could not be rendered', text)

    async def test_pdf_has_readable_tables_and_diagram_images(self):
        from pypdf import PdfReader
        raw = await render_document('Visual fixture', self.body(), 'pdf')
        reader = PdfReader(io.BytesIO(raw))
        text = '\n'.join(page.extract_text() or '' for page in reader.pages)
        self.assertIn('Buddy', text)
        self.assertIn('Column 12', text)
        self.assertIn('Publish', text)
        self.assertIn('Receive', text)
        self.assertNotIn('could not be rendered', text)

    async def test_dense_flow_has_readable_complete_node_and_connection_appendix(self):
        spec = {'id': 'dense', 'kind': 'flow', 'title': 'Detailed approval process', 'direction': 'LR',
                'nodes': [{'id': 'step' + str(index), 'label': 'Full readable step ' + str(index), 'shape': 'rectangle'} for index in range(20)],
                'edges': [{'id': 'edge' + str(index), 'source': 'step' + str(index), 'target': 'step' + str(index + 1), 'label': 'Connection ' + str(index)} for index in range(19)]}
        raw = await render_document('Dense fixture', '```bobdiagram\n' + json.dumps(spec) + '\n```', 'docx')
        with ZipFile(io.BytesIO(raw)) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
            text = ''.join(root.itertext())
            self.assertIn('overview is reduced to fit', text)
            self.assertIn('Diagram details', text)
            self.assertEqual(len(root.findall('.//' + W + 'tbl')), 2)
            for index in range(20): self.assertIn('Full readable step ' + str(index), text)
            for index in range(19): self.assertIn('Connection ' + str(index), text)
            self.assertNotIn('could not be rendered', text)
            self.assertEqual(len([name for name in archive.namelist() if name.startswith('word/media/')]), 1)

    async def test_invalid_diagram_falls_back_to_explicit_readable_source(self):
        raw = await render_document('Fallback', '```mermaid\nnot a supported diagram\n```', 'docx')
        with ZipFile(io.BytesIO(raw)) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
            text = ''.join(root.itertext())
            self.assertIn('Diagram could not be rendered', text)
            self.assertIn('not a supported diagram', text)
            self.assertFalse(any(name.startswith('word/media/') for name in archive.namelist()))


if __name__ == '__main__':
    unittest.main()
