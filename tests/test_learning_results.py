"""Synthetic grading and reading fixtures. No live learner records or model calls."""
import copy
import unittest
from unittest.mock import AsyncMock
from buddy_learning.quizzes import (QuizInput, ManualGrades, automatic_written_grades,
                                    grade_submission, public_quiz, recommended_chapters, result_details, learner_display_name)


def fixture():
    questions = [
        {'id': 'choice', 'type': 'multiple', 'question': 'Select the caching benefits',
         'options': ['Less repeated work', 'Unlimited memory', 'Faster repeated reads'],
         'answer': [0, 2], 'points': 2, 'explanation': 'Caching reuses previous results.',
         'study_topic': 'Caching', 'reading': 'Chapter 2: Caching'},
        {'id': 'written', 'type': 'text', 'question': 'Explain cache invalidation',
         'answer': 'Remove or refresh stale entries', 'points': 4, 'rubric': 'Explain staleness and refresh',
         'study_topic': 'Cache invalidation', 'reading': 'Chapter 3: Cache invalidation'},
    ]
    answers = {'choice': [0, 1], 'written': 'Refresh stale entries'}
    return {'id': 'synthetic-attempt', 'questions': questions, 'answers': answers, **grade_submission(questions, answers)}


class ResultsTests(unittest.TestCase):
    def test_display_names_never_fall_back_to_internal_keycloak_ids(self):
        internal = 'kc-' + 'a' * 40
        self.assertEqual(learner_display_name({'username': internal, 'display_name': '  Alex Example  '}), 'Alex Example')
        self.assertEqual(learner_display_name({'username': internal, 'display_name': internal}), 'Learner')
        self.assertEqual(learner_display_name({'username': internal, 'is_admin': True}), 'Administrator')
        self.assertEqual(learner_display_name({'username': 'local-user'}), 'local-user')

    def test_explanations_are_released_only_in_submission_review(self):
        row = fixture()
        safe = public_quiz(QuizInput(title='Synthetic', questions=row['questions']))
        for question in safe['questions']:
            for field in ('answer', 'explanation', 'rubric', 'reading', 'study_topic'):
                self.assertNotIn(field, question)
        report = result_details(row)
        self.assertEqual(report['grades']['choice']['outcome'], 'incorrect')
        feedback = report['grades']['choice']['feedback']
        for text in ('Caching reuses previous results.', 'Missing correct choices: Faster repeated reads', 'Incorrect choices selected: Unlimited memory', 'all correct choices'):
            self.assertIn(text, feedback)
        self.assertEqual(report['grades']['written']['outcome'], 'pending')
        self.assertIsNone(row['grades']['written']['score'])

    def test_legacy_submissions_get_feedback_without_altering_stored_grades(self):
        row = fixture()
        row['questions'][0].pop('explanation')
        row['grades']['choice']['feedback'] = ''
        before = copy.deepcopy(row)
        self.assertIn('The correct answer is:', result_details(row)['grades']['choice']['feedback'])
        self.assertEqual(row, before)

    def test_outcomes_include_correct_partial_and_pending(self):
        row = fixture()
        row['grades']['choice']['score'] = 2
        row['grades']['written']['score'] = 2.5
        report = result_details(row)
        self.assertEqual(report['grades']['choice']['outcome'], 'correct')
        self.assertEqual(report['grades']['written']['outcome'], 'partial')

    def test_reading_uses_only_matching_real_chapters_for_missed_questions(self):
        row = fixture()
        chapters = [{'id': '1', 'title': 'Introduction'}, {'id': '2', 'title': 'Chapter 2: Caching'}, {'id': '3', 'title': 'Chapter 3: Cache invalidation'}]
        recommendations = recommended_chapters(row, chapters)
        self.assertEqual([(item['question_id'], item['chapter_id']) for item in recommendations], [('choice', '2')])
        row['grades']['written']['score'] = 2
        self.assertEqual(recommended_chapters(row, chapters)[1]['chapter_id'], '3')
        self.assertEqual(recommended_chapters(row, [{'id': 'x', 'title': 'Gardening'}]), [])
        row['grades']['choice']['score'] = 2
        self.assertEqual([item['question_id'] for item in recommended_chapters(row, chapters)], ['written'])


class AutomaticGradingTests(unittest.IsolatedAsyncioTestCase):
    async def test_auto_grading_preserves_choice_marks_and_accepts_rubric_partial_credit(self):
        row = fixture()
        before = copy.deepcopy(row)
        provider = AsyncMock(return_value=ManualGrades(grades={'written': {'score': 2.5, 'feedback': 'Good refresh explanation; explain staleness more fully.'}}))
        grades = await automatic_written_grades(row, 'el', provider=provider)
        self.assertEqual(grades['choice'], row['grades']['choice'])
        self.assertEqual(grades['written']['score'], 2.5)
        self.assertEqual(grades['written']['method'], 'ai')
        self.assertEqual(row, before)
        args, kwargs = provider.call_args
        self.assertEqual([q['id'] for q in args[0]], ['written'])
        self.assertEqual(args[2], 'el')
        self.assertTrue(kwargs['automatic'])

    async def test_invalid_model_marks_are_rejected_before_persistence(self):
        for marks in (
            {'written': {'score': 5, 'feedback': 'Too many points'}},
            {'wrong': {'score': 2, 'feedback': 'Wrong question'}},
            {'written': {'score': 2, 'feedback': '   '}},
            {'written': {'score': 2, 'feedback': 'Valid'}, 'choice': {'score': 0}},
        ):
            with self.subTest(marks=marks), self.assertRaises(ValueError):
                await automatic_written_grades(fixture(), provider=AsyncMock(return_value=ManualGrades(grades=marks)))

    async def test_long_written_attempts_are_graded_in_bounded_batches(self):
        questions = [{'id': f'w{i}', 'type': 'text', 'question': 'Q' * 2000, 'answer': 'R' * 10000,
                      'rubric': 'G' * 5000, 'points': 4} for i in range(2)]
        answers = {q['id']: 'A' * 10000 for q in questions}
        row = {'questions': questions, 'answers': answers, **grade_submission(questions, answers)}
        async def marks(batch, answers, language, **kwargs):
            return ManualGrades(grades={q['id']: {'score': 3, 'feedback': 'Synthetic feedback'} for q in batch})
        provider = AsyncMock(side_effect=marks)
        graded = await automatic_written_grades(row, provider=provider)
        self.assertEqual(provider.await_count, 2)
        self.assertEqual([graded[key]['score'] for key in ('w0', 'w1')], [3, 3])

    async def test_existing_admin_marks_are_not_regraded(self):
        row = fixture()
        row['grades']['written'] = {'score': 3, 'feedback': 'Reviewed', 'method': 'administrator'}
        provider = AsyncMock()
        self.assertEqual(await automatic_written_grades(row, provider=provider), row['grades'])
        provider.assert_not_awaited()

    async def test_failed_model_call_does_not_invent_a_grade(self):
        row = fixture()
        before = copy.deepcopy(row)
        with self.assertRaises(TimeoutError):
            await automatic_written_grades(row, provider=AsyncMock(side_effect=TimeoutError()))
        self.assertEqual(row, before)


if __name__ == '__main__':
    unittest.main()
