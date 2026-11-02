"""Synthetic tests for drafting a private lesson from a document supplied at class creation."""
import json
import sys
import unittest
from contextlib import contextmanager
from types import ModuleType
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi.testclient import TestClient
from app.agent_budget import BudgetExceeded
from app.auth import current_user
from buddy_learning import lesson_ai, lessons, service
from buddy_learning.lesson_models import LessonInput

FOLDER = str(uuid4())
URL = f'/api/learning/folders/{FOLDER}/lesson-document-draft'
DOCUMENT = {'file': ('policy.txt', b'Synthetic security policy text', 'text/plain')}


def proposal():
    return LessonInput.model_validate({'title': 'Security policy', 'description': '', 'steps': [
        {'id': 's1', 'kind': 'text', 'title': 'Overview', 'text': 'Synthetic', 'url': '', 'asset_id': None}]})


class DocumentDraftHttpTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'fixture-teacher', 'is_admin': False}
        self.writes = []
        self.db = Mock()
        self.db.execute.side_effect = self.execute
        @contextmanager
        def connect():
            yield self.db
        self.addCleanup(patch.stopall)
        patch.object(service.job_queue, '_connect', connect).start()
        self.folder = patch.object(lessons.store, 'folder', return_value={'id': FOLDER}).start()
        self.role = patch.object(lessons.store, 'can_create', return_value=True).start()
        patch('app.auth.current_user', new=AsyncMock(side_effect=lambda request: self.user)).start()
        self.draft = patch.object(lesson_ai, 'draft', new=AsyncMock(return_value=(proposal(), False))).start()
        app = service.create_app()
        app.dependency_overrides[current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def execute(self, sql, params=None):
        cursor = Mock()
        cursor.fetchone.return_value = {'next_ord': 2, 'id': 'new-lesson', 'can_create_quizzes': True}
        if sql.startswith('INSERT INTO learning.lessons'):
            self.writes.append(params)
        return cursor

    def post(self, **data):
        return self.client.post(URL, files=DOCUMENT, data=data)

    def test_saves_private_draft_grounded_in_the_document(self):
        response = self.post(brief='Focus on passwords', language='el')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'id': 'new-lesson', 'title': 'Security policy', 'source_truncated': False, 'untranslated': []})
        request = self.draft.call_args.args[0]
        self.assertEqual(request.message, 'Focus on passwords')
        self.assertEqual(request.language, 'el')
        self.assertIn('Synthetic security policy text', request.current.steps[0].text)
        self.assertEqual(len(self.writes), 1)
        self.assertEqual(self.writes[0][2], 'Security policy')
        self.assertEqual(self.writes[0][4], 'fixture-teacher')
        self.assertEqual(self.writes[0][5], 2)

    def test_blank_brief_uses_default_request(self):
        self.assertEqual(self.post(brief='   ').status_code, 200)
        self.assertEqual(self.draft.call_args.args[0].message, lessons.DOCUMENT_DRAFT_BRIEF)

    def test_truncation_is_reported(self):
        self.draft.return_value = (proposal(), True)
        self.assertTrue(self.post().json()['source_truncated'])

    def test_learner_cannot_draft_and_ai_is_not_called(self):
        self.role.return_value = False
        self.assertEqual(self.post().status_code, 403)
        self.draft.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_unsupported_document_is_rejected_before_ai(self):
        response = self.client.post(URL, files={'file': ('run.exe', b'MZ', 'application/octet-stream')})
        self.assertEqual(response.status_code, 422)
        self.assertIn('could not read this document', response.json()['detail'])
        self.draft.assert_not_called()

    def test_empty_upload_is_rejected(self):
        response = self.client.post(URL, files={'file': ('empty.txt', b'', 'text/plain')})
        self.assertEqual(response.status_code, 422)
        self.draft.assert_not_called()

    def test_buddy_failures_save_nothing(self):
        for error, status in ((BudgetExceeded('Quota used'), 429), (TimeoutError(), 504), (ValueError('bad'), 502)):
            self.draft.side_effect = error
            self.assertEqual(self.post().status_code, status)
        self.assertEqual(self.writes, [])

    def test_upload_above_the_json_limit_passes_the_size_guard(self):
        large = {'file': ('policy.txt', ('é' * 600000).encode(), 'text/plain')}
        response = self.client.post(URL, files=large)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['source_truncated'])


class DocumentLessonTests(unittest.TestCase):
    def test_long_reference_keeps_only_the_readable_part(self):
        lesson, clipped = lessons.reference_lesson(b'word ' * 100000, 'long.txt')
        self.assertTrue(clipped)
        self.assertEqual(len(lesson.steps), 2)
        self.assertGreater(len(lessons.document_lesson(b'word ' * 100000, 'long.txt').steps), 2)

    def test_short_reference_is_not_clipped(self):
        lesson, clipped = lessons.reference_lesson(b'Short source', 'short.txt')
        self.assertFalse(clipped)
        self.assertIn('Short source', lesson.steps[0].text)

    def test_many_small_sections_are_capped_and_reported(self):
        steps = [lessons.Step(id=str(index), title='Section', text='x') for index in range(lessons.MAX_DOCUMENT_STEPS + 1)]
        with patch.object(lessons, 'document_sections', return_value=('Title', steps)):
            lesson, clipped = lessons.reference_lesson(b'', 'many.txt')
        self.assertTrue(clipped)
        self.assertEqual(len(lesson.steps), lessons.MAX_DOCUMENT_STEPS)

    def test_markup_is_reduced_to_text(self):
        lesson = lessons.document_lesson(b'<h1>Topic</h1><p>Body text</p>', 'page.html')
        combined = ' '.join(step.text for step in lesson.steps)
        self.assertIn('Body text', combined)
        self.assertNotIn('<p>', combined)


class SourceTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def run_draft(self, current):
        from buddy_learning.lesson_models import BuddyDraftRequest
        assistant = ModuleType('buddy_learning.assistant')
        assistant.completion = AsyncMock(return_value=json.dumps(proposal().model_dump(mode='json')))
        with patch.dict(sys.modules, {'buddy_learning.assistant': assistant}):
            await lesson_ai.draft(BuddyDraftRequest(message='Draft', current=current))
        return assistant.completion.call_args.kwargs

    async def run_replies(self, *replies):
        from buddy_learning.lesson_models import BuddyDraftRequest
        assistant = ModuleType('buddy_learning.assistant')
        assistant.completion = AsyncMock(side_effect=list(replies))
        with patch.dict(sys.modules, {'buddy_learning.assistant': assistant}):
            result = await lesson_ai.draft(BuddyDraftRequest(message='Draft', current=proposal()))
        return result, assistant.completion

    async def test_malformed_reply_is_retried_once(self):
        good = json.dumps(proposal().model_dump(mode='json'))
        (result, _), completion = await self.run_replies('{"title": broken', good)
        self.assertEqual(result.title, 'Security policy')
        self.assertEqual(completion.await_count, 2)

    async def test_second_malformed_reply_fails(self):
        with self.assertRaises(ValueError):
            await self.run_replies('{broken', '{still broken')

    async def test_reply_quoting_the_source_is_repaired_without_a_second_attempt(self):
        lesson = proposal().model_dump(mode='json')
        lesson['steps'][0]['text'] = 'QUOTE_HERE'
        reply = json.dumps(lesson).replace('QUOTE_HERE', 'Urgency ("Act now!") is a warning sign')
        (result, _), completion = await self.run_replies(reply)
        self.assertEqual(result.steps[0].text, 'Urgency ("Act now!") is a warning sign')
        self.assertEqual(completion.await_count, 1)

    async def test_source_grounded_draft_gets_the_longer_limit(self):
        self.assertEqual((await self.run_draft(proposal()))['timeout'], lesson_ai.SOURCE_DRAFT_SECONDS)

    async def test_brief_only_draft_keeps_the_default_limit(self):
        self.assertNotIn('timeout', await self.run_draft(None))


if __name__ == '__main__':
    unittest.main()
