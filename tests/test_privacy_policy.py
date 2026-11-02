"""Administrator data protection rules across outbound channels; no network or database."""
import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import conversation_sharing, email_review, execution_policy, job_queue, mcp_broker, mcp_microsoft, personal_data as pd, privacy_policy as pp, smtp_settings
from app.admin_users import administrator
from app.auth import current_user
from app.download_review import DownloadReviewMiddleware
from app.origin_policy import same_origin

CARD = '4111 1111 1111 1111'
PHONE = '99123456'
CARD_LABEL = 'Payment card number'
PHONE_LABEL = 'Phone number'


def policy(**changes):
    return pp._complete(pp.PrivacyPolicy(**changes))


def use(**changes):
    patcher = patch.object(pp, 'load_policy', return_value=policy(**changes))
    patcher.start()
    return patcher


class Decisions(unittest.TestCase):
    def setUp(self):
        self.addCleanup(use(categories={CARD_LABEL: 'block', PHONE_LABEL: 'allow'},
                            custom_rules=[{'name': 'Atlas', 'terms': ['Προϊόν Άτλας'], 'action': 'block'},
                                          {'name': 'Watch', 'terms': ['watchword'], 'action': 'ask'}]).stop)

    def test_actions_apply_per_category(self):
        self.assertEqual(pp.review_text(f'{CARD} {PHONE} x@acme.example', 'email'), ([CARD_LABEL], ['Email address']))

    def test_custom_terms_ignore_case_and_accents(self):
        self.assertEqual(pp.review_text('το προιον ατλας', 'email'), (['Atlas'], []))
        self.assertEqual(pp.review_text('WATCHWORD', 'share'), ([], ['Watch']))

    def test_files_and_arguments(self):
        self.assertEqual(pp.review_file('a.txt', CARD.encode(), 'download')[0], [CARD_LABEL])
        self.assertEqual(pp.review_arguments({'to': 'a@b.example', 'notes': {'x': [CARD]}}, 'external_tool')[0], [CARD_LABEL])
        self.assertEqual(pp.review_email('watchword', 'hi', [], ('a.md', CARD), [('a.txt', 'x', None), ('b.bin', b'x', 'text/plain')]), ([CARD_LABEL], ['Watch']))

    def test_disabled_channel_skips_only_that_channel(self):
        self.addCleanup(use(channels={'download': False, 'email': False, 'share': False, 'external_tool': False}).stop)
        self.assertEqual(pp.review_file('a.txt', CARD.encode(), 'download'), ([], []))
        self.assertEqual(pp.review_text(CARD, 'share'), ([], []))
        self.assertEqual(pp.review_arguments({'b': CARD}, 'external_tool'), ([], []))
        self.assertEqual(pp.review_email('s', CARD, [], None, None), ([], []))
        self.assertEqual(pp.review_text(CARD, 'external_agent')[1], [CARD_LABEL])

    def test_validation(self):
        for bad in ({'categories': {'Nope': 'ask'}}, {'channels': {'nope': True}}, {'categories': {CARD_LABEL: 'maybe'}},
                    {'custom_rules': [{'name': 'x', 'terms': [' ']}]}, {'custom_rules': [{'name': 'x', 'terms': ['a' * 201]}]}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                pp.PrivacyPolicy(**bad)


class Loading(unittest.TestCase):
    def setUp(self):
        pp._cache = (0.0, None)
        self.addCleanup(setattr, pp, '_cache', (0.0, None))

    def _db(self, row):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = row
        context = MagicMock()
        context.__enter__.return_value = db
        return context, db

    def test_unavailable_policy_reviews_everything(self):
        with patch.object(pp, '_connect', side_effect=OSError):
            loaded = pp.load_policy()
        self.assertEqual(set(loaded['categories'].values()), {'ask'})
        self.assertTrue(all(loaded['channels'].values()))

    def test_stored_policy_is_cached(self):
        context, _ = self._db(({'categories': {CARD_LABEL: 'block'}},))
        with patch.object(pp, '_connect', return_value=context) as connect:
            self.assertEqual(pp.load_policy()['categories'][CARD_LABEL], 'block')
            pp.load_policy()
        connect.assert_called_once()

    def test_settings_from_removed_features_keep_other_rules(self):
        stored = {'categories': {CARD_LABEL: 'block', 'Person name': 'block'}, 'presidio_names': True}
        context, _ = self._db((stored,))
        with patch.object(pp, '_connect', return_value=context):
            loaded = pp.load_policy()
        self.assertEqual(loaded['categories'][CARD_LABEL], 'block')
        self.assertNotIn('Person name', loaded['categories'])

    def test_empty_table_uses_defaults(self):
        context, _ = self._db(None)
        with patch.object(pp, '_connect', return_value=context):
            self.assertEqual(pp.load_policy()['categories'][CARD_LABEL], 'ask')

    def test_admin_routes_audit_without_terms(self):
        context, db = self._db(None)
        app = FastAPI()
        app.include_router(pp.router)
        app.dependency_overrides[administrator] = lambda: {'username': 'admin'}
        app.dependency_overrides[same_origin] = lambda: None
        client = TestClient(app)
        with patch.object(pp, '_connect', return_value=context):
            self.assertIn(CARD_LABEL, client.get('/admin/privacy-policy').json()['available_categories'])
            saved = client.put('/admin/privacy-policy', json={'categories': {CARD_LABEL: 'block'}, 'custom_rules': [{'name': 'r', 'terms': ['secretword']}]})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()['categories'][CARD_LABEL], 'block')
        audit = [call for call in db.execute.call_args_list if 'bob_access_audit' in call.args[0]]
        self.assertEqual(len(audit), 1)
        self.assertNotIn('secretword', str(audit))
        self.assertEqual(client.put('/admin/privacy-policy', json={'categories': {'x': 'block'}}).status_code, 422)


class Enforcement(unittest.TestCase):
    config = smtp_settings.SMTPSettings(enabled=True, host='mail.example.com', from_address='s@example.com').model_dump()

    def setUp(self):
        self.addCleanup(use(categories={CARD_LABEL: 'block'}).stop)

    def test_block_defeats_confirmation_for_smtp(self):
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            with self.assertRaises(pd.PersonalDataBlocked) as caught:
                smtp_settings.send_message(self.config, 'a@example.com', 's', CARD, personal_data_confirmed=True)
            factory.assert_not_called()
        self.assertNotIn('4111', str(caught.exception))

    def test_certificates_stay_exempt(self):
        with patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            factory.return_value.__enter__.return_value.send_message.return_value = {}
            self.assertIn('accepted', smtp_settings.send_message(self.config, 'a@example.com', 's', CARD, certificate_delivery=True))

    def test_compose_route_reports_block(self):
        app = FastAPI()
        app.include_router(email_review.router)
        app.dependency_overrides[current_user] = lambda: {'username': 'owner'}
        client = TestClient(app)
        with patch.object(smtp_settings, 'load_config', return_value=self.config), patch.object(smtp_settings.smtplib, 'SMTP') as factory:
            response = client.post('/api/email/send', json={'to': 'a@example.com', 'subject': 's', 'body': CARD, 'personal_data_confirmed': True})
            factory.assert_not_called()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['detail']['code'], 'personal_data_blocked')
        scan = client.post('/api/email/scan-file', content=CARD, headers={'x-file-name': 'a.txt'}).json()
        self.assertEqual(scan, {'categories': [], 'blocked': [CARD_LABEL]})

    def test_outlook_block_defeats_token(self):
        with patch.object(mcp_microsoft, '_graph_request') as graph, self.assertRaises(PermissionError):
            mcp_microsoft.tool_send_email({'to': 'a@example.com', 'subject': 's', 'body': CARD, 'personal_data_approval': 'x'})
        graph.assert_not_called()

    def test_broker_marks_external_tools_for_review(self):
        _, blocked, ask = mcp_broker._prepare_outbound({'action': 'call', 'tool': 'slack_post', 'arguments': {'text': f'{CARD} {PHONE}'}})
        self.assertEqual((blocked, ask), ([CARD_LABEL], [PHONE_LABEL]))

    def test_external_agent_prompt(self):
        emit = AsyncMock()
        authorizer = execution_policy.ExecutionAuthorizer(username='owner', job_id='1', worker_token='t', emit=emit)
        with self.assertRaises(pd.PersonalDataBlocked):
            asyncio.run(authorizer.authorize({'action': 'a2a_ask', 'slug': 'a', 'prompt': CARD}))
        emit.assert_not_awaited()
        with patch.object(job_queue, 'assert_execution_active'), patch.object(job_queue, 'worker_approval_policy', return_value={'policy': {'mode': 'auto'}}), \
                patch.object(job_queue, 'create_approval') as create, patch.object(job_queue, 'auto_resolve_approval'), patch.object(job_queue, 'consume_execution_approval', return_value='approve'):
            asyncio.run(authorizer.authorize({'action': 'a2a_ask', 'slug': 'a', 'prompt': PHONE}))
        self.assertIn('external agent', create.call_args.args[2]['title'])

    def test_share_links(self):
        with patch.object(conversation_sharing, '_owned_snapshot', return_value={'title': 't', 'messages': []}), patch.object(conversation_sharing, 'markdown_export', return_value=CARD):
            with self.assertRaises(HTTPException) as blocked:
                conversation_sharing._review_share('s', 'owner', True)
        self.assertEqual(blocked.exception.status_code, 403)
        with patch.object(conversation_sharing, '_owned_snapshot', return_value={}), patch.object(conversation_sharing, 'markdown_export', return_value=PHONE):
            with self.assertRaises(HTTPException) as held:
                conversation_sharing._review_share('s', 'owner', False)
            self.assertEqual(held.exception.status_code, 409)
            conversation_sharing._review_share('s', 'owner', True)

    def test_download_block_defeats_confirmation(self):
        app = FastAPI()
        app.add_middleware(DownloadReviewMiddleware)

        @app.get('/file')
        def file():
            return Response(CARD, headers={'Content-Disposition': 'attachment; filename="a.txt"'})
        client = TestClient(app)
        held = client.get('/file', headers={'x-personal-data-confirmed': '1'})
        self.assertEqual(held.status_code, 403)
        self.assertEqual(held.headers['x-personal-data-review'], 'blocked')
        self.assertNotIn('4111', held.text)
        page = client.get('/file', headers={'sec-fetch-mode': 'navigate'})
        self.assertIn('blocks this file', page.text)
        self.assertNotIn('Download anyway', page.text)


if __name__ == '__main__':
    unittest.main()
