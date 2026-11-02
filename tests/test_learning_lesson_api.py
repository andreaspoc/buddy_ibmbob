"""Synthetic lesson HTTP fixtures; never connect to real learner records or S3."""
import asyncio
import json
import unittest
from contextlib import contextmanager
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4
from fastapi.testclient import TestClient
from app.agent_budget import BudgetExceeded, RunBudget
from app.auth import current_user
from buddy_learning import service, lessons
from buddy_learning.lesson_models import LessonInput

FOLDER = str(uuid4())
LESSON = str(uuid4())


def fixture():
    return {'title': 'Human source fixture', 'description': '', 'steps': [
        {'id': 'practice', 'kind': 'question', 'title': 'Practice', 'text': 'Choose B',
         'options': ['A', 'B'], 'answer': 1, 'feedback': 'Author explanation', 'url': '', 'asset_id': None}]}


class LessonHttpTests(unittest.TestCase):
    def setUp(self):
        self.user = {'username': 'fixture-learner', 'is_admin': False}
        self.row = {'id': LESSON, 'folder_id': FOLDER, 'created_by': 'fixture-author',
                    'version': 1, 'status': 'published', 'draft': fixture(), 'published': fixture()}
        self.db = Mock()
        self.db.execute.side_effect = self.execute
        self.writes = []
        @contextmanager
        def connect():
            yield self.db
        self.addCleanup(patch.stopall)
        patch.object(service.job_queue, '_connect', connect).start()
        patch.object(lessons.store, 'folder', return_value={'id': FOLDER}).start()
        self.role = patch.object(lessons.store, 'can_create', return_value=False).start()
        patch('app.auth.current_user', new=AsyncMock(side_effect=lambda request: self.user)).start()
        app = service.create_app()
        app.dependency_overrides[current_user] = lambda: self.user
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def execute(self, sql, params=None):
        cursor = Mock()
        if sql.startswith('SELECT * FROM learning.lessons'):
            cursor.fetchone.return_value = self.row
        elif sql.startswith('SELECT folder_id FROM learning.lessons'):
            cursor.fetchone.return_value = {'folder_id': FOLDER}
        elif sql.startswith('SELECT COALESCE(MAX(ordinal)'):
            cursor.fetchone.return_value = {'next_ord': 0}
        elif sql.startswith('SELECT step,completed'):
            cursor.fetchone.return_value = None
        elif sql.startswith('SELECT * FROM learning.lesson_assets'):
            cursor.fetchone.return_value = None
        elif sql.startswith(('INSERT', 'UPDATE', 'DELETE')):
            self.writes.append((sql, params))
            cursor.fetchone.return_value = {'id': LESSON, 'title': 'Quiz', 'status': 'draft', 'version': 0}
        else:
            raise AssertionError('Unexpected query in synthetic test: ' + sql)
        return cursor

    def test_learner_never_receives_answer_key_and_can_check_practice(self):
        response = self.client.get('/api/learning/lessons/' + LESSON)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('answer', response.json()['steps'][0])
        self.assertNotIn('feedback', response.json()['steps'][0])
        checked = self.client.post(f'/api/learning/lessons/{LESSON}/check', json={'version': 1, 'step_id': 'practice', 'answer': 1})
        self.assertEqual(checked.json(), {'correct': True, 'feedback': 'Author explanation'})
        self.assertEqual(self.writes, [])

    def test_draft_is_private_and_only_author_can_publish(self):
        self.row['status'] = 'draft'
        self.assertEqual(self.client.get('/api/learning/lessons/' + LESSON).status_code, 404)
        self.role.return_value = True
        self.assertEqual(self.client.post(f'/api/learning/lessons/{LESSON}/publish').status_code, 403)
        self.user['username'] = 'fixture-author'
        self.assertEqual(self.client.post(f'/api/learning/lessons/{LESSON}/publish').status_code, 200)
        self.assertIn('published=draft', self.writes[-1][0])

    def test_progress_checks_published_version_and_position(self):
        url = f'/api/learning/lessons/{LESSON}/progress'
        self.assertEqual(self.client.put(url, json={'version': 2, 'step': 0}).status_code, 409)
        self.assertEqual(self.client.put(url, json={'version': 1, 'step': 8}).status_code, 422)
        self.assertEqual(self.client.put(url, json={'version': 1, 'step': 0, 'completed': True}).status_code, 200)
        self.assertEqual(self.writes[-1][1][1], 'fixture-learner')

    def test_teacher_can_import_human_document_without_saving_or_ai(self):
        self.role.return_value = True
        response = self.client.post(f'/api/learning/folders/{FOLDER}/lesson-import', files={'file': ('lesson.txt', b'Human-provided source material', 'text/plain')})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('Human-provided source material', response.json()['steps'][0]['text'])
        self.assertEqual(self.writes, [])

    def test_buddy_returns_proposal_without_saving_and_rechecks_authorization(self):
        self.role.return_value = True
        with patch('buddy_learning.lesson_ai.draft', new=AsyncMock(return_value=(LessonInput.model_validate(fixture()), False))):
            response = self.client.post(f'/api/learning/folders/{FOLDER}/lesson-draft', json={'message': 'Make a lesson from this brief'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('draft', response.json())
        self.assertEqual(self.writes, [])
        self.role.return_value = False
        self.assertEqual(self.client.post(f'/api/learning/folders/{FOLDER}/lesson-draft', json={'message': 'Help'}).status_code, 403)

    def test_real_draft_supplies_the_budget_the_assistant_requires(self):
        """Regression: only the inference call is faked, so the real budget contract applies."""
        self.role.return_value = True
        async def contract(prompt, *, budget=None):
            if not isinstance(budget, RunBudget):
                raise PermissionError('Learning assistant requires an owner execution budget')
            self.assertEqual(budget.username, self.user['username'])
            return json.dumps(fixture())
        with patch('buddy_learning.assistant.completion', new=contract):
            response = self.client.post(f'/api/learning/folders/{FOLDER}/lesson-draft', json={'message': 'Make a lesson'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['draft']['title'], fixture()['title'])
        self.assertEqual(response.json()['untranslated'], [])

    def test_exhausted_quota_is_reported_not_a_server_error(self):
        self.role.return_value = True
        with patch('buddy_learning.lesson_ai.draft', new=AsyncMock(side_effect=BudgetExceeded('Agent action quota reached'))):
            response = self.client.post(f'/api/learning/folders/{FOLDER}/lesson-draft', json={'message': 'Make a lesson'})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()['detail'], 'Agent action quota reached')

    def test_translations_run_together_and_failures_are_flagged(self):
        self.role.return_value = True
        running, peak = 0, []
        async def translate(kind, language, payload, username):
            nonlocal running
            running += 1
            peak.append(running)
            await asyncio.sleep(0)
            running -= 1
            if language == 'hi':
                raise TimeoutError()
            return {'title': 'Τίτλος', 'description': None, 'steps': payload['steps']}
        with patch.object(lessons, '_is_real_db', return_value=True), \
             patch('buddy_learning.lesson_ai.draft', new=AsyncMock(return_value=(LessonInput.model_validate(fixture()), False))), \
             patch('buddy_learning.service._translate_json_payload', new=translate):
            response = self.client.post(f'/api/learning/folders/{FOLDER}/lesson-draft', json={'message': 'Make a lesson'})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(max(peak), 2)
        self.assertEqual(body['untranslated'], ['hi'])
        self.assertEqual(body['draft']['translations']['el']['title'], 'Τίτλος')
        self.assertEqual(body['draft']['translations']['hi']['title'], fixture()['title'])
        self.assertNotIn('untranslated', body['draft']['translations']['hi'])

    def test_translation_with_wrong_step_count_keeps_source_steps(self):
        async def translate(*_):
            return {'title': '', 'description': 'Περιγραφή', 'steps': []}
        dumped = fixture()
        with patch('buddy_learning.service._translate_json_payload', new=translate):
            entry, translated = asyncio.run(lessons.translated_entry('el', dumped, 'fixture-author'))
        self.assertEqual(entry['steps'], dumped['steps'])
        self.assertEqual((entry['title'], entry['description']), (dumped['title'], 'Περιγραφή'))
        self.assertFalse(translated)

    def test_teacher_can_save_a_valid_interactive_board(self):
        self.role.return_value = True
        spec = fixture()
        spec['steps'] = [{'id': 'board', 'kind': 'board', 'title': 'Explore', 'board': {
            'layout': 'cards', 'cards': [
                {'id': 'first', 'title': 'Concept', 'body': '**Human explanation**'},
                {'id': 'second', 'title': 'Example', 'body': '<details><summary>Explore</summary>More context</details>'}]}}]
        response = self.client.post(f'/api/learning/folders/{FOLDER}/lessons', json=spec)
        self.assertEqual(response.status_code, 200, response.text)
        stored = self.writes[-1][1][3].obj
        self.assertEqual(stored['steps'][0]['board']['layout'], 'cards')
        self.assertEqual(len(stored['steps'][0]['board']['cards']), 2)

    def test_non_lesson_media_and_cross_origin_writes_are_rejected(self):
        self.assertEqual(self.client.get(f'/api/learning/lessons/{LESSON}/assets/{uuid4()}').status_code, 404)
        self.role.return_value = True
        self.assertEqual(self.client.post(f'/api/learning/folders/{FOLDER}/lessons', headers={'Origin': 'https://other.invalid'}, json=fixture()).status_code, 403)

    def test_lesson_plain_excerpts_extracts_structured_sections(self):
        spec = {
            'title': 'Test Lesson',
            'description': 'Introduction to testing',
            'steps': [
                {'id': 's1', 'kind': 'text', 'title': 'Section 1', 'text': 'Content 1'},
                {'id': 's2', 'kind': 'question', 'title': 'Practice 1', 'text': 'Q text', 'options': ['Choice 1', 'Choice 2'], 'feedback': 'Good job'},
                {'id': 's3', 'kind': 'board', 'title': 'Board 1', 'board': {'layout': 'cards', 'cards': [{'id': 'c1', 'title': 'Concept', 'body': 'Detail'}]}}
            ]
        }
        excerpts, truncated = lessons.lesson_plain_excerpts(spec)
        self.assertFalse(truncated)
        self.assertEqual(len(excerpts), 4)
        self.assertEqual(excerpts[0]['section'], 'Introduction')
        self.assertIn('Introduction to testing', excerpts[0]['text'])
        self.assertEqual(excerpts[1]['section'], 'Section 1')
        self.assertIn('Content 1', excerpts[1]['text'])
        self.assertEqual(excerpts[2]['section'], 'Practice 1')
        self.assertIn('Choice 1', excerpts[2]['text'])
        self.assertIn('Good job', excerpts[2]['text'])
        self.assertEqual(excerpts[3]['section'], 'Board 1')
        self.assertIn('Concept: Detail', excerpts[3]['text'])

    def test_ai_lesson_draft_creates_quiz_draft(self):
        self.role.return_value = True
        fake_quiz = {
            'title': 'Test quiz',
            'language': 'en',
            'lesson_id': LESSON,
            'questions': [{
                'id': 'q1',
                'type': 'single',
                'question': 'What is tested?',
                'options': ['Opt A', 'Opt B'],
                'answer': [0],
                'points': 1,
                'explanation': 'Because A is right'
            }]
        }
        from buddy_learning.quizzes import QuizInput
        validated_quiz = QuizInput.model_validate(fake_quiz)
        with patch('buddy_learning.quiz_ai.create_draft_from_excerpts', new=AsyncMock(return_value=(validated_quiz, False))):
            response = self.client.post(f'/api/learning/lessons/{LESSON}/quiz-draft', json={'title': 'Lesson quiz', 'count': 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()['source_truncated'])
        self.assertTrue(any('INSERT INTO learning.quizzes' in w[0] for w in self.writes))

    def test_reorder_lessons_updates_ordinal(self):
        self.role.return_value = True
        l1, l2 = str(uuid4()), str(uuid4())
        response = self.client.put(f'/api/learning/folders/{FOLDER}/lessons/order', json={'lesson_ids': [l2, l1]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'reordered': True})
        updates = [w for w in self.writes if 'UPDATE learning.lessons SET ordinal' in w[0]]
        self.assertEqual(len(updates), 2)
        self.assertEqual(updates[0][1][0], 0)
        self.assertEqual(updates[0][1][1], l2)
        self.assertEqual(updates[1][1][0], 1)
        self.assertEqual(updates[1][1][1], l1)

        self.role.return_value = False
        self.assertEqual(self.client.put(f'/api/learning/folders/{FOLDER}/lessons/order', json={'lesson_ids': [l1]}).status_code, 403)

    def test_private_teacher_notes_never_reach_learner(self):
        self.row['published']['steps'][0]['teacher_notes'] = 'PRIVATE TEACHING GUIDANCE'
        response = self.client.get('/api/learning/lessons/' + LESSON)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('teacher_notes', response.json()['steps'][0])
        self.assertNotIn('PRIVATE TEACHING GUIDANCE', response.text)

    def test_stale_manual_edits_and_publish_are_rejected(self):
        self.role.return_value = True
        self.user['username'] = 'fixture-author'
        actual = self.client.get('/api/learning/lessons/' + LESSON).json()['draft_digest']
        spec = fixture()
        response = self.client.put(f'/api/learning/lessons/{LESSON}', json={**spec, 'expected_digest': '0' * 64})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.post(f'/api/learning/lessons/{LESSON}/publish', json={'expected_digest': '0' * 64}).status_code, 409)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.client.put(f'/api/learning/lessons/{LESSON}', json={**spec, 'expected_digest': actual}).status_code, 200)
        stored = self.writes[-1][1][1].obj
        self.assertNotIn('expected_digest', stored)

    def test_edit_and_delete_lesson(self):
        self.role.return_value = True
        self.user['username'] = 'fixture-author'
        spec = fixture()
        spec['title'] = 'Updated Lesson Title'
        # Editing preserves the published learner snapshot until teacher publication
        response = self.client.put(f'/api/learning/lessons/{LESSON}', json=spec)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(any("status='closed'" in w[0] for w in self.writes))
        self.assertIn("draft_digest", response.json())

        # Author can delete lesson
        del_resp = self.client.delete(f'/api/learning/lessons/{LESSON}')
        self.assertEqual(del_resp.status_code, 200, del_resp.text)
        self.assertTrue(any('DELETE FROM learning.lessons' in w[0] for w in self.writes))


if __name__ == '__main__':
    unittest.main()
