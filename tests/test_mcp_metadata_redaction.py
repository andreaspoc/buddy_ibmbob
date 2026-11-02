"""Tool schemas keep named credential inputs while actual secrets stay masked."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from app.mcp_broker import execute
from app.redaction import redact
from jsonschema import Draft202012Validator

class MetadataRedactionTests(unittest.TestCase):
    def test_tool_schema_survives_broker_redaction(self):
        secret = 'actual-private-api-key'
        schema = {'type':'object','properties':{'formToken':{'type':'string'},'formPassword':{'type':'string'},'nested':{'type':'object','properties':{'api_key':{'type':'string'}}}},'required':['formToken']}
        tool = SimpleNamespace(model_dump=lambda **kwargs: {'name':'get_form','description':'Configured credential: '+secret,'inputSchema':schema})
        session = SimpleNamespace(list_tools=AsyncMock(return_value=SimpleNamespace(tools=[tool],nextCursor=None)))
        result = asyncio.run(execute({'env':{'MONDAY_TOKEN':secret}},'tools',session=session))
        Draft202012Validator.check_schema(result[0]['inputSchema'])
        self.assertEqual(result[0]['inputSchema'],schema)
        self.assertNotIn(secret,str(result))
        self.assertIn('[redacted]',result[0]['description'])

    def test_operational_values_still_mask_sensitive_keys(self):
        self.assertEqual(redact({'formToken':'unknown-secret','nested':{'password':'unknown-password'}}),{'formToken':'[redacted]','nested':{'password':'[redacted]'}})

if __name__ == '__main__':
    unittest.main()
