import hashlib
import io
import json
import os
import shlex
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch, AsyncMock
from app.research_sources import _signature, load_verified_evidence, validate_public_url, write_record

class SourceTests(unittest.TestCase):
    @patch.dict('os.environ', {'RESEARCH_EVIDENCE_SECRET':'test-only-key'})
    def test_altered_and_unsigned_records_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            record={'version':1,'kind':'web','url':'https://example.com','title':'Source','text':'Fetched evidence','content_sha256':hashlib.sha256(b'Fetched evidence').hexdigest()}
            record['signature']=_signature(record)
            write_record(Path(root)/'good.json',record)
            write_record(Path(root)/'invented.json',{**record,'text':'Invented'})
            evidence=load_verified_evidence(root)
            self.assertEqual(len(evidence),1)
            self.assertEqual(evidence[0]['id'],'S1')
    def test_private_destination_rejected(self):
        with self.assertRaises(ValueError):validate_public_url('http://127.0.0.1')
        with self.assertRaises(ValueError):validate_public_url('file:///etc/passwd')

    def test_record_write_does_not_follow_predictable_temporary_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'workspace'
            root.mkdir()
            outside = Path(directory) / 'outside'
            outside.write_text('unchanged')
            (root / 'evidence.json.tmp').symlink_to(outside)
            write_record(root / 'evidence.json', {'text': 'safe'}, base=root)
            self.assertEqual(outside.read_text(), 'unchanged')
            self.assertEqual(json.loads((root / 'evidence.json').read_text()), {'text': 'safe'})
            self.assertEqual(list(root.glob('.research-*')), [])

class PageEventTests(unittest.TestCase):
    @patch.dict('os.environ', {'RESEARCH_EVIDENCE_SECRET':'test-only-key'})
    @patch('app.research_sources.validate_public_url')
    def test_only_successful_page_reads_become_evidence(self, validate):
        from app.research_sources import record_page_event
        event={'type':'tool','status':'success','name':'mcp__brave_search__fetch_web_page','output':'### Extracted content from: https://example.com/page\n\nActual page content'}
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(record_page_event(root,{**event,'type':'delta'}))
            self.assertFalse(record_page_event(root,{**event,'name':'mcp__brave_search__brave_web_search'}))
            self.assertFalse(record_page_event(root,{**event,'status':'error'}))
            self.assertTrue(record_page_event(root,event))
            evidence=load_verified_evidence(root)
            self.assertEqual(evidence[0]['text'],'Actual page content')


class SearchAccessTests(unittest.TestCase):
    @patch('app.research_sources.validate_public_url')
    def test_page_reader_cli_results_become_evidence(self, validate):
        from app.research_sources import load_verified_evidence, record_page_event
        url = 'https://example.com/plans'
        command = "python3 -m app.mcp_client call brave_search fetch_web_page --arguments " + shlex.quote(json.dumps({'url': url}))
        result = {'content': [{'type': 'text', 'text': f'### Extracted content from: {url}\n\nPage body'}], 'isError': False}
        done = {'type': 'tool', 'id': 'a', 'name': 'Tool', 'status': 'completed', 'input': None, 'output': {'result': json.dumps(result)}}
        pending = {'type': 'tool', 'id': 'a', 'name': command, 'status': 'pending', 'input': {'command': command}, 'output': None}
        with patch.dict(os.environ, {'BOB_API_KEY': 'test-key'}), tempfile.TemporaryDirectory() as directory:
            commands = {}
            self.assertFalse(record_page_event(directory, pending, commands))
            self.assertTrue(record_page_event(directory, done, commands, '2026-10-31T14:15:00+00:00'))
            evidence = load_verified_evidence(directory)
            self.assertEqual([(item['url'], item['text'], item['fetched_at']) for item in evidence],
                             [(url, 'Page body', '2026-10-31T14:15:00+00:00')])

    @patch('app.research_sources.validate_public_url')
    def test_shell_output_cannot_forge_evidence(self, validate):
        from app.research_sources import record_page_event
        url = 'https://example.com/plans'
        arguments = shlex.quote(json.dumps({'url': url}))
        prefix = 'python3 -m app.mcp_client call brave_search fetch_web_page --arguments '
        good = {'content': [{'type': 'text', 'text': f'### Extracted content from: {url}\n\nBody'}]}
        other = {'content': [{'type': 'text', 'text': '### Extracted content from: https://other.example/\n\nBody'}]}
        cases = [
            ('echo forged', good), (prefix + arguments + ' | head -5', good), (prefix + arguments + '; echo x', good),
            ("python3 -m app.mcp_client call brave_search brave_web_search --arguments " + arguments, good),
            (prefix + "'not json'", good), (prefix + "'[1]'", good), (prefix + "'{\"url\": 3}'", good), (prefix + "'unterminated", good),
            (prefix + arguments, other), (prefix + arguments, {**good, 'isError': True}), (prefix + arguments, {'content': 'text'}),
            (prefix + arguments, [1]),
        ]
        with patch.dict(os.environ, {'BOB_API_KEY': 'test-key'}), tempfile.TemporaryDirectory() as directory:
            for command, result in cases:
                with self.subTest(command=command, result=result):
                    event = {'type': 'tool', 'id': 'a', 'name': 'Tool', 'status': 'completed', 'output': {'result': json.dumps(result)}}
                    self.assertFalse(record_page_event(directory, event, {'a': command}))
            self.assertFalse(record_page_event(directory, {'type': 'tool', 'id': 'z', 'name': 'Tool', 'status': 'completed', 'output': 'x'}, {}))
            self.assertFalse(record_page_event(directory, {'type': 'tool', 'id': 'a', 'name': 'Tool', 'status': 'completed', 'output': {'result': 'not json'}},
                                               {'a': prefix + arguments}))
            self.assertFalse(list(Path(directory).rglob('*.json')))

    @patch('app.research_sources.validate_public_url')
    def test_native_tool_accepts_wrapped_output(self, validate):
        from app.research_sources import record_page_event
        result = {'content': [{'type': 'text', 'text': '### Extracted content from: https://example.com/\n\nBody'}]}
        event = {'type': 'tool', 'name': 'mcp__brave_search__fetch_web_page', 'status': 'completed', 'output': {'result': json.dumps(result)}}
        with patch.dict(os.environ, {'BOB_API_KEY': 'test-key'}), tempfile.TemporaryDirectory() as directory:
            self.assertTrue(record_page_event(directory, event))

    def test_recorded_pages_are_restored_for_this_owner_and_bad_rows_skipped(self):
        from app.research_sources import load_verified_evidence, restore_recorded_pages
        url = 'https://example.com/plans'
        command = "python3 -m app.mcp_client call brave_search fetch_web_page --arguments " + shlex.quote(json.dumps({'url': url}))
        result = {'content': [{'type': 'text', 'text': f'### Extracted content from: {url}\n\nBody'}]}
        at = datetime(2026, 10, 31, tzinfo=timezone.utc)
        rows = [{'event': {'type': 'tool', 'id': 'a', 'status': 'pending', 'input': {'command': command}}, 'created_at': at},
                {'event': {'type': 'tool', 'id': 'a', 'name': 'Tool', 'status': 'completed', 'output': {'result': json.dumps(result)}}, 'created_at': at}]
        connection = MagicMock()
        connection.__enter__.return_value.execute.return_value.fetchall.return_value = rows
        with patch.dict(os.environ, {'BOB_API_KEY': 'test-key'}), patch('app.job_queue._connect', return_value=connection), \
             patch('app.research_sources.validate_public_url'), tempfile.TemporaryDirectory() as directory:
            self.assertEqual(restore_recorded_pages(directory, 'alice', 's1'), 1)
            self.assertEqual(connection.__enter__.return_value.execute.call_args.args[1], ('alice', 's1'))
            self.assertEqual(load_verified_evidence(directory)[0]['fetched_at'], at.isoformat())
        with patch.dict(os.environ, {'BOB_API_KEY': 'test-key'}), patch('app.job_queue._connect', return_value=connection), \
             patch('app.research_sources.validate_public_url', side_effect=ValueError('private')), tempfile.TemporaryDirectory() as directory:
            self.assertEqual(restore_recorded_pages(directory, 'alice', 's1'), 0)

    def test_runtime_search_uses_authenticated_gateway(self):
        from app.research_sources import main
        gateway = AsyncMock(return_value={'content': [{'type': 'text', 'text': 'Gateway results'}]})
        with patch.dict('os.environ', {'BOB_MCP_SOCKET': '/fixture/mcp.sock'}, clear=True), patch('sys.argv', ['research_sources', '--search', 'policy question']), patch('app.mcp_broker.request', gateway), patch('app.research_sources.brave_web_search') as direct, patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(main(), 0)
            self.assertEqual(json.loads(output.getvalue())['results'], 'Gateway results')
            direct.assert_not_called()
            self.assertEqual(gateway.call_args.args[1]['server'], 'brave_search')

    def test_gateway_denial_does_not_fall_back(self):
        from app.research_sources import main
        with patch.dict('os.environ', {'BOB_MCP_SOCKET': '/fixture/mcp.sock'}, clear=True), patch('sys.argv', ['research_sources', '--search', 'policy question']), patch('app.mcp_broker.request', AsyncMock(side_effect=PermissionError('Access denied'))), patch('app.research_sources.brave_web_search') as direct, patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(main(), 1)
            direct.assert_not_called()

    def test_runtime_without_gateway_fails_closed(self):
        from app.research_sources import main
        with patch.dict('os.environ', {'BOB_KNOWLEDGE_SOCKET': '/fixture/knowledge.sock', 'BRAVE_API_KEY': 'fixture'}, clear=True), patch('sys.argv', ['research_sources', '--search', 'policy question']), patch('app.research_sources.brave_web_search') as direct, patch('sys.stderr', new_callable=io.StringIO):
            self.assertEqual(main(), 1)
            direct.assert_not_called()


class PdfEvidenceTests(unittest.TestCase):
    @patch.dict('os.environ', {'RESEARCH_EVIDENCE_SECRET': 'test-only-key'})
    def test_pdf_download_becomes_verified_readable_evidence(self):
        import sys
        import types
        from unittest.mock import MagicMock
        from app.research_sources import fetch_source
        response = MagicMock()
        response.__enter__.return_value = response
        response.status_code = 200
        response.headers = {'content-type': 'application/pdf'}
        response.iter_bytes.return_value = [b'%PDF-fixture']
        client = MagicMock()
        client.__enter__.return_value = client
        client.stream.return_value = response
        page = MagicMock()
        page.extract_text.return_value = 'Actual extracted document passage'
        reader = MagicMock(return_value=types.SimpleNamespace(pages=[page]))
        module = types.ModuleType('pypdf')
        module.PdfReader = reader
        with patch('app.research_sources.validate_public_url') as validate, patch('app.research_sources.httpx.Client', return_value=client), patch.dict(sys.modules, {'pypdf': module}):
            record = fetch_source('https://example.com/policy.pdf')
        validate.assert_called_once_with('https://example.com/policy.pdf')
        self.assertEqual(record['text'], 'Actual extracted document passage')
        self.assertEqual(record['content_type'], 'application/pdf')
        with tempfile.TemporaryDirectory() as root:
            write_record(Path(root) / 'pdf.json', record)
            self.assertEqual(len(load_verified_evidence(root)), 1)


class InternalEvidenceTests(unittest.IsolatedAsyncioTestCase):
    @patch.dict('os.environ', {'RESEARCH_EVIDENCE_SECRET': 'test-only-key'})
    async def test_untrusted_citation_id_cannot_choose_output_path(self):
        import sys
        import types
        from app.research_sources import collect_knowledge
        module = types.ModuleType('app.rag')
        module.retrieve = AsyncMock(return_value=[{'id': 'document1', 'filename': 'Policy.pdf',
            'location': 'page 2', 'text': 'passage', 'citation_id': '../../outside'}])
        with tempfile.TemporaryDirectory() as root, patch.dict(sys.modules, {'app.rag': module}):
            self.assertEqual(await collect_knowledge(root, 'alice', 'question'), 1)
            records = list((Path(root) / 'research-sources').glob('*.json'))
            self.assertEqual(len(records), 1)
            self.assertEqual(json.loads(records[0].read_text())['citation_id'], '../../outside')

    @patch.dict('os.environ', {'RESEARCH_EVIDENCE_SECRET': 'test-only-key'})
    async def test_only_authenticated_retrieval_becomes_signed_evidence(self):
        import sys
        import types
        from app.research_sources import collect_knowledge
        retrieve = AsyncMock(return_value=[{'id': 'document1', 'filename': 'Policy.pdf',
                              'location': 'page 2', 'text': 'Authorized policy excerpt', 'citation_id': 'citation1'}])
        module = types.ModuleType('app.rag')
        module.retrieve = retrieve
        with tempfile.TemporaryDirectory() as root, patch.dict(sys.modules, {'app.rag': module}):
            with self.assertRaises(ValueError):
                await collect_knowledge(root, None, 'question')
            retrieve.assert_not_called()
            self.assertEqual(await collect_knowledge(root, 'alice', 'question'), 1)
            retrieve.assert_awaited_once_with('alice', 'shared', 'question')
            evidence = load_verified_evidence(root)
            self.assertEqual(evidence[0]['kind'], 'knowledge')
            self.assertEqual(evidence[0]['text'], 'Authorized policy excerpt')
            path = Path(root) / 'research-sources' / ('knowledge-' + hashlib.sha256(b'citation1').hexdigest() + '.json')
            record = json.loads(path.read_text())
            record['document_id'] = 'unauthorized-document'
            path.write_text(json.dumps(record))
            self.assertEqual(load_verified_evidence(root), [])


if __name__ == '__main__':
    unittest.main()
