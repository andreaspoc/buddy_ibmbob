"""Learning routes called directly against a scripted database double; nothing reaches PostgreSQL or S3."""
import asyncio
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.agent_budget import BudgetExceeded
from buddy_learning import service
from buddy_learning.quizzes import QuizInput

TEACHER = {'username': 'teacher', 'is_admin': False}
ADMIN = {'username': 'root', 'is_admin': True}
FOLDER, BOOK, LESSON, QUIZ, NOTE = (uuid4() for _ in range(5))


def quiz_spec(**changes):
    return {'title': 'Quiz', 'questions': [{'id': 'q1', 'type': 'single', 'question': 'Pick', 'options': ['A', 'B'],
                                            'answer': [1], 'points': 1}], **changes}


class FakeDb:
    """Matches statements by substring; the first matching rule supplies the rows."""

    def __init__(self, real=True):
        self.rules, self.statements = [], []
        self.transaction_error = None
        if real:
            self.info = object()

    def on(self, fragment, result):
        self.rules.insert(0, (fragment, result))
        return self

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        result = None
        for fragment, value in self.rules:
            if fragment in sql:
                result = value(params) if callable(value) else value
                break
        cursor = MagicMock()
        cursor.fetchone.return_value = result[0] if isinstance(result, list) and result else (None if isinstance(result, list) else result)
        cursor.fetchall.return_value = result if isinstance(result, list) else ([result] if result else [])
        return cursor

    @contextmanager
    def transaction(self):
        if self.transaction_error:
            raise self.transaction_error
        yield

    def ran(self, fragment):
        return [params for sql, params in self.statements if fragment in sql]


class Case(TestCase):
    real = True

    def setUp(self):
        self.db = FakeDb(self.real)
        @contextmanager
        def connect():
            yield self.db
        self.enterContext(patch.object(service.job_queue, '_connect', connect))
        self.store = self.enterContext(patch.object(service, 'store'))
        self.store.folder.return_value = {'id': FOLDER, 'name': 'Class'}
        self.store.can_create.return_value = True
        self.enterContext(patch('buddy_learning.classrooms.ensure_folder_classes'))

    def assertRefused(self, status, function, *args, fragment=None, **kwargs):
        with self.assertRaises(HTTPException) as failure:
            result = function(*args, **kwargs)
            if asyncio.iscoroutine(result):
                asyncio.run(result)
        self.assertEqual(failure.exception.status_code, status)
        if fragment:
            self.assertIn(fragment, failure.exception.detail)


class FolderTests(Case):
    def test_folder_listing_is_enriched_on_real_database(self):
        self.store.visible_folders.return_value = [{'id': FOLDER, 'name': 'Class'}]
        self.db.on('FROM learning.folders f', [{'folder_id': FOLDER, 'description': 'D', 'teacher_username': 'teacher',
                                                'created_by': 'teacher', 'translations': {'el': {}}, 'approved_languages': ['el'],
                                                'lesson_count': 2, 'has_certificate': True}])
        item = service.folders(TEACHER)['items'][0]
        self.assertTrue(item['can_manage'] and item['can_delete'] and item['has_certificate'])
        self.assertEqual((item['description'], item['lesson_count'], item['approved_languages']), ('D', 2, ['el']))

    def test_enrich_tolerates_missing_metadata_and_empty_lists(self):
        self.assertEqual(service._enrich_folders(self.db, [], TEACHER), [])
        item = service._enrich_folders(self.db, [{'id': FOLDER}], TEACHER)[0]
        self.assertEqual((item['translations'], item['approved_languages'], item['can_delete']), ({}, [], False))

    def test_blank_names_are_refused(self):
        request = service.FolderInput(name='  ')
        self.assertRefused(422, service.create_folder, request, ADMIN, fragment='folder name')
        self.assertRefused(422, service.rename_folder, FOLDER, request, ADMIN, fragment='folder name')

    def test_rename_cannot_move(self):
        request = service.FolderInput(name='x', parent_id=uuid4())
        self.assertRefused(422, service.rename_folder, FOLDER, request, ADMIN, fragment='moves')

    def test_subfolder_requires_visible_parent_and_creates_class(self):
        parent = uuid4()
        self.db.on('INSERT INTO learning.folders', {'id': FOLDER, 'name': 'Sub', 'parent_id': parent})
        request = service.FolderInput(name=' Sub ', parent_id=parent, description=' About ')
        self.assertEqual(service.create_folder(request, ADMIN)['is_class'], True)
        self.store.folder.assert_called_with(self.db, parent, ADMIN)
        self.assertEqual(self.db.ran('INSERT INTO learning.classes')[0][3], 'About')
        self.assertEqual(self.db.ran('INSERT INTO learning.class_members')[0][1], 'root')

    def test_rename_updates_only_supplied_class_fields(self):
        self.db.on('UPDATE learning.folders', {'id': FOLDER, 'name': 'N', 'parent_id': None})
        service.rename_folder(FOLDER, service.FolderInput(name='N'), ADMIN)
        self.assertEqual(self.db.ran('SET title=%s,revision')[0], ('N', str(FOLDER)))
        self.assertEqual(self.db.ran('SET translations'), [])
        service.rename_folder(FOLDER, service.FolderInput(name='N', description='d', translations={'el': {'name': 'x'}},
                                                          approved_languages=['el']), ADMIN)
        self.assertEqual(self.db.ran('SET title=%s,description')[0][1], 'd')
        self.assertEqual(len(self.db.ran('SET translations')), 1)
        self.assertEqual(len(self.db.ran('SET approved_languages')), 1)

    def test_members_reports_teacher_on_real_database(self):
        self.store.ancestors.return_value = []
        self.db.on('FROM learning.members', [{'username': 'a'}]).on('FROM learning.folder_groups', [{'group_path': '/t'}])
        self.db.on('FROM learning.folder_app_groups', [{'group_id': 'g'}]).on('SELECT teacher_username', {'teacher_username': 'lead'})
        result = service.members(FOLDER, ADMIN)
        self.assertEqual((result['groups'], result['app_groups'], result['teacher_username']), (['/t'], ['g'], 'lead'))
        self.db.on('SELECT teacher_username', None)
        self.assertIsNone(service.members(FOLDER, ADMIN)['teacher_username'])

    def test_set_members_requires_existing_identities(self):
        self.assertRefused(422, service.set_members, FOLDER, service.Members(usernames=['ghost']), ADMIN, fragment='existing application users')
        group = uuid4()
        self.assertRefused(422, service.set_members, FOLDER, service.Members(usernames=[], app_groups=[group]), ADMIN, fragment='application groups')

    def test_set_members_replaces_class_roster_with_group_users_and_teacher(self):
        group = uuid4()
        self.db.on('SELECT username FROM users', [{'username': 'a'}]).on('SELECT id FROM bob_app_groups', [{'id': group}])
        self.db.on('SELECT id,teacher_username', {'id': FOLDER, 'teacher_username': 'old'})
        self.db.on('bob_app_group_members', [{'username': 'via-group'}])
        result = service.set_members(FOLDER, service.Members(usernames=['a'], app_groups=[group], teacher_username=' lead '), ADMIN)
        self.assertEqual(result['app_groups'], [str(group)])
        self.assertEqual(self.db.ran('SET teacher_username=%s')[0][0], 'lead')
        rostered = {params[1] for params in self.db.ran('INSERT INTO learning.class_members')}
        self.assertEqual(rostered, {'a', 'via-group', 'lead'})

    def test_set_members_without_class_row_or_lead(self):
        self.db.on('SELECT id,teacher_username', None)
        self.assertEqual(service.set_members(FOLDER, service.Members(usernames=[]), ADMIN)['items'], [])
        self.assertEqual(self.db.ran('DELETE FROM learning.class_members'), [])
        self.db.on('SELECT id,teacher_username', {'id': FOLDER, 'teacher_username': None})
        service.set_members(FOLDER, service.Members(usernames=[]), ADMIN)
        self.assertEqual(self.db.ran('INSERT INTO learning.class_members'), [])


class NoteHelperTests(TestCase):
    def test_tags_are_deduplicated_cleaned_and_capped(self):
        self.assertEqual(service._clean_tags(['#A', 'a', ' ', None, 'b']), ['a', 'b'])
        self.assertEqual(len(service._clean_tags([f't{i}' for i in range(20)])), 12)

    def test_title_derivation(self):
        self.assertEqual(service._derive_note_title(' T ', 'body'), 'T')
        self.assertEqual(service._derive_note_title('', '## Heading\nrest'), 'Heading')
        self.assertEqual(service._derive_note_title(None, '###'), 'Class note')

    def test_language_normalisation(self):
        for raw, expected in (('el-GR', 'el'), ('hi_IN', 'hi'), (None, 'en'), ('fr', 'en')):
            with self.subTest(raw=raw):
                self.assertEqual(service._norm_lang(raw), expected)


class ClassNoteTests(Case):
    def stored(self, **changes):
        return {'id': NOTE, 'folder_id': FOLDER, 'lesson_id': None, 'title': 'T', 'body': 'B', 'color': 'butter', 'tags': [],
                'favorite': False, 'bob_note_id': 9, **changes}

    def test_listing_filters_by_chapter_when_supplied(self):
        self.db.on('FROM learning.class_notes', [{'id': NOTE}])
        self.assertEqual(service.list_class_notes(FOLDER, LESSON, TEACHER)['items'], [{'id': NOTE}])
        self.assertEqual(self.db.statements[-1][1][2], str(LESSON))
        service.list_class_notes(FOLDER, None, TEACHER)
        self.assertEqual(len(self.db.statements[-1][1]), 2)

    def test_create_mirrors_to_personal_notes_and_survives_mirror_failure(self):
        self.db.on('INSERT INTO bob_notes', {'id': 5}).on('INSERT INTO learning.class_notes', lambda params: {'bob_note_id': params[9]})
        self.assertEqual(service.create_class_note(FOLDER, service.ClassNoteInput(body='hello'), TEACHER)['bob_note_id'], 5)
        self.db.transaction_error = RuntimeError('mirror down')
        self.assertIsNone(service.create_class_note(FOLDER, service.ClassNoteInput(body='hello'), TEACHER)['bob_note_id'])

    def test_create_refuses_blank_and_foreign_chapter(self):
        self.assertRefused(422, service.create_class_note, FOLDER, service.ClassNoteInput(body='  '), TEACHER)
        self.db.on('FROM learning.lessons', {'folder_id': uuid4(), 'title': 'L', 'ordinal': 1})
        self.assertRefused(422, service.create_class_note, FOLDER, service.ClassNoteInput(body='x', lesson_id=LESSON), TEACHER, fragment='chapter')

    def test_update_mirrors_and_tolerates_failure(self):
        self.db.on('SELECT * FROM learning.class_notes', self.stored()).on('UPDATE learning.class_notes', self.stored(title='N'))
        self.assertEqual(service.update_class_note(NOTE, service.ClassNotePatch(title='N'), TEACHER)['title'], 'N')
        self.assertEqual(len(self.db.ran('UPDATE bob_notes')), 1)
        self.db.transaction_error = RuntimeError('mirror down')
        self.assertEqual(service.update_class_note(NOTE, service.ClassNotePatch(), TEACHER)['title'], 'N')

    def test_update_keeps_existing_chapter_and_refuses_foreign_one(self):
        self.db.on('SELECT * FROM learning.class_notes', self.stored(lesson_id=LESSON))
        self.db.on('UPDATE learning.class_notes', self.stored(lesson_id=LESSON))
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': FOLDER}).on('SELECT title, ordinal', {'title': 'L', 'ordinal': 3})
        self.assertEqual(service.update_class_note(NOTE, service.ClassNotePatch(), TEACHER)['lesson_ordinal'], 3)
        self.db.on('SELECT folder_id FROM learning.lessons', None)
        self.assertRefused(422, service.update_class_note, NOTE, service.ClassNotePatch(), TEACHER, fragment='chapter')

    def test_delete_outcomes(self):
        self.assertRefused(404, service.delete_class_note, NOTE, TEACHER)
        self.db.on('DELETE FROM learning.class_notes', {'id': NOTE, 'bob_note_id': 9})
        self.assertEqual(service.delete_class_note(NOTE, TEACHER), {'deleted': True})
        self.assertEqual(self.db.ran('DELETE FROM bob_notes')[0], (9, 'teacher'))
        self.db.transaction_error = RuntimeError('mirror down')
        self.assertEqual(service.delete_class_note(NOTE, TEACHER), {'deleted': True})


class BookTests(Case):
    PARSED = {'chapters': [{'id': 'c1', 'title': 'One'}]}

    def setUp(self):
        super().setUp()
        self.store.book.return_value = {'id': BOOK, 'folder_id': FOLDER, 'object_key': 'k', 'title': 'Old', 'lesson_id': None}
        self.parsed = self.enterContext(patch.object(service, 'parsed_book', MagicMock(return_value=self.PARSED)))
        parsed_cache = MagicMock()
        self.parsed.cache_clear = parsed_cache
        self.s3 = self.enterContext(patch.object(service, 's3'))
        self.enterContext(patch.dict('os.environ', {'BOB_S3_BUCKET': 'synthetic'}))

    def test_chapter_assignment_validates_class(self):
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': uuid4()})
        self.assertRefused(422, service.update_book_chapter, BOOK, service.BookChapterInput(lesson_id=LESSON), TEACHER, fragment='chapter')

    def test_chapter_assignment_outcomes(self):
        self.db.on('UPDATE learning.books', lambda params: {'lesson_id': params[0], 'title': params[1]})
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': FOLDER})
        self.assertEqual(service.update_book_chapter(BOOK, service.BookChapterInput(lesson_id=LESSON, title=' New '), TEACHER),
                         {'lesson_id': str(LESSON), 'title': 'New'})
        self.assertEqual(service.update_book_chapter(BOOK, service.BookChapterInput(lesson_id=None), TEACHER)['lesson_id'], None)
        self.store.book.return_value = {**self.store.book.return_value, 'lesson_id': LESSON}
        self.assertEqual(service.update_book_chapter(BOOK, service.BookChapterInput(), TEACHER),
                         {'lesson_id': str(LESSON), 'title': 'Old'})

    def test_search_stops_at_thirty_matches(self):
        self.parsed.return_value = {'chapters': [{'id': f'c{i}', 'title': str(i)} for i in range(40)]}
        with patch.object(service, 'chapter_plain', side_effect=lambda parsed, chapter: 'needle here' if chapter != 'c0' else 'nothing'):
            items = service.search(BOOK, 'NEEDLE', TEACHER)['items']
        self.assertEqual(len(items), 30)
        self.assertEqual(items[0]['chapter_id'], 'c1')

    def test_progress_validates_chapters_and_saves(self):
        self.assertRefused(422, service.progress, BOOK, service.Progress(chapter_id='zz'), TEACHER)
        self.assertRefused(422, service.progress, BOOK, service.Progress(chapter_id='c1', bookmarks=[{'chapter_id': 'zz', 'label': 'x'}]), TEACHER)
        self.assertEqual(service.progress(BOOK, service.Progress(chapter_id='c1', page=2), TEACHER), {'saved': True})
        self.assertEqual(self.db.ran('INSERT INTO learning.progress')[0][1], 'teacher')

    def test_reader_note_validation(self):
        self.assertRefused(422, service.add_reader_note, BOOK, service.ReaderNote(chapter_id='zz', text='x'), TEACHER, fragment='chapter')
        self.assertRefused(422, service.add_reader_note, BOOK, service.ReaderNote(chapter_id='c1', text='  '), TEACHER, fragment='note')

    def test_delete_is_soft_and_clears_parse_cache(self):
        self.assertEqual(service.delete_book(BOOK, ADMIN), {'deleted': True})
        self.assertTrue(self.db.ran('SET deleted=true'))
        self.parsed.cache_clear.assert_called_once()

    def upload(self, lesson=None):
        file = AsyncMock()
        file.filename = 'book.epub'
        file.read.side_effect = [b'bytes', b'']
        with patch.object(service, 'parse_document', return_value={'title': 'T', 'author': 'A'}):
            return asyncio.run(service.upload_book(FOLDER, file, lesson, ADMIN))

    def test_upload_links_chapter_on_real_database(self):
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': FOLDER}).on('INSERT INTO learning.books', {'id': BOOK})
        self.assertEqual(self.upload(LESSON)['lesson_id'], str(LESSON))
        self.assertTrue(self.db.ran('UPDATE learning.books SET lesson_id'))

    def test_upload_refuses_foreign_chapter_before_reading(self):
        self.db.on('SELECT folder_id FROM learning.lessons', None)
        self.assertRefused(422, self.upload, LESSON, fragment='chapter')
        self.s3.return_value.put_object.assert_not_called()

    def test_upload_removes_object_when_database_write_fails(self):
        self.db.on('INSERT INTO learning.books', lambda params: (_ for _ in ()).throw(RuntimeError('db failed')))
        with self.assertRaisesRegex(RuntimeError, 'db failed'):
            self.upload()
        self.s3.return_value.delete_object.assert_called_once()

    def test_office_import_removes_object_when_database_write_fails(self):
        self.db.on('INSERT INTO learning.books', lambda params: (_ for _ in ()).throw(RuntimeError('db failed')))
        request = service.OfficeImport(file_id=uuid4())
        with patch('buddy_learning.office_import.read_file', AsyncMock(return_value={'raw': b'x', 'name': 'a.docx'})), \
                patch.object(service, 'parse_document', return_value={'title': 'T', 'author': 'A'}), \
                self.assertRaisesRegex(RuntimeError, 'db failed'):
            asyncio.run(service.import_office(FOLDER, request, MagicMock(), ADMIN))
        self.s3.return_value.delete_object.assert_called_once()

    def test_office_file_listing_delegates(self):
        with patch('buddy_learning.office_import.list_files', AsyncMock(return_value={'items': []})) as listing:
            self.assertEqual(asyncio.run(service.office_files(MagicMock(), 'q', 1, 5, ADMIN)), {'items': []})
        self.assertEqual(listing.await_args.args[1:], ('q', 1, 5))


class QuizTests(Case):
    def quiz(self, **changes):
        return {'id': QUIZ, 'folder_id': FOLDER, 'created_by': 'teacher', 'status': 'draft', 'version': 1, 'title': 'Quiz',
                'draft': quiz_spec(), 'published': None, 'book_id': None, 'lesson_id': None, **changes}

    def test_save_quiz_validates_source_folder(self):
        self.store.book.return_value = {'folder_id': uuid4()}
        self.assertRefused(422, service.save_quiz, self.db, FOLDER, QuizInput(**quiz_spec(book_id=BOOK)), TEACHER, fragment='book')
        self.db.on('SELECT folder_id FROM learning.lessons', None)
        self.assertRefused(422, service.save_quiz, self.db, FOLDER, QuizInput(**quiz_spec(lesson_id=LESSON)), TEACHER, fragment='lesson')

    def test_edit_refuses_published_and_foreign_sources(self):
        self.store.quiz.return_value = self.quiz(status='published')
        self.assertRefused(409, service.edit_quiz, QUIZ, QuizInput(**quiz_spec()), TEACHER, fragment='Close the quiz')
        self.store.quiz.return_value = self.quiz()
        self.store.book.return_value = {'folder_id': uuid4()}
        self.assertRefused(422, service.edit_quiz, QUIZ, QuizInput(**quiz_spec(book_id=BOOK)), TEACHER, fragment='book')
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': uuid4()})
        self.assertRefused(422, service.edit_quiz, QUIZ, QuizInput(**quiz_spec(lesson_id=LESSON)), TEACHER, fragment='lesson')

    def test_edit_accepts_matching_sources(self):
        self.store.quiz.return_value = self.quiz()
        self.store.book.return_value = {'folder_id': FOLDER}
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': FOLDER})
        self.assertEqual(service.edit_quiz(QUIZ, QuizInput(**quiz_spec(book_id=BOOK, lesson_id=LESSON)), TEACHER), {'saved': True})
        self.assertEqual(self.db.ran('UPDATE learning.quizzes SET title')[0][2], str(BOOK))

    def test_chapter_move_updates_draft_and_published(self):
        self.store.quiz.return_value = self.quiz(published=quiz_spec())
        self.db.on('SELECT folder_id FROM learning.lessons', {'folder_id': FOLDER})
        self.assertEqual(service.update_quiz_chapter(QUIZ, service.QuizChapterInput(lesson_id=LESSON), ADMIN)['lesson_id'], str(LESSON))
        self.assertEqual(len(self.db.ran('published=%s')), 1)
        self.store.quiz.return_value = self.quiz()
        self.assertIsNone(service.update_quiz_chapter(QUIZ, service.QuizChapterInput(), TEACHER)['lesson_id'])
        self.store.creator.assert_called()
        self.assertEqual(len(self.db.ran('SET lesson_id=%s, draft=%s WHERE')), 1)

    def test_review_requires_teacher_or_class_lead(self):
        self.store.quiz.return_value = self.quiz(created_by='other')
        self.assertEqual(service.review_quiz(self.db, QUIZ, ADMIN)['id'], QUIZ)
        self.assertRefused(403, service.review_quiz, self.db, QUIZ, TEACHER)
        self.db.on('COALESCE(teacher_username', {'teacher': 'teacher'})
        self.assertEqual(service.review_quiz(self.db, QUIZ, TEACHER)['id'], QUIZ)
        self.store.can_create.return_value = False
        self.assertRefused(403, service.review_quiz, self.db, QUIZ, TEACHER)

    def test_grading_skips_when_nothing_is_pending(self):
        with patch.object(service, 'automatic_written_grades', AsyncMock()) as grade:
            self.assertIsNone(asyncio.run(service.automatically_grade({'pending_manual': False, 'id': 1})))
        grade.assert_not_awaited()

    def test_result_recommends_chapters_and_handles_lost_source(self):
        row = {'source_book_id': str(BOOK), 'id': 1}
        with patch.object(service, 'result_details', side_effect=lambda value: dict(value)), \
                patch.object(service, 'authorized_book', return_value={'object_key': 'k'}) as authorized, \
                patch.object(service, 'parsed_book', return_value={'chapters': []}), \
                patch.object(service, 'recommended_chapters', return_value=[{'id': 'c'}]):
            self.assertEqual(service.detailed_result(row, TEACHER)['reading_recommendations'], [{'id': 'c'}])
            authorized.side_effect = HTTPException(404)
            self.assertIsNone(service.detailed_result(row, TEACHER)['source_book_id'])
            authorized.side_effect = RuntimeError('parse')
            with self.assertLogs('buddy_learning.service', 'ERROR'):
                self.assertEqual(service.detailed_result(row, TEACHER)['reading_recommendations'], [])

    def test_reused_submission_request_is_refused(self):
        self.store.quiz.return_value = self.quiz(status='published', version=1, published=quiz_spec())
        self.db.on('SELECT 1 FROM learning.submissions WHERE username', {'x': 1})
        request = service.Submission(request_id=uuid4(), version=1, answers={'q1': [1]})
        self.assertRefused(409, service.save_submission, QUIZ, request, TEACHER, fragment='already used')


class SuggestGradingTests(Case):
    def setUp(self):
        super().setUp()
        self.enterContext(patch.object(service, 'review_quiz'))
        self.db.on('SELECT quiz_id,questions,answers', {'quiz_id': QUIZ, 'answers': {}, 'questions': [{'type': 'text'}]})

    def test_errors_map_to_statuses(self):
        for error, status in ((BudgetExceeded('spent'), 429), (ValueError('bad'), 502), (RuntimeError('bad'), 502), (TimeoutError(), 504)):
            with self.subTest(error=type(error).__name__), patch('buddy_learning.quiz_ai.suggest_grades', AsyncMock(side_effect=error)):
                self.assertRefused(status, service.suggest_grading, uuid4(), service.LanguageRequest(), TEACHER)

    def test_success_requires_review(self):
        marks = MagicMock()
        marks.model_dump.return_value = {'grades': []}
        with patch('buddy_learning.quiz_ai.suggest_grades', AsyncMock(return_value=marks)):
            self.assertEqual(asyncio.run(service.suggest_grading(uuid4(), service.LanguageRequest(), TEACHER)),
                             {'grades': [], 'review_required': True})


class DraftGenerationTests(Case):
    def setUp(self):
        super().setUp()
        self.spec = QuizInput(**quiz_spec())
        self.enterContext(patch.object(service, 'authorized_book', return_value={'object_key': 'k', 'folder_id': FOLDER}))
        self.enterContext(patch.object(service, 'parsed_book', return_value={'chapters': []}))
        self.save = self.enterContext(patch.object(service, 'save_quiz', return_value={'id': QUIZ}))
        self.lookup = self.enterContext(patch('buddy_learning.lessons.lookup', return_value=({'folder_id': FOLDER, 'title': 'L', 'draft': {'title': 'L'}, 'published': None}, True)))
        self.excerpts = self.enterContext(patch('buddy_learning.lessons.lesson_plain_excerpts', return_value=([{'text': 'x'}], False)))
        self.translate = self.enterContext(patch.object(service, '_populate_quiz_3_languages', AsyncMock(side_effect=lambda spec, *a: spec)))

    REQUEST = service.DraftRequest()

    def test_book_draft_saves_with_translations(self):
        with patch('buddy_learning.quiz_ai.create_draft', AsyncMock(return_value=(self.spec, True))):
            self.assertEqual(asyncio.run(service.ai_draft(BOOK, self.REQUEST, TEACHER)), {'id': QUIZ, 'source_truncated': True, 'untranslated': []})
        self.translate.assert_awaited_once()
        self.save.assert_called_once()

    def test_lesson_draft_saves_with_translations(self):
        with patch('buddy_learning.quiz_ai.create_draft_from_excerpts', AsyncMock(return_value=(self.spec, False))) as create:
            self.assertEqual(asyncio.run(service.ai_lesson_draft(LESSON, self.REQUEST, TEACHER))['source_truncated'], False)
        self.assertEqual(create.await_args.kwargs['source_title'], 'L')

    def test_lesson_without_text_is_refused(self):
        self.excerpts.return_value = ([], False)
        self.assertRefused(422, service.ai_lesson_draft, LESSON, self.REQUEST, TEACHER, fragment='sufficient text')

    def test_generation_failures_map_to_statuses(self):
        for error, status in ((BudgetExceeded('spent'), 429), (TimeoutError(), 504), (ValueError('x'), 502), (RuntimeError('x'), 502)):
            with self.subTest(error=type(error).__name__):
                with patch('buddy_learning.quiz_ai.create_draft', AsyncMock(side_effect=error)):
                    self.assertRefused(status, service.ai_draft, BOOK, self.REQUEST, TEACHER)
                with patch('buddy_learning.quiz_ai.create_draft_from_excerpts', AsyncMock(side_effect=error)):
                    self.assertRefused(status, service.ai_lesson_draft, LESSON, self.REQUEST, TEACHER)
        self.save.assert_not_called()


class TranslationTests(Case):
    def test_payload_translation_requires_object(self):
        with patch('buddy_learning.assistant.completion', AsyncMock(return_value='{"title": "T"}')):
            self.assertEqual(asyncio.run(service._translate_json_payload('quiz', 'el', {'title': 'x'}, 'u')), {'title': 'T'})
        with patch('buddy_learning.assistant.completion', AsyncMock(return_value='[1]')), self.assertRaisesRegex(ValueError, 'JSON object'):
            asyncio.run(service._translate_json_payload('quiz', 'fr', {}, 'u'))

    def test_quiz_translations_fall_back_per_language(self):
        spec = QuizInput(**quiz_spec())
        async def translate(kind, language, payload, username):
            if language == 'el':
                return {'title': 'Greek', 'questions': payload['questions']}
            raise RuntimeError('offline')
        with patch.object(service, '_translate_json_payload', translate):
            result = asyncio.run(service._populate_quiz_3_languages(spec, 'en-US', 'u'))
        self.assertEqual(result.translations['el'].title, 'Greek')
        self.assertEqual(result.translations['hi'].title, 'Quiz')
        self.assertEqual(result.language, 'en')

    def test_quiz_translation_with_wrong_question_count_keeps_source_questions(self):
        spec = QuizInput(**quiz_spec())
        with patch.object(service, '_translate_json_payload', AsyncMock(return_value={'questions': []})):
            result = asyncio.run(service._populate_quiz_3_languages(spec, 'el', 'u'))
        self.assertEqual(len(result.translations['en'].questions), 1)

    def test_invalid_translated_quiz_keeps_source_for_that_language(self):
        spec = QuizInput(**quiz_spec())
        with patch.object(service, '_translate_json_payload', AsyncMock(return_value={'questions': [{'bad': 1}]})):
            result = asyncio.run(service._populate_quiz_3_languages(spec, 'en', 'u'))
        self.assertEqual(result.translations['el'].questions, spec.questions)
        self.assertEqual(service.untranslated_languages(result.model_dump(mode='json'), 'questions'), ['el', 'hi'])

    def translate_route(self, payload=None):
        request = service.TranslateContentRequest(kind='class', target_language='el', payload=payload or {'name': 'x'})
        return service.translate_content(request, TEACHER)

    def test_route_outcomes(self):
        with patch('buddy_learning.assistant.completion', AsyncMock(return_value='{"name": "y"}')):
            self.assertEqual(asyncio.run(self.translate_route())['translated'], {'name': 'y'})
        self.assertRefused(422, self.translate_route, {'name': 'x' * 70000}, fragment='too large')
        for answer, status in (('[1]', 502), ('not json', 502)):
            with self.subTest(answer=answer), patch('buddy_learning.assistant.completion', AsyncMock(return_value=answer)):
                self.assertRefused(status, self.translate_route)
        with patch('buddy_learning.assistant.completion', AsyncMock(side_effect=BudgetExceeded('spent'))):
            self.assertRefused(429, self.translate_route)


class AssistantRouteTests(Case):
    def setUp(self):
        super().setUp()
        self.result = MagicMock(reply='Hello', draft=None)
        self.respond = self.enterContext(patch('buddy_learning.assistant.respond', AsyncMock(return_value=self.result)))

    def chat(self, user=TEACHER, **request):
        return asyncio.run(service.chat(FOLDER, service.ChatRequest(message='hi', **request), user))

    def context(self):
        return self.respond.await_args.kwargs['context']

    def quiz(self, **changes):
        return {'folder_id': FOLDER, 'created_by': 'teacher', 'status': 'published', 'draft': quiz_spec(title='Draft'),
                'published': quiz_spec(title='Pub'), 'book_id': None, 'lesson_id': None, **changes}

    def test_plain_reply(self):
        self.assertEqual(self.chat(), {'reply': 'Hello'})

    def test_quiz_from_other_folder_is_hidden(self):
        self.store.quiz.return_value = self.quiz(folder_id=uuid4())
        with self.assertRaises(HTTPException) as failure:
            self.chat(quiz_id=QUIZ)
        self.assertEqual(failure.exception.status_code, 404)

    def test_quiz_context_depends_on_role(self):
        self.store.quiz.return_value = self.quiz()
        self.chat(quiz_id=QUIZ)
        self.assertEqual(self.context()['quiz']['title'], 'Draft')
        self.chat(user=ADMIN, quiz_id=QUIZ)
        self.assertEqual(self.context()['quiz']['title'], 'Pub')
        self.store.can_create.return_value = False
        self.chat(user={'username': 'learner'}, quiz_id=QUIZ)
        self.assertEqual(self.context()['quiz']['question_count'], 1)
        self.assertNotIn('questions', self.context()['quiz'])

    def test_deleted_quiz_sources_do_not_block(self):
        self.store.quiz.return_value = self.quiz(book_id=BOOK, lesson_id=LESSON)
        self.db.on('FROM learning.books', None).on('FROM learning.lessons', None)
        self.chat(quiz_id=QUIZ)
        self.assertNotIn('source', self.context())

    def test_learner_never_receives_quiz_source(self):
        self.store.can_create.return_value = False
        self.store.quiz.return_value = self.quiz(book_id=BOOK, lesson_id=LESSON)
        self.chat(user={'username': 'learner'}, quiz_id=QUIZ)
        self.assertNotIn('source', self.context())

    def test_lesson_from_other_folder_is_hidden(self):
        with patch('buddy_learning.lessons.lookup', return_value=({'folder_id': uuid4()}, False)), self.assertRaises(HTTPException) as failure:
            self.chat(lesson_id=LESSON)
        self.assertEqual(failure.exception.status_code, 404)

    def test_quiz_lesson_source_is_excerpted_for_teachers(self):
        self.store.quiz.return_value = self.quiz(lesson_id=LESSON)
        self.db.on('FROM learning.lessons', {'created_by': 'teacher', 'title': 'L', 'draft': {'title': 'D'}, 'published': None})
        with patch('buddy_learning.lessons.lesson_plain_excerpts', return_value=([{'text': 't'}], False)):
            self.chat(quiz_id=QUIZ)
        self.assertEqual(self.context()['source']['kind'], 'lesson')

    def test_long_book_source_is_truncated(self):
        self.store.book.return_value = {'folder_id': FOLDER, 'object_key': 'k', 'title': 'B'}
        parsed = {'chapters': [{'id': 'a', 'title': 'A'}, {'id': 'b', 'title': 'B'}, {'id': 'c', 'title': 'C'}]}
        with patch.object(service, 'parsed_book', return_value=parsed), \
                patch.object(service, 'chapter_plain', side_effect=lambda value, chapter: 'x' * 20000):
            self.chat(book_id=BOOK)
        source = self.context()['source']
        self.assertTrue(source['truncated'])
        self.assertEqual([len(item['text']) for item in source['excerpts']], [20000, 10000])

    def test_failures_map_to_statuses(self):
        for error, status in ((BudgetExceeded('spent'), 429), (TimeoutError(), 504), (ValueError('x'), 502)):
            with self.subTest(error=type(error).__name__):
                self.respond.side_effect = error
                with self.assertRaises(HTTPException) as failure:
                    self.chat()
                self.assertEqual(failure.exception.status_code, status)

    def test_model_draft_cannot_select_source_and_learner_cannot_save(self):
        draft = QuizInput(**quiz_spec(book_id=uuid4()))
        self.result.draft = draft
        with patch.object(service, 'save_quiz', return_value={'id': QUIZ}) as save:
            self.assertEqual(self.chat()['quiz'], {'id': QUIZ, 'is_creator': True})
        self.assertIsNone(save.call_args.args[2].book_id)
        self.store.can_create.return_value = False
        with self.assertRaises(HTTPException) as failure:
            self.chat(user={'username': 'learner'})
        self.assertEqual(failure.exception.status_code, 403)


class MiddlewareTests(Case):
    real = False

    def setUp(self):
        super().setUp()
        self.enterContext(patch('app.auth.current_user', AsyncMock(return_value=TEACHER)))
        self.app = service.create_app()
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def test_declared_oversize_is_refused(self):
        response = self.client.post('/api/learning/translate-content', content=b'x', headers={'content-length': str(2 * 1024 * 1024)})
        self.assertEqual(response.status_code, 413)

    def test_streamed_oversize_is_refused(self):
        def chunks():
            yield b'x' * (1024 * 1024 + 1)
        response = self.client.post('/api/learning/translate-content', content=chunks())
        self.assertEqual(response.status_code, 413)

    def test_private_headers_are_added(self):
        with patch.object(service, 'store') as store:
            store.can_create.return_value = False
            self.app.dependency_overrides[service.current_user] = lambda: TEACHER
            response = self.client.get('/api/learning/me')
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(response.headers['x-content-type-options'], 'nosniff')

    def test_lifespan_prepares_schema(self):
        with TestClient(service.create_app()):
            self.store.ensure_schema.assert_called_once()
