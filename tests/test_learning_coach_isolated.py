"""Learning coach source scoping and error handling, without services or storage."""
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from buddy_learning import service


class LearningCoachTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder_id, self.book_id, self.quiz_id, self.lesson_id = (uuid4() for _ in range(4))
        self.user = {'username': 'teacher'}
        self.db = MagicMock()
        self.db.__enter__.return_value = self.db
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch('app.job_queue._connect', return_value=self.db))
        self.stack.enter_context(patch('buddy_learning.store.folder', return_value={'id': str(self.folder_id), 'name': 'Algebra'}))
        self.can_create = self.stack.enter_context(patch('buddy_learning.store.can_create', return_value=True))
        self.respond = self.stack.enter_context(patch('buddy_learning.assistant.respond', new_callable=AsyncMock, return_value=SimpleNamespace(reply='Helpful reply', draft=None)))

    async def test_teacher_document_context_is_limited_and_bound_to_folder(self):
        book = {'folder_id': str(self.folder_id), 'object_key': 'book-key', 'title': 'Course'}
        parsed = {'chapters': [{'id': '1', 'title': 'First'}, {'id': '2', 'title': 'Second'}]}
        with patch('buddy_learning.store.book', return_value=book), \
             patch('buddy_learning.service.parsed_book', return_value=parsed), \
             patch('buddy_learning.service.chapter_plain', side_effect=['x' * 30010, 'must not be read']) as plain:
            result = await service.chat(self.folder_id, service.ChatRequest(message='Explain', book_id=self.book_id), user=self.user)
        context = self.respond.await_args.kwargs['context']
        self.assertEqual(result, {'reply': 'Helpful reply'})
        self.assertTrue(context['source_documents_unchanged'])
        self.assertEqual(context['source']['id'], str(self.book_id))
        self.assertTrue(context['source']['truncated'])
        self.assertEqual(len(context['source']['excerpts'][0]['text']), 30000)
        self.assertEqual(plain.call_count, 1)

    async def test_student_receives_summary_not_quiz_answers_or_source(self):
        self.can_create.return_value = False
        quiz = {'folder_id': str(self.folder_id), 'created_by': 'teacher', 'status': 'published',
                'published': {'title': 'Quiz', 'questions': [{'id': 'q1', 'type': 'text', 'question': 'Why?', 'answer': 'secret'}]},
                'book_id': self.book_id, 'lesson_id': self.lesson_id}
        with patch('buddy_learning.store.quiz', return_value=quiz), patch('buddy_learning.service.public_quiz', return_value={'title': 'Quiz', 'questions': [{'id': 'q1', 'question': 'Why?'}]}):
            await service.chat(self.folder_id, service.ChatRequest(message='Help', quiz_id=self.quiz_id), user={'username': 'student'})
        context = self.respond.await_args.kwargs['context']
        self.assertEqual(context['quiz'], {'title': 'Quiz', 'status': 'published', 'question_count': 1})
        self.assertNotIn('source', context)
        self.assertFalse(self.respond.await_args.kwargs['can_create'])

    async def test_draft_source_is_overridden_and_role_rechecked_before_save(self):
        draft = SimpleNamespace(book_id=uuid4(), lesson_id=uuid4(), language='en')
        self.respond.return_value = SimpleNamespace(reply='Created', draft=draft)
        self.can_create.side_effect = [True, True]
        book = {'folder_id': str(self.folder_id), 'object_key': 'key', 'title': 'Book'}
        with patch('buddy_learning.store.book', return_value=book), \
             patch('buddy_learning.service.parsed_book', return_value={'chapters': []}), \
             patch('buddy_learning.service.save_quiz', return_value={'id': 'saved'}) as save:
            result = await service.chat(self.folder_id, service.ChatRequest(message='Draft', book_id=self.book_id, language='el'), user=self.user)
        self.assertEqual(result['quiz'], {'id': 'saved', 'is_creator': True})
        self.assertEqual(draft.book_id, self.book_id)
        self.assertIsNone(draft.lesson_id)
        self.assertEqual(draft.language, 'el')
        save.assert_called_once()

    async def test_revoked_role_prevents_draft_save(self):
        self.can_create.side_effect = [True, False]
        self.respond.return_value = SimpleNamespace(reply='Created', draft=SimpleNamespace())
        with patch('buddy_learning.service.save_quiz') as save:
            with self.assertRaises(HTTPException) as exc:
                await service.chat(self.folder_id, service.ChatRequest(message='Draft'), user=self.user)
        self.assertEqual(exc.exception.status_code, 403)
        save.assert_not_called()

    async def test_wrong_folder_is_rejected_before_model_call(self):
        with patch('buddy_learning.store.book', return_value={'folder_id': str(uuid4())}):
            with self.assertRaises(HTTPException) as exc:
                await service.chat(self.folder_id, service.ChatRequest(message='Help', book_id=self.book_id), user=self.user)
        self.assertEqual(exc.exception.status_code, 404)
        self.respond.assert_not_awaited()

    async def test_lesson_excerpts_use_creator_draft_and_preserve_truncation(self):
        row = {'folder_id': str(self.folder_id), 'created_by': 'teacher', 'title': 'Lesson',
               'draft': {'title': 'Draft'}, 'published': {'title': 'Published'}}
        excerpts = [{'section': 'Introduction', 'text': 'Lesson text'}]
        with patch('buddy_learning.lessons.lookup', return_value=(row, True)), \
             patch('buddy_learning.lessons.lesson_plain_excerpts', return_value=(excerpts, True)) as extract:
            await service.chat(self.folder_id, service.ChatRequest(message='Explain', lesson_id=self.lesson_id), user=self.user)
        extract.assert_called_once_with(row['draft'], max_chars=30000)
        source = self.respond.await_args.kwargs['context']['source']
        self.assertEqual(source, {'id': str(self.lesson_id), 'kind': 'lesson', 'title': 'Lesson', 'excerpts': excerpts, 'truncated': True})

    async def test_quiz_with_deleted_source_still_allows_assistance(self):
        quiz = {'folder_id': str(self.folder_id), 'created_by': 'teacher', 'status': 'draft',
                'draft': {'title': 'Quiz', 'questions': []}, 'book_id': self.book_id}
        self.db.execute.return_value.fetchone.return_value = None
        with patch('buddy_learning.store.quiz', return_value=quiz):
            result = await service.chat(self.folder_id, service.ChatRequest(message='Explain', quiz_id=self.quiz_id), user=self.user)
        self.assertEqual(result['reply'], 'Helpful reply')
        self.assertNotIn('source', self.respond.await_args.kwargs['context'])

    async def test_student_cannot_save_model_generated_draft(self):
        self.can_create.return_value = False
        self.respond.return_value = SimpleNamespace(reply='Created', draft=SimpleNamespace())
        with patch('buddy_learning.service.save_quiz') as save:
            with self.assertRaises(HTTPException) as exc:
                await service.chat(self.folder_id, service.ChatRequest(message='Help'), user={'username': 'student'})
        self.assertEqual(exc.exception.status_code, 403)
        save.assert_not_called()

    async def test_model_failures_are_mapped_without_leaking_details(self):
        for error, status in [(TimeoutError('private'), 504), (ValueError('private'), 502), (RuntimeError('private'), 502)]:
            with self.subTest(error=type(error).__name__):
                self.respond.side_effect = error
                with self.assertRaises(HTTPException) as exc:
                    await service.chat(self.folder_id, service.ChatRequest(message='Help'), user=self.user)
                self.assertEqual(exc.exception.status_code, status)
                self.assertNotIn('private', exc.exception.detail)
