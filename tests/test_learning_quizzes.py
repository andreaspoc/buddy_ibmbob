"""Learning assessments keep solutions server-side and validate every answer."""
import json
import unittest
from uuid import uuid4

from pydantic import ValidationError
from buddy_learning.quizzes import (ManualGrade, ManualGrades, QuizInput, QuizQuestion,
                                    Submission, grade_submission, public_quiz)


def question(**changes):
    return QuizQuestion.model_validate({'id': 'q1', 'type': 'single', 'question': 'Select a fixture option',
                                       'options': ['A', 'B', 'C'], 'answer': [1], 'points': 3, **changes})


class QuizSchemaTests(unittest.TestCase):
    def test_valid_types_and_input_serialization(self):
        for kind in ('single', 'multiple', 'dropdown'):
            self.assertEqual(question(type=kind).type, kind)
        written = question(type='text', options=[], answer='Reference fixture', rubric='Expected concept')
        quiz = QuizInput(title='Fixture', book_id=uuid4(), questions=[written])
        self.assertEqual(QuizInput.model_validate_json(quiz.model_dump_json()), quiz)

    def test_invalid_questions_are_rejected(self):
        for changes in [
            {'id': '../q'}, {'id': ''}, {'question': '  '}, {'question': 'x' * 2001},
            {'options': ['A']}, {'options': ['A', ' A ']}, {'options': ['A', ' ']},
            {'answer': []}, {'answer': [1, 1]}, {'answer': [-1]}, {'answer': [3]},
            {'answer': [True]}, {'answer': ['1']}, {'answer': [1.0]}, {'answer': 'B'},
            {'answer': [0, 1]}, {'points': True}, {'points': 0}, {'points': 101},
            {'unknown': 'field'}, {'type': 'text', 'options': [], 'answer': 'Reference'},
            {'type': 'text', 'options': [], 'answer': '', 'rubric': 'Rubric'},
            {'type': 'text', 'options': [], 'answer': [1], 'rubric': 'Rubric'},
            {'type': 'text', 'answer': 'Reference', 'rubric': 'Rubric'},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                question(**changes)

    def test_quiz_requires_unique_questions_and_bounded_size(self):
        for questions in [[], [question(), question()], [question(id=f'q{i}') for i in range(51)]]:
            with self.assertRaises(ValidationError):
                QuizInput(title='Fixture', questions=questions)
        with self.assertRaises(ValidationError):
            QuizInput(title=' ', questions=[question()])

    def test_public_payload_uses_allowlist_and_never_contains_keys_or_rubrics(self):
        quiz = QuizInput(title='Fixture', questions=[question(), question(
            id='written', type='text', options=[], answer='private-reference-value', rubric='private-rubric-value')])
        safe = public_quiz(quiz)
        self.assertEqual(public_quiz(quiz.model_dump()), safe)
        serialized = json.dumps(safe)
        self.assertNotIn('answer', serialized)
        self.assertNotIn('rubric', serialized)
        self.assertNotIn('private-reference-value', serialized)
        self.assertNotIn('private-rubric-value', serialized)
        for item in safe['questions']:
            self.assertEqual(set(item), {'id', 'type', 'question', 'options', 'points'})

    def test_submission_requires_version_uuid_and_bounds(self):
        good = {'answers': {'q1': [1]}, 'request_id': str(uuid4()), 'version': 1}
        self.assertEqual(Submission.model_validate(good).version, 1)
        for changes in [{'version': 0}, {'version': True}, {'request_id': 'bad'},
                        {'answers': {'q1': [True]}}, {'answers': {'q1': ['1']}},
                        {'answers': {'q1': 'x' * 10001}}, {'answers': {}},
                        {'username': 'other'}, {'answers': {'q1': list(range(21))}}]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                Submission.model_validate({**good, **changes})
        with self.assertRaises(ValidationError):
            Submission(answers={'q1': [1]}, request_id=uuid4())

    def test_manual_grades_are_finite_nonnegative_numbers(self):
        self.assertEqual(ManualGrades(grades={'q1': {'score': 2.5}}).grades['q1'].score, 2.5)
        for value in (True, -1, '2', float('nan'), float('inf')):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                ManualGrade(score=value)
        with self.assertRaises(ValidationError):
            ManualGrades(grades={})


class GradingTests(unittest.TestCase):
    def test_exact_set_and_weighted_scoring(self):
        questions = [question(), question(id='multi', type='multiple', answer=[0, 2], points=4),
                     question(id='drop', type='dropdown', answer=[2], points=2)]
        correct = grade_submission(questions, {'q1': [1], 'multi': [2, 0], 'drop': [2]})
        self.assertEqual(correct['score'], 9)
        self.assertEqual(correct['max_score'], 9)
        self.assertFalse(correct['pending_manual'])
        wrong = grade_submission(questions, {'q1': [0], 'multi': [0], 'drop': [1]})
        self.assertEqual(wrong['score'], 0)
        self.assertEqual(wrong['grades']['multi']['score'], 0)
        wrong_extra = grade_submission(questions, {'q1': [1], 'multi': [0, 1, 2], 'drop': [2]})
        self.assertEqual(wrong_extra['score'], 5)

    def test_text_always_pending_manual_never_matches_reference_automatically(self):
        questions = [question(), question(id='written', type='text', options=[], answer='Private answer', rubric='Private rubric', points=5)]
        result = grade_submission(questions, {'q1': [1], 'written': 'Private answer'})
        self.assertEqual(result['score'], 3)
        self.assertEqual(result['max_score'], 8)
        self.assertTrue(result['pending_manual'])
        self.assertEqual(result['grades']['written'], {'score': None, 'feedback': ''})
        self.assertNotIn('Private', json.dumps(result))

    def test_malformed_answers_cannot_be_scored(self):
        for answer in ([], [True], [1.0], ['1'], [-1], [3], [0, 1], [1, 1], 'B', None):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                grade_submission([question()], {'q1': answer})
        for answers in ({}, {'q1': [1], 'unknown': [1]}, None, []):
            with self.subTest(answers=answers), self.assertRaises(ValueError):
                grade_submission([question()], answers)
        written = question(type='text', options=[], answer='Ref', rubric='Rubric')
        for answer in ('', '   ', 'x' * 10001, [0]):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                grade_submission([written], {'q1': answer})

    def test_dictionary_definitions_are_validated_before_grading(self):
        self.assertEqual(grade_submission([question().model_dump()], {'q1': [1]})['score'], 3)
        with self.assertRaises(ValueError):
            grade_submission([], {})
        with self.assertRaises(ValueError):
            grade_submission([question(), question()], {'q1': [1]})


if __name__ == '__main__':
    unittest.main()
