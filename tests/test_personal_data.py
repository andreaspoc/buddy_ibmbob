"""Personal-data review for email and downloads; synthetic values, no network."""
import asyncio
import io
import os
import unittest
import zipfile
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app import download_review, email_review, execution_policy, job_queue, mcp_broker, mcp_microsoft, mcp_smtp, personal_data as pd, privacy_policy, smtp_settings
from app.auth import current_user
from app.download_review import DownloadReviewMiddleware

CARD = '4111 1111 1111 1111'


_policy_patch = patch.object(privacy_policy, 'load_policy', side_effect=lambda: privacy_policy._complete(privacy_policy.PrivacyPolicy()))


def setUpModule():
    # Hermetic: the review defaults apply, with no policy database.
    _policy_patch.start()


def tearDownModule():
    _policy_patch.stop()


def office(part='word/document.xml', text=CARD, wrapper='<w xmlns="urn:x"><t>{}</t></w>'):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(part, wrapper.format(text))
    return buffer.getvalue()


class TextDetection(unittest.TestCase):
    def test_categories_found(self):
        cases = {
            CARD: 'Payment card number', 'CY17 0020 0128 0000 0012 0052 7600 thanks': 'Bank account number (IBAN)',
            '+357 22 123456': 'Phone number', 'Τηλέφωνο: 22123456': 'Phone number', '99123456': 'Phone number',
            'Ημερομηνία γέννησης: 01/02/1990': 'Date of birth', 'passport no: K1234567': 'Identity document number',
            '123-45-6789': 'Social insurance number', 'tax id: 12345678A': 'Tax identification number',
            'Full name: Example Person': 'Named person details', 'home address: 1 Example St': 'Home address',
            'salary: 100': 'Salary or medical details', 'ask x@acme.example': 'Email address',
        }
        for text, label in cases.items():
            with self.subTest(text=text):
                self.assertIn(label, pd.scan_text(text))

    def test_ordinary_text_is_clean(self):
        for text in ('Meeting at 10 on 2026-11-01', 'Project name: Atlas', 'id 95123456-aaaa-bbbb', '4111 1111 1111 1112',
                     'CY00 0020 0128 0000 0012 0052 7600', '+357 12', 'write to support@acme.example', '1111111111111111',
                     'XX17 0020 0128 0000 0012 0052', 'CY17 0020 0128'):
            with self.subTest(text=text):
                self.assertEqual(pd.scan_text(text), [])

    def test_recipient_address_is_not_a_finding(self):
        self.assertEqual(pd.scan_text('copy to A@acme.example', ['a@acme.example', ' ']), [])

    def test_html_and_obfuscation_are_read(self):
        self.assertTrue(pd.scan_text('&#43;357 99 123456'))
        self.assertTrue(pd.scan_text('<a href="mailto:x@acme.example">y</a>'))
        self.assertTrue(pd.scan_text('<img alt="99123456"/>'))
        self.assertTrue(pd.scan_text('99​123456'))

    def test_tool_arguments_cover_unknown_fields(self):
        self.assertTrue(pd.is_email_tool('gmail_send') and pd.is_email_tool('reply_mail'))
        self.assertFalse(pd.is_email_tool('list_mail') or pd.is_email_tool(None))
        args = {'To': ['a@acme.example;'], 'body': 'for a@acme.example', 'nested': {'items': ['99123456']}, 'n': 3}
        self.assertEqual(pd.scan_tool_arguments(args), ['Phone number'])
        self.assertEqual(pd.scan_tool_arguments({'to': 3, 'body': 'hello'}), [])

    def test_approval_is_bound_to_exact_content(self):
        token = pd.approval_token('key', 'a', 's', 'b')
        self.assertTrue(pd.approval_valid('key', token, 'a', 's', 'b'))
        self.assertFalse(pd.approval_valid('key', token, 'a', 's', 'changed'))
        self.assertFalse(pd.approval_valid('other', token, 'a', 's', 'b'))
        self.assertFalse(pd.approval_valid(None, token, 'a', 's', 'b') or pd.approval_valid('key', '', 'a', 's', 'b'))


class FileDetection(unittest.TestCase):
    def test_text_office_and_archives(self):
        found = 'Payment card number'
        self.assertIn(found, pd.scan_file('a.txt', CARD.encode()))
        self.assertIn(found, pd.scan_file('blob', CARD.encode(), media_type='application/json; charset=utf-8'))
        self.assertIn(found, pd.scan_file('a.docx', office()))
        self.assertIn(found, pd.scan_file('a.pptx', office('ppt/slides/slide1.xml')))
        self.assertEqual(pd.scan_file('a.docx', office(text='hello')), [])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('dir/', '')
            archive.writestr('dir/a.txt', CARD)
        self.assertIn(found, pd.scan_file('a.zip', buffer.getvalue()))

    def test_spreadsheet(self):
        workbook = Workbook()
        workbook.active.append(['Card', CARD, None])
        buffer = io.BytesIO()
        workbook.save(buffer)
        self.assertIn('Payment card number', pd.scan_file('a.xlsx', buffer.getvalue()))

    def test_pdf(self):
        reader = MagicMock(is_encrypted=False, pages=[MagicMock(extract_text=lambda: CARD)])
        with patch('pypdf.PdfReader', return_value=reader):
            self.assertIn('Payment card number', pd.scan_file('a.pdf', b'x'))
        for state in (MagicMock(is_encrypted=True), MagicMock(is_encrypted=False, pages=[MagicMock(extract_text=lambda: '')])):
            with patch('pypdf.PdfReader', return_value=state):
                self.assertEqual(pd.scan_file('a.pdf', b'x'), [pd.UNCHECKED])

    def test_unreadable_content_is_never_clean(self):
        bomb = office(wrapper='<!DOCTYPE lol [<!ENTITY a "b">]><w>{}</w>')
        for name, data in (('a.png', b'x'), ('a.pdf', b'bad'), ('a.xlsx', b'bad'), ('a.docx', b'bad'), ('a.zip', b'bad'), ('a.docx', bomb)):
            with self.subTest(name=name):
                self.assertEqual(pd.scan_file(name, data), [pd.UNCHECKED])

    def test_archive_limits(self):
        with patch.object(pd, 'MAX_ARCHIVE_MEMBERS', 0):
            self.assertEqual(pd.scan_file('a.zip', office()), [pd.UNCHECKED])
        with patch.object(pd, 'MAX_EXTRACTED_BYTES', 1):
            self.assertEqual(pd.scan_file('a.docx', office()), [pd.UNCHECKED])
        nested = office()
        for _ in range(3):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                archive.writestr('inner.zip', nested)
            nested = buffer.getvalue()
        self.assertEqual(pd.scan_file('a.zip', nested), [pd.UNCHECKED])


class SmtpChokePoint(unittest.TestCase):
    config = smtp_settings.SMTPSettings(enabled=True, host='mail.example.com', from_address='sender@example.com').model_dump()

    def send(self, body='hello', **options):
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            client = factory.return_value.__enter__.return_value
            client.send_message.return_value = {}
            try:
                return smtp_settings.send_message(self.config, 'to@example.com', 'Subject', body, **options), client
            except pd.PersonalDataFound as exc:
                client.send_message.assert_not_called()
                return exc, client

    def test_findings_stop_sending_without_exposing_values(self):
        result, _ = self.send(CARD)
        self.assertIsInstance(result, pd.PersonalDataFound)
        self.assertEqual(result.categories, ['Payment card number'])
        self.assertNotIn('4111', str(result))

    def test_attachments_are_reviewed(self):
        self.assertIsInstance(self.send(markdown_attachment=('a.md', CARD))[0], pd.PersonalDataFound)
        self.assertIsInstance(self.send(attachments=[('a.txt', CARD, 'text/plain')])[0], pd.PersonalDataFound)
        self.assertIsInstance(self.send(attachments=[('a.docx', office(), None)])[0], pd.PersonalDataFound)

    def test_confirmation_and_certificates_send(self):
        for options in ({'personal_data_confirmed': True}, {'certificate_delivery': True}):
            result, client = self.send(CARD, **options)
            self.assertIsInstance(result, str)
            client.send_message.assert_called_once()
        self.send('hello')[1].send_message.assert_called_once()

    def test_mcp_tool_requires_valid_approval(self):
        with patch.object(mcp_smtp, 'load_config', return_value=self.config), patch.object(mcp_smtp, 'send_message') as send, patch.dict(os.environ, {pd.APPROVAL_KEY_ENV: 'key'}):
            mcp_smtp.smtp_send_email('a@example.com', 's', 'b', False, 'forged')
            self.assertFalse(send.call_args.kwargs['personal_data_confirmed'])
            mcp_smtp.smtp_send_email('a@example.com', 's', 'b', False, pd.approval_token('key', 'a@example.com', 's', 'b'))
            self.assertTrue(send.call_args.kwargs['personal_data_confirmed'])


class OutlookReview(unittest.TestCase):
    args = {'to': 'a@example.com', 'subject': 's', 'body': CARD}

    def test_review_required_then_approved(self):
        with patch.object(mcp_microsoft, '_graph_request', return_value=(202, {})) as graph, patch.dict(os.environ, {pd.APPROVAL_KEY_ENV: 'key'}):
            with self.assertRaises(PermissionError):
                mcp_microsoft.tool_send_email(self.args)
            with self.assertRaises(PermissionError):
                mcp_microsoft.tool_send_email({**self.args, 'personal_data_approval': 'forged'})
            graph.assert_not_called()
            token = pd.approval_token('key', 'a@example.com', 's', CARD)
            self.assertIn('successfully', mcp_microsoft.tool_send_email({**self.args, 'personal_data_approval': token}))


class ComposeRoutes(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(email_review.router)
        app.dependency_overrides[current_user] = lambda: {'username': 'owner'}
        self.client = TestClient(app)
        self.body = {'to': 'a@example.com', 'subject': 's', 'body': CARD}

    def test_finding_returns_decision_then_confirmed_send(self):
        config = SmtpChokePoint.config
        with patch.object(smtp_settings, 'load_config', return_value=config), patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            client = factory.return_value.__enter__.return_value
            client.send_message.return_value = {}
            held = self.client.post('/api/email/send', json=self.body)
            self.assertEqual(held.status_code, 409)
            self.assertEqual(held.json()['detail']['code'], 'personal_data')
            client.send_message.assert_not_called()
            self.assertEqual(self.client.post('/api/email/send', json={**self.body, 'personal_data_confirmed': True}).status_code, 200)
            client.send_message.assert_called_once()

    def test_invalid_send_and_file_scan(self):
        with patch.object(smtp_settings, 'load_config', return_value={'enabled': False}):
            self.assertEqual(self.client.post('/api/email/send', json=self.body).status_code, 400)
        response = self.client.post('/api/email/scan-file', content=CARD, headers={'x-file-name': 'a%20b.txt'})
        self.assertEqual(response.json()['categories'], ['Payment card number'])
        with patch.object(email_review, 'MAX_SCAN_BYTES', 1):
            self.assertEqual(self.client.post('/api/email/scan-file', content=CARD).json()['categories'], [pd.UNCHECKED])


def download_app():
    app = FastAPI()
    app.add_middleware(DownloadReviewMiddleware)

    @app.get('/file')
    def file(name: str = 'a.txt', content: str = CARD, encoded: str = ''):
        headers = {'Content-Disposition': f'attachment; filename="{name}"'}
        data = content.encode()
        if encoded == 'gzip':
            import gzip
            data = gzip.compress(data)
        if encoded:
            headers['Content-Encoding'] = encoded
        return Response(data, media_type='text/plain', headers=headers)

    @app.get('/starred')
    def starred():
        return Response(CARD, headers={'Content-Disposition': "attachment; filename*=UTF-8''a%20b.txt"})

    @app.get('/nameless')
    def nameless():
        return Response(b'x', headers={'Content-Disposition': 'attachment'})

    @app.get('/api/learning/certificates/1/download')
    def certificate():
        return Response(CARD, headers={'Content-Disposition': 'attachment; filename="c.txt"'})

    @app.get('/page')
    def page():
        return JSONResponse({'ok': CARD})
    return app


class DownloadMiddleware(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(download_app())

    def test_clean_files_and_pages_pass(self):
        self.assertEqual(self.client.get('/file', params={'content': 'hello'}).text, 'hello')
        self.assertEqual(self.client.get('/page').status_code, 200)
        self.assertEqual(self.client.get('/api/learning/certificates/1/download').text, CARD)

    def test_finding_is_held_without_content(self):
        held = self.client.get('/file')
        self.assertEqual(held.status_code, 409)
        self.assertEqual(held.headers['x-personal-data-review'], 'download')
        self.assertEqual(held.json()['detail']['categories'], ['Payment card number'])
        self.assertNotIn('4111', held.text)
        self.assertEqual(self.client.get('/starred').status_code, 409)
        self.assertEqual(self.client.get('/nameless').json()['detail']['categories'], [pd.UNCHECKED])

    def test_browser_navigation_gets_review_page(self):
        held = self.client.get('/file?name=a.txt', headers={'sec-fetch-mode': 'navigate'})
        self.assertEqual(held.status_code, 409)
        self.assertIn('Download anyway', held.text)
        self.assertIn('?name=a.txt&amp;personal_data_confirmed=1', held.text)
        self.assertIn('?personal_data_confirmed=1', self.client.get('/file', headers={'sec-fetch-mode': 'navigate'}).text)

    def test_confirmation(self):
        self.assertEqual(self.client.get('/file', headers={'x-personal-data-confirmed': '1'}).text, CARD)
        self.assertEqual(self.client.get('/file?personal_data_confirmed=1').text, CARD)
        self.assertEqual(self.client.get('/page?personal_data_confirmed=1').status_code, 200)
        self.assertEqual(self.client.get('/file?personal_data_confirmed=1', headers={'sec-fetch-site': 'cross-site'}).status_code, 409)

    def test_encoded_and_oversized_responses(self):
        self.assertEqual(self.client.get('/file', params={'encoded': 'gzip'}).status_code, 409)
        self.assertEqual(self.client.get('/file', params={'encoded': 'br'}).json()['detail']['categories'], [pd.UNCHECKED])
        with patch.object(download_review, 'MAX_EXTRACTED_BYTES', 1):
            self.assertEqual(self.client.get('/file', params={'encoded': 'gzip'}).json()['detail']['categories'], [pd.UNCHECKED])
        with patch.object(download_review, 'MAX_REVIEW_BYTES', 1):
            self.assertEqual(self.client.get('/file').json()['detail']['categories'], [pd.UNCHECKED])

    def test_websocket_scope_and_duplicate_body_pass_through(self):
        inner = AsyncMock()
        asyncio.run(DownloadReviewMiddleware(inner)({'type': 'websocket'}, None, None))
        inner.assert_awaited_once()
        sent = []

        async def app(scope, receive, send):
            await send({'type': 'http.response.start', 'headers': [(b'content-disposition', b'attachment; filename="a.txt"')]})
            await send({'type': 'http.response.body', 'body': b'hello'})
            await send({'type': 'http.response.body', 'body': b'late'})

        async def record(message):
            sent.append(message)
        asyncio.run(DownloadReviewMiddleware(app)({'type': 'http', 'path': '/', 'headers': []}, None, record))
        self.assertEqual([item.get('body') for item in sent], [None, b'hello'])


class AssistantApproval(unittest.IsolatedAsyncioTestCase):
    def test_broker_helpers(self):
        payload = {'action': 'call', 'tool': 'smtp_send_email', 'arguments': {'to': 'a@example.com', 'subject': 's', 'body': CARD, 'personal_data_approval': 'forged'}}
        prepared, blocked, ask = mcp_broker._prepare_outbound(payload)
        self.assertNotIn('personal_data_approval', prepared['arguments'])
        self.assertEqual((blocked, ask), ([], ['Payment card number']))
        self.assertEqual(mcp_broker._prepare_outbound({'action': 'tools'}), ({'action': 'tools'}, [], []))
        arguments = mcp_broker._approved_arguments('smtp', prepared)
        self.assertTrue(pd.approval_valid(mcp_broker._PERSONAL_DATA_KEY, arguments['personal_data_approval'], 'a@example.com', 's', CARD))
        external = {**prepared, 'tool': 'gmail_send'}
        self.assertNotIn('personal_data_approval', mcp_broker._approved_arguments('gmail', external))
        self.assertTrue(mcp_broker._blocked_result(['Phone number'])['isError'])

    async def test_personal_data_ignores_auto_approve_policy(self):
        emit = AsyncMock()
        authorizer = execution_policy.ExecutionAuthorizer(username='owner', job_id='1', worker_token='t', emit=emit)
        with patch.object(job_queue, 'assert_execution_active'), patch.object(job_queue, 'worker_approval_policy', return_value={'policy': {'mode': 'auto'}}), \
                patch.object(job_queue, 'create_approval') as create, patch.object(job_queue, 'auto_resolve_approval'), \
                patch.object(job_queue, 'consume_execution_approval', return_value='reject'):
            with self.assertRaises(PermissionError):
                await authorizer.authorize({'action': 'call', 'server': 'smtp', 'tool': 'smtp_send_email'}, None, personal_data=['Phone number'])
        event = create.call_args.args[2]
        self.assertTrue(event['mandatory'])
        self.assertEqual(event['personal_data'], ['Phone number'])
        self.assertIn('Send it anyway', event['title'])


if __name__ == '__main__':
    unittest.main()
