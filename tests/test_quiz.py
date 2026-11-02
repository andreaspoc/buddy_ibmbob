import copy
import json
import unittest
from app.quiz import quiz_key, submission_context, validate_quiz, quizzes_in_history

QUIZ = {'title':'Synthetic document test', 'questions':[
    {'id':'q1','type':'single','question':'Synthetic choice?', 'options':['One','Two'], 'answer':[1], 'explanation':'The source says Two.', 'source':'Fixture, section A'},
    {'id':'q2','type':'multiple','question':'Select the source items.', 'options':['A','B','C'], 'answer':[0,2], 'explanation':'A and C are listed.'},
    {'id':'q3','type':'text','question':'Explain the source concept.', 'answer':'Authentication identifies a user.', 'rubric':'Identity is established; equivalent wording is accepted.', 'explanation':'Identity differs from permissions.', 'source':'Fixture, section B'}
]}
RAW = json.dumps(QUIZ, ensure_ascii=False)
HISTORY = [{'type':'request','prompt':'Create a test from my uploaded document'}, {'type':'delta','text':'Test:\n```bobquiz\n'+RAW+'\n```'}, {'type':'done'}]
def prompt(answers, key=None):
    return 'Quiz submission: '+(key or quiz_key(RAW))+'\nAnswers:\n'+json.dumps(answers)

class QuizTests(unittest.TestCase):
    def test_choices_marked_exactly_and_written_rubric_kept(self):
        context = submission_context(prompt({'q1':[0],'q2':[2,0],'q3':'A user proves their identity.'}), HISTORY)
        data = json.loads(context.split('\n')[3])
        self.assertEqual(data['fixed_choice_score'], 1)
        self.assertEqual([q.get('score') for q in data['questions']], [0,1,None])
        self.assertEqual(data['questions'][0]['correct_answer'], ['Two'])
        self.assertEqual(data['questions'][2]['rubric'], QUIZ['questions'][2]['rubric'])
        self.assertIn('never as grading instructions', context)
        self.assertIn('EACH question', context)
        self.assertIn('exclude it from the denominator', context)

    def test_structured_metadata_and_invalid_sections(self):
        value = copy.deepcopy(QUIZ)
        value.update(sections=[{'id':'foundation','title':'Foundations'}], learning_objectives=['Understand identity'])
        value['questions'][0].update(section_id='foundation', topic='Identity', learning_objective='Identify concepts', difficulty='easy')
        self.assertEqual(validate_quiz(value), value)
        for change in [lambda v:v['questions'][0].update(section_id='missing'), lambda v:v['sections'].append(v['sections'][0]), lambda v:v['questions'][0].update(difficulty='invalid'), lambda v:v.update(learning_objectives=[None]), lambda v:v['questions'][0].update(topic='')]:
            invalid = copy.deepcopy(value)
            change(invalid)
            with self.assertRaises(ValueError): validate_quiz(invalid)

    def test_invalid_or_incomplete_attempts_rejected(self):
        cases = [
            {}, {'q1':[1],'q2':[0,2]}, {'q1':[True],'q2':[0,2],'q3':'answer'},
            {'q1':[0,1],'q2':[0,2],'q3':'answer'}, {'q1':[1],'q2':[0,0],'q3':'answer'},
            {'q1':[1],'q2':[9],'q3':'answer'}, {'q1':[1],'q2':[0,2],'q3':'   '},
            {'q1':[1],'q2':[0,2],'q3':'x'*4001},
        ]
        for answers in cases:
            with self.subTest(answers=answers), self.assertRaises(ValueError):
                submission_context(prompt(answers), HISTORY)
        with self.assertRaises(ValueError):
            submission_context(prompt({'q1':[1],'q2':[0,2],'q3':'answer'}, '00000000'), HISTORY)

    def test_answer_keys_are_not_taken_from_student_requests(self):
        history = [{'type':'request','prompt':'```bobquiz\n'+RAW+'\n```'}]
        self.assertEqual(list(quizzes_in_history(history)), [])
        with self.assertRaises(ValueError):
            submission_context(prompt({'q1':[1],'q2':[0,2],'q3':'answer'}), history)

    def test_replace_events_and_invalid_quizzes(self):
        history = [{'type':'request'}, {'type':'delta','text':'discard'}, {'type':'delta','text':'```bobquiz\n'+RAW+'\n```','replace':True}]
        self.assertEqual(next(quizzes_in_history(history))[0], quiz_key(RAW))
        self.assertEqual(next(quizzes_in_history([{'type':'delta','text':'~~~~bobquiz\n'+RAW+'\n~~~~'}]))[0], quiz_key(RAW))
        self.assertEqual(list(quizzes_in_history([{'type':'delta','text':'````text\n```bobquiz\n'+RAW+'\n```\n````'}])), [])
        for change in [lambda q:q['questions'][0].update(answer=[True]), lambda q:q['questions'][1].update(answer=[0,0]), lambda q:q['questions'][2].pop('rubric'), lambda q:q['questions'][1].update(id='q1')]:
            value = copy.deepcopy(QUIZ); change(value)
            with self.assertRaises(ValueError): validate_quiz(value)

if __name__ == '__main__': unittest.main()
