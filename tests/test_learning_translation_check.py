"""Synthetic tests: a language version that still holds the source text cannot be published."""
import asyncio
import json
import unittest
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from buddy_learning import lessons, service
from buddy_learning.translation_check import norm_lang, require_translated, untranslated_languages

ITEMS = [{'id': 'a', 'text': 'Hello'}]
OTHER = [{'id': 'a', 'text': 'Γεια'}]


def spec(el=OTHER, hi=OTHER, language='en'):
    return {'language': language, 'translations': {'en': {'steps': ITEMS}, 'el': {'steps': el}, 'hi': {'steps': hi}}}


class UntranslatedLanguageTests(unittest.TestCase):
    def test_complete_translations_pass(self):
        self.assertEqual(untranslated_languages(spec(), 'steps'), [])
        require_translated(spec(), 'steps')

    def test_copied_languages_are_reported(self):
        self.assertEqual(untranslated_languages(spec(el=ITEMS, hi=ITEMS), 'steps'), ['el', 'hi'])

    def test_lessons_without_translations_are_unaffected(self):
        self.assertEqual(untranslated_languages({'steps': ITEMS}, 'steps'), [])
        self.assertEqual(untranslated_languages({'translations': {'el': {'steps': ITEMS}}}, 'steps'), [])
        self.assertEqual(untranslated_languages({'translations': {'en': 'bad', 'el': {'steps': ITEMS}}}, 'steps'), [])

    def test_primary_language_is_the_comparison_source(self):
        draft = {'language': 'el-CY', 'translations': {'el': {'steps': ITEMS}, 'en': {'steps': ITEMS}, 'hi': {'steps': OTHER}}}
        self.assertEqual(untranslated_languages(draft, 'steps'), ['en'])

    def test_unknown_language_falls_back_to_english(self):
        self.assertEqual(norm_lang('Greek'), 'en')
        self.assertEqual(norm_lang(None), 'en')

    def test_refusal_names_the_language(self):
        with self.assertRaises(HTTPException) as caught:
            require_translated(spec(el=ITEMS), 'steps')
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn('Greek', caught.exception.detail)


class PublishGuardTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        @contextmanager
        def connect():
            yield self.db
        self.addCleanup(patch.stopall)
        patch.object(service.job_queue, '_connect', connect).start()

    def updates(self):
        return [call for call in self.db.execute.call_args_list if 'SET published=draft' in call.args[0]]

    def quiz_row(self, copied):
        questions = [{'id': 'q1', 'type': 'text', 'question': 'Q', 'answer': 'A', 'rubric': 'Marking rubric', 'points': 1}]
        other = questions if copied else [{**questions[0], 'question': 'Ε'}]
        draft = {'title': 'Quiz', 'questions': questions, 'language': 'en', 'translations': {
            'en': {'title': 'Quiz', 'questions': questions, 'approved': False},
            'el': {'title': 'Quiz', 'questions': other, 'approved': False},
            'hi': {'title': 'Quiz', 'questions': [{**questions[0], 'question': 'H'}], 'approved': False}}}
        return {'status': 'draft', 'draft': draft, 'published': {'title': 'Old'}, 'version': 1, 'folder_id': None}

    def test_quiz_with_copied_language_is_not_published(self):
        patch.object(service.store, 'quiz', return_value=self.quiz_row(True)).start()
        patch.object(service.store, 'creator').start()
        with self.assertRaises(HTTPException) as caught:
            service.publish(uuid4(), {'username': 'fixture-teacher'})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.updates(), [])

    def test_translated_quiz_is_published(self):
        patch.object(service.store, 'quiz', return_value=self.quiz_row(False)).start()
        patch.object(service.store, 'creator').start()
        self.db.execute.return_value.fetchone.return_value = {'version': 2}
        self.assertEqual(service.publish(uuid4(), {'username': 'fixture-teacher'}), {'published': True, 'version': 2})
        self.assertEqual(len(self.updates()), 1)

    def lesson_row(self, el):
        step = {'id': 's1', 'kind': 'text', 'title': 'T', 'text': 'Hello', 'url': '', 'asset_id': None}
        entry = lambda item: {'title': 'T', 'description': '', 'steps': [item], 'approved': False}
        draft = {'title': 'T', 'description': '', 'steps': [step], 'language': 'en', 'translations': {
            'en': entry(step), 'el': entry({**step, 'text': el}), 'hi': entry({**step, 'text': 'H'})}}
        return {'draft': draft, 'published': {'title': 'Old'}, 'folder_id': uuid4()}

    def run_lesson_publish(self, el):
        patch.object(lessons, 'lookup', return_value=(self.lesson_row(el), True)).start()
        patch.object(lessons, 'check_assets').start()
        return lessons.publish(uuid4(), user={'username': 'fixture-teacher'})

    def test_lesson_with_copied_language_is_not_published(self):
        with self.assertRaises(HTTPException) as caught:
            self.run_lesson_publish('Hello')
        self.assertIn('Greek', caught.exception.detail)
        self.assertEqual(self.updates(), [])

    def test_translated_lesson_is_published(self):
        self.assertEqual(self.run_lesson_publish('Γεια'), {'published': True})
        self.assertEqual(len(self.updates()), 1)


class QuizBatchTests(unittest.TestCase):
    def test_long_quiz_is_split_and_reassembled(self):
        questions = [{'id': f'q{index}', 'question': 'x' * 3000} for index in range(7)]
        async def reply(prompt, **_):
            return prompt.split('Input JSON:\n', 1)[1]
        completion = AsyncMock(side_effect=reply)
        with patch('buddy_learning.assistant.completion', completion):
            result = asyncio.run(service._translate_json_payload('quiz', 'el', {'title': 'T', 'questions': questions}, 'u'))
        self.assertGreater(completion.await_count, 1)
        self.assertEqual(json.dumps(result['questions']), json.dumps(questions))

    def test_lost_questions_are_rejected(self):
        with patch('buddy_learning.assistant.completion', AsyncMock(return_value='{"questions": []}')), self.assertRaisesRegex(ValueError, 'number of questions'):
            asyncio.run(service._translate_json_payload('quiz', 'el', {'questions': [{'id': 'q'}]}, 'u'))


if __name__ == '__main__':
    unittest.main()
