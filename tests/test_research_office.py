import hashlib
import json
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path
from app.research_sources import collect_office, load_verified_evidence

class OfficeTests(unittest.TestCase):
    def test_denied_user_never_loads_any_token(self):
        with patch('app.mcp_access.get_authorized_server',return_value=None),patch('app.mcp_microsoft._load_and_refresh_token') as token:
            with self.assertRaises(PermissionError):collect_office('/tmp','alice','strategy')
        token.assert_not_called()

    def test_time_budget_exhaustion_never_loads_token(self):
        with patch('app.mcp_access.get_authorized_server',return_value={'name':'microsoft365'}),patch('app.microsoft_auth._user_token_file',return_value=Path('/private/alice/token')),patch('app.mcp_microsoft._load_and_refresh_token') as token,patch('time.monotonic',side_effect=[0,2]):
            with self.assertRaisesRegex(ValueError,'time budget'):
                collect_office('/tmp','alice','strategy',timeout_seconds=1)
            token.assert_not_called()

    @patch.dict('os.environ',{'RESEARCH_EVIDENCE_SECRET':'test-office-evidence-key'})
    def test_read_is_bound_to_user_token_and_signed(self):
        item={'id':'item1','name':'strategy.txt','file':{},'size':20,'webUrl':'https://tenant.sharepoint.com/strategy.txt'}
        search=MagicMock();search.json.return_value={'value':[item]}
        metadata=MagicMock();metadata.json.return_value=item
        download=MagicMock();download.__enter__.return_value=download;download.iter_bytes.return_value=[b'Actual Office strategy']
        client=MagicMock();client.__enter__.return_value=client;client.get.side_effect=[search,metadata];client.stream.return_value=download
        token_path=Path('/private/alice/.bob/tokens/microsoft.json')
        with tempfile.TemporaryDirectory() as root,patch('app.mcp_access.get_authorized_server',return_value={'name':'microsoft365'}),patch('app.microsoft_auth._user_token_file',return_value=token_path),patch('app.mcp_microsoft._load_and_refresh_token',return_value={'access_token':'alice-token'}) as token,patch('app.research_sources.httpx.Client',return_value=client):
            self.assertEqual(collect_office(root,'alice','strategy'),1)
            evidence=load_verified_evidence(root)
        self.assertTrue(all(call.args==(token_path,) for call in token.call_args_list))
        self.assertEqual(evidence[0]['kind'],'office')
        self.assertIn('Actual Office strategy',evidence[0]['text'])
        self.assertNotIn('alice-token',json.dumps(evidence))
        self.assertIn('/me/drive/items/item1',client.get.call_args.args[0])
        self.assertEqual(client.stream.call_args.kwargs['headers']['Authorization'],'Bearer alice-token')

if __name__=='__main__':unittest.main()
