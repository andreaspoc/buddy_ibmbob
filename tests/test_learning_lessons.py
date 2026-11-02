"""Lesson content validation, supported video sources, and server boundaries.

All fixtures below are synthetic lesson definitions, not operational data.
"""
import ast
import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from uuid import uuid4
from pydantic import ValidationError
from buddy_learning.lesson_models import LessonInput, Step, Board, video_embed


def spec():
    return {'title': 'Fixture lesson', 'description': '', 'steps': [
        {'id': 'read', 'kind': 'text', 'title': 'Read', 'text': 'Human-authored content'},
        {'id': 'practice', 'kind': 'question', 'title': 'Choose', 'options': ['A', 'B'], 'answer': 1, 'feedback': 'Fixture explanation'}]}


class LessonModelTests(unittest.TestCase):
    def test_roundtrip_human_content_and_media(self):
        data = spec()
        data['steps'].extend([
            {'id': 'reveal', 'kind': 'reveal', 'title': 'Explore', 'text': 'Details'},
            {'id': 'image', 'kind': 'image', 'title': 'Figure', 'asset_id': str(uuid4())},
            {'id': 'video', 'kind': 'video', 'title': 'Watch', 'url': 'https://youtu.be/abcdefghijk'}])
        lesson = LessonInput.model_validate(data)
        self.assertEqual(LessonInput.model_validate_json(lesson.model_dump_json()), lesson)
        self.assertEqual(lesson.steps[-1].url, 'https://www.youtube-nocookie.com/embed/abcdefghijk')

    def test_reject_invalid_questions_and_sections(self):
        for change in [
            {'answer': None}, {'answer': 2}, {'answer': True}, {'answer': '1'},
            {'options': ['A']}, {'options': ['A', ' A ']}, {'options': ['A', '']},
            {'title': '  '}, {'id': '../escape'}, {'url': 'javascript:alert(1)'},
        ]:
            value = spec()['steps'][1] | change
            with self.subTest(change=change), self.assertRaises(ValidationError):
                Step.model_validate(value)
        for change in [{'title': '  '}, {'steps': []}, {'steps': [spec()['steps'][0]] * 2}]:
            with self.subTest(change=change), self.assertRaises(ValidationError):
                LessonInput.model_validate(spec() | change)

    def test_reject_wrong_media_combinations(self):
        for value in [
            {'kind': 'video'}, {'kind': 'image'},
            {'kind': 'video', 'url': 'https://vimeo.com/12345', 'asset_id': str(uuid4())},
            {'kind': 'text', 'asset_id': str(uuid4())},
        ]:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                Step.model_validate({'id': 'media', 'title': 'Media'} | value)

    def test_interactive_boards_validate_cards_and_decision_paths(self):
        cards = [{'id': 'start', 'title': 'Start', 'body': '**Choose** a response.', 'next_ids': ['end']},
                 {'id': 'end', 'title': 'Outcome', 'body': '<details><summary>Why?</summary>Explanation</details>'}]
        board = Board.model_validate({'layout': 'path', 'cards': cards})
        lesson = Step(id='board', kind='board', title='Decision board', board=board)
        self.assertEqual(lesson.board.cards[0].next_ids, ['end'])
        for value in [
            {'layout': 'path', 'cards': [cards[0] | {'next_ids': ['missing']}, cards[1]]},
            {'layout': 'path', 'cards': [cards[0] | {'next_ids': []}, cards[1]]},
            {'layout': 'path', 'cards': [cards[0], cards[1] | {'next_ids': ['start']}]},
            {'layout': 'cards', 'cards': cards},
            {'layout': 'cards', 'cards': [cards[1], cards[1]]},
        ]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                Board.model_validate(value)
        with self.assertRaises(ValueError):
            Step(id='board', kind='board', title='Missing board')
        with self.assertRaises(ValueError):
            Step(id='text', title='Unexpected board', board=board)

    def test_video_provider_allowlist(self):
        for link in ['https://youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/shorts/abcdefghijk', 'https://youtu.be/abcdefghijk']:
            self.assertEqual(video_embed(link), 'https://www.youtube-nocookie.com/embed/abcdefghijk')
        self.assertEqual(video_embed('https://vimeo.com/12345'), 'https://player.vimeo.com/video/12345')
        for link in ['http://youtu.be/abcdefghijk', 'https://youtube.com.evil.invalid/watch?v=abcdefghijk', 'https://user@youtube.com/watch?v=abcdefghijk', 'https://youtu.be:8443/abcdefghijk', 'javascript:alert(1)', 'https://127.0.0.1/video', 'https://vimeo.com/not-a-video']:
            with self.subTest(link=link), self.assertRaises(ValueError):
                video_embed(link)


class LessonBoundaryTests(unittest.TestCase):
    """Execute production route bodies with explicit database/auth test doubles."""
    def setUp(self):
        class HTTPException(Exception):
            def __init__(self, status, detail):
                self.status_code = status
        self.HTTPException = HTTPException
        self.row = {'id': 'fixture', 'folder_id': 'folder', 'status': 'published', 'version': 1, 'created_by': 'author', 'draft': spec(), 'published': spec()}
        self.db = Mock()
        self.db.execute.return_value.fetchone.return_value = self.row
        self.store = SimpleNamespace(folder=Mock(), can_create=Mock(return_value=False))
        tree = ast.parse(Path('plugins/learning/buddy_learning/lessons.py').read_text())
        names = {'lookup', 'public_spec', 'check_assets'}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        namespace = {'HTTPException': HTTPException, 'store': self.store}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'lessons.py', 'exec'), namespace)
        self.functions = namespace

    def test_public_spec_strips_answers_without_mutating_author_copy(self):
        private = spec(); original = copy.deepcopy(private)
        public = self.functions['public_spec'](private)
        self.assertNotIn('answer', public['steps'][1])
        self.assertNotIn('feedback', public['steps'][1])
        self.assertEqual(private, original)

    def test_drafts_and_creator_controls_recheck_folder_and_role(self):
        lookup = self.functions['lookup']
        self.row['status'] = 'draft'
        with self.assertRaises(self.HTTPException) as error:
            lookup(self.db, 'fixture', {'username': 'participant'})
        self.assertEqual(error.exception.status_code, 404)
        self.store.folder.assert_called_once()
        with self.assertRaises(self.HTTPException):
            lookup(self.db, 'fixture', {'username': 'author'}, edit=True)
        self.store.can_create.return_value = True
        row, creator = lookup(self.db, 'fixture', {'username': 'author'}, edit=True, lock=True)
        self.assertTrue(creator)
        self.assertIs(row, self.row)
        self.assertIn('FOR UPDATE', self.db.execute.call_args.args[0])
        with self.assertRaises(self.HTTPException):
            lookup(self.db, 'fixture', {'username': 'another-admin', 'is_admin': True}, edit=True)

    def test_media_requires_same_folder_and_correct_kind(self):
        lesson = LessonInput.model_validate({'title': 'Media', 'steps': [{'id': 'image', 'title': 'Image', 'kind': 'image', 'asset_id': str(uuid4())}]})
        self.db.execute.return_value.fetchone.return_value = None
        with self.assertRaises(self.HTTPException):
            self.functions['check_assets'](self.db, 'folder', lesson)
        self.assertEqual(self.db.execute.call_args.args[1][1], 'folder')
        self.db.execute.return_value.fetchone.return_value = {'mime': 'video/mp4'}
        with self.assertRaises(self.HTTPException):
            self.functions['check_assets'](self.db, 'folder', lesson)
        self.db.execute.return_value.fetchone.return_value = {'mime': 'image/png'}
        self.functions['check_assets'](self.db, 'folder', lesson)


class BuddyDraftTests(unittest.IsolatedAsyncioTestCase):
    async def test_buddy_proposal_is_validated_and_does_not_save_or_publish(self):
        import json
        import sys
        from types import ModuleType
        from unittest.mock import AsyncMock, patch
        from buddy_learning.lesson_models import BuddyDraftRequest
        from buddy_learning.lesson_ai import draft
        assistant = ModuleType('buddy_learning.assistant')
        assistant.completion = AsyncMock(return_value=json.dumps(spec()))
        with patch.dict(sys.modules, {'buddy_learning.assistant': assistant}):
            result, truncated = await draft(BuddyDraftRequest(message='Add practice questions', current=LessonInput.model_validate(spec())))
        self.assertEqual(result.title, spec()['title'])
        self.assertFalse(truncated)
        prompt = assistant.completion.call_args.args[0]
        self.assertIn('unpublished proposal', prompt)
        self.assertIn('Never use tools', prompt)
        self.assertIn('Human-authored content', prompt)
        self.assertIsNone(assistant.completion.call_args.kwargs['budget'])
        marker = object()
        with patch.dict(sys.modules, {'buddy_learning.assistant': assistant}):
            await draft(BuddyDraftRequest(message='Add practice questions'), budget=marker)
        self.assertIs(assistant.completion.call_args.kwargs['budget'], marker)

    async def test_buddy_cannot_invent_media_or_return_invalid_questions(self):
        import json
        import sys
        from types import ModuleType
        from unittest.mock import AsyncMock, patch
        from buddy_learning.lesson_models import BuddyDraftRequest
        from buddy_learning.lesson_ai import draft
        assistant = ModuleType('buddy_learning.assistant')
        for steps in [
            [{'id': 'video', 'kind': 'video', 'title': 'Invented', 'url': 'https://vimeo.com/12345'}],
            [spec()['steps'][1] | {'answer': 99}],
        ]:
            assistant.completion = AsyncMock(return_value=json.dumps(spec() | {'steps': steps}))
            with patch.dict(sys.modules, {'buddy_learning.assistant': assistant}), self.assertRaises(ValueError):
                await draft(BuddyDraftRequest(message='Create a lesson'))
