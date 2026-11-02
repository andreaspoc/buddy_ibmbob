import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

from app import s3_client


class S3ClientTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            'BOB_S3_ENDPOINT': 'https://s3.example.test',
            'BOB_S3_ACCESS_KEY_ID': 'test-access',
            'BOB_S3_SECRET_ACCESS_KEY': 'test-secret',
        })
        self.environment.start()
        self.session = patch('boto3.session.Session')
        self.factory = self.session.start()
        self.cache = patch.multiple(s3_client, _identity=None, _client=None)
        self.cache.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.session.stop)
        self.addCleanup(self.cache.stop)

    def test_download_threads_and_later_jobs_reuse_one_pool(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            clients = list(pool.map(lambda _: s3_client.client(), range(32)))
        with ThreadPoolExecutor(max_workers=8) as pool:
            clients += list(pool.map(lambda _: s3_client.client(), range(32)))
        self.assertTrue(all(client is clients[0] for client in clients))
        self.factory.assert_called_once()
        config = self.factory.return_value.client.call_args.kwargs['config']
        self.assertEqual(config.max_pool_connections, 32)

    def test_credential_rotation_creates_a_new_pool(self):
        self.factory.return_value.client.side_effect = [MagicMock(), MagicMock()]
        first = s3_client.client()
        with patch.dict(os.environ, {'BOB_S3_SECRET_ACCESS_KEY': 'rotated'}):
            second = s3_client.client()
        self.assertIsNot(first, second)
        self.assertEqual(self.factory.call_count, 2)
        first.close.assert_not_called()  # In-flight readers must remain usable.

    def test_process_identity_does_not_reuse_parent_connections(self):
        first = s3_client.client()
        with patch.object(s3_client.os, 'getpid', return_value=-1):
            s3_client.client()
        self.assertEqual(self.factory.call_count, 2)

    def test_refuses_plain_http(self):
        with patch.dict(os.environ, {'BOB_S3_ENDPOINT': 'http://s3.example.test'}):
            with self.assertRaises(ValueError):
                s3_client.client()
        self.factory.assert_not_called()
