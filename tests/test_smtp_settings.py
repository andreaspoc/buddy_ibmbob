"""Shared SMTP security, secret handling, and submission boundaries (no real mail)."""
import asyncio
from contextlib import contextmanager, asynccontextmanager
import ssl
import smtplib
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app import smtp_settings, admin_users
from app.auth import current_user


class SMTPSettingsTests(TestCase):
    def config(self, **changes):
        return smtp_settings.SMTPSettings(enabled=True, host='mail.example.com', username='sender', password='secret', from_address='sender@example.com', **changes).model_dump()

    def test_secret_redacted_for_responses(self):
        result = smtp_settings.public_config(self.config())
        self.assertNotIn('password', result)
        self.assertTrue(result['password_configured'])
        self.assertFalse(smtp_settings.public_config({'password': ''})['password_configured'])

    def test_invalid_settings_rejected(self):
        for changes in ({'host': 'https://mail.example.com'}, {'host': 'mail.example.com:587'}, {'from_name': 'Sender\r\nBcc: other@example.com'}, {'from_address': 'invalid'}, {'port': 0}, {'security': 'insecure'}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                smtp_settings.SMTPSettings(**{**self.config(), **changes})

    def test_starttls_verifies_certificate_before_authentication(self):
        client = MagicMock()
        client.send_message.return_value = {}
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            factory.return_value.__enter__.return_value = client
            smtp_settings.send_message(self.config(), 'one@example.com, two@example.com', 'Hello', 'Content')
        factory.assert_called_once_with('mail.example.com', 587, timeout=20)
        context = client.starttls.call_args.kwargs['context']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual([call[0] for call in client.mock_calls], ['ehlo', 'starttls', 'ehlo', 'login', 'send_message'])
        message = client.send_message.call_args.args[0]
        self.assertEqual(message.get_content_type(), 'text/plain')
        self.assertEqual(client.send_message.call_args.kwargs['to_addrs'], ['one@example.com', 'two@example.com'])

    def test_implicit_tls_and_html(self):
        client = MagicMock()
        client.send_message.return_value = {}
        with patch.object(smtp_settings.smtplib, 'SMTP_SSL') as factory:
            factory.return_value.__enter__.return_value = client
            smtp_settings.send_message(self.config(security='tls', port=465), 'one@example.com', 'Hello', '<p>Content</p>', is_html=True)
        self.assertEqual(factory.call_args.kwargs['timeout'], 20)
        self.assertTrue(factory.call_args.kwargs['context'].check_hostname)
        client.starttls.assert_not_called()
        self.assertEqual(client.send_message.call_args.args[0].get_content_type(), 'text/html')

    def test_unauthenticated_plain_smtp(self):
        config = {**self.config(security='none'), 'username': '', 'password': ''}
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            client = factory.return_value.__enter__.return_value
            client.send_message.return_value = {}
            smtp_settings.send_message(config, 'one@example.com', 'Hello', 'Content')
        client.login.assert_not_called()
        client.starttls.assert_not_called()

    def test_invalid_message_never_opens_connection(self):
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            for recipient, subject in [('victim@example.com\r\nBcc: other@example.com', 'Hello'), ('one@example.com', 'Hello\nBcc: other@example.com'), ('', 'Hello')]:
                with self.subTest(recipient=recipient, subject=subject), self.assertRaises(ValueError):
                    smtp_settings.send_message(self.config(), recipient, subject, 'Content')
            with self.assertRaises(ValueError):
                smtp_settings.send_message({**self.config(), 'enabled': False}, 'one@example.com', 'Hello', 'Content')
        factory.assert_not_called()

    def test_delivery_failures_are_sanitized_and_never_retried(self):
        for failure in (smtplib.SMTPAuthenticationError(535, b'secret'), ssl.SSLError('secret'), OSError('secret'), smtplib.SMTPServerDisconnected('secret')):
            with self.subTest(failure=type(failure).__name__), patch.object(smtp_settings.smtplib, 'SMTP', side_effect=failure) as factory:
                with self.assertRaises(ValueError) as error:
                    smtp_settings.send_message(self.config(), 'one@example.com', 'Hello', 'Content')
                self.assertNotIn('secret', str(error.exception))
                factory.assert_called_once()

    def test_partial_refusal_does_not_retry(self):
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            client = factory.return_value.__enter__.return_value
            client.send_message.return_value = {'two@example.com': (550, b'rejected')}
            result = smtp_settings.send_message(self.config(), 'one@example.com,two@example.com', 'Hello', 'Content')
        self.assertIn('Do not resend automatically', result)
        client.send_message.assert_called_once()

    def test_existing_password_preserved_and_audit_redacted(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = self.config(),
        @contextmanager
        def connection():
            yield db
        body = smtp_settings.SMTPSettings(**{**self.config(), 'password': ''})
        with patch.object(smtp_settings, '_connect', connection), patch('app.mcp_access.ensure_schema'):
            result = smtp_settings.save_settings(body, {'username': 'admin'})
        self.assertTrue(result['password_configured'])
        for call in db.execute.call_args_list:
            if 'INSERT INTO bob_smtp_settings' in call.args[0]:
                self.assertEqual(call.args[1][0].obj['password'], 'secret')
            if 'INSERT INTO bob_access_audit' in call.args[0]:
                self.assertNotIn('password', call.args[1][3].obj)
            if 'INSERT INTO bob_mcp_registry' in call.args[0]:
                self.assertNotIn('secret', str(call.args[1][0].obj))

    def test_blank_username_clears_stored_password(self):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = self.config(),
        @contextmanager
        def connection():
            yield db
        body = smtp_settings.SMTPSettings(**{**self.config(), 'username': '', 'password': ''})
        with patch.object(smtp_settings, '_connect', connection), patch('app.mcp_access.ensure_schema'):
            result = smtp_settings.save_settings(body, {'username': 'admin'})
        self.assertFalse(result['password_configured'])
        saved = next(call.args[1][0].obj for call in db.execute.call_args_list if 'INSERT INTO bob_smtp_settings' in call.args[0])
        self.assertEqual(saved['password'], '')

    def test_broker_only_injects_database_into_trusted_smtp_module(self):
        from app import mcp_broker
        captured = []
        @asynccontextmanager
        async def stdio(params, **kwargs):
            captured.append(params.env)
            yield ('read', 'write')
        @asynccontextmanager
        async def session(*args):
            client = MagicMock()
            client.initialize = AsyncMock(return_value=MagicMock())
            yield client
        async def run():
            for name, args in [('smtp', ['-m', 'app.mcp_smtp']), ('other', ['-m', 'app.mcp_smtp']), ('smtp', ['-m', 'app.mcp_search'])]:
                async with mcp_broker.open_session({'command': 'python3', 'args': args}, server_name=name):
                    pass
        with patch.dict('os.environ', {'DATABASE_URL': 'postgresql://trusted/database', 'SMTP_PASSWORD': 'private'}), patch('mcp.client.stdio.stdio_client', stdio), patch('mcp.ClientSession', session):
            asyncio.run(run())
        self.assertEqual(captured[0]['DATABASE_URL'], 'postgresql://trusted/database')
        self.assertNotIn('DATABASE_URL', captured[1])
        self.assertNotIn('DATABASE_URL', captured[2])
        for env in captured:
            self.assertNotIn('SMTP_PASSWORD', env)

    def test_every_endpoint_requires_administrator(self):
        app = FastAPI()
        app.include_router(smtp_settings.router)
        app.dependency_overrides[current_user] = lambda: {'username': 'staff', 'is_admin': False}
        with TestClient(app) as client, patch.object(smtp_settings, 'load_config') as load, patch.object(smtp_settings, '_connect') as connect, patch.object(smtp_settings, 'send_message') as send:
            for method, path, body in [('get', '/admin/smtp', None), ('put', '/admin/smtp', self.config()), ('post', '/admin/smtp/test', {'to': 'one@example.com'})]:
                response = getattr(client, method)(path, **({'json': body} if body is not None else {}))
                self.assertEqual(response.status_code, 403, response.text)
            load.assert_not_called()
            connect.assert_not_called()
            send.assert_not_called()
        app.dependency_overrides[current_user] = lambda: {'username': 'admin', 'is_admin': True}
        with TestClient(app) as client, patch.object(smtp_settings, 'load_config', return_value=self.config()):
            response = client.get('/admin/smtp')
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('password', response.json())


if __name__ == '__main__':
    import unittest
    unittest.main()
