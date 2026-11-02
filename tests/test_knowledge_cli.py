"""Knowledge socket protocol, limits, and cleanup without a real broker."""
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import AsyncMock, MagicMock, patch
from app import knowledge_cli


class KnowledgeCLITests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_missing_or_oversized_queries_and_missing_socket(self):
        for argv in (['knowledge'], ['knowledge', ' ']):
            with self.subTest(argv=argv), patch.object(knowledge_cli.sys, 'argv', argv), self.assertRaises(SystemExit):
                await knowledge_cli.main()
        with patch.object(knowledge_cli.sys, 'argv', ['knowledge', 'é' * 4097]), self.assertRaises(ValueError):
            await knowledge_cli.main()
        with patch.object(knowledge_cli.sys, 'argv', ['knowledge', 'hello']), patch.dict('os.environ', {}, clear=True), self.assertRaises(RuntimeError):
            await knowledge_cli.main()

    async def test_response_and_error_close_socket(self):
        for response, fails in (({'text': 'result'}, False), ({'error': 'unavailable'}, True)):
            reader = MagicMock()
            reader.readline = AsyncMock(return_value=json.dumps(response).encode() + b'\n')
            writer = MagicMock()
            writer.drain = AsyncMock()
            writer.wait_closed = AsyncMock()
            with self.subTest(response=response), patch.object(knowledge_cli.sys, 'argv', ['knowledge', 'question']), \
                 patch.dict('os.environ', {'BOB_KNOWLEDGE_SOCKET': '/tmp/fixture.sock'}), \
                 patch.object(knowledge_cli.asyncio, 'open_unix_connection', AsyncMock(return_value=(reader, writer))) as connect, redirect_stdout(io.StringIO()) as output:
                if fails:
                    with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                        await knowledge_cli.main()
                else:
                    await knowledge_cli.main()
                    self.assertEqual(output.getvalue(), 'result\n')
                connect.assert_awaited_once_with('/tmp/fixture.sock', limit=knowledge_cli.MAX_RESPONSE_BYTES)
                self.assertEqual(json.loads(writer.write.call_args.args[0]), {'query': 'question'})
                writer.close.assert_called_once()
                writer.wait_closed.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
