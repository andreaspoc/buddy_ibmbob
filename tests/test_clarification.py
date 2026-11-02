"""Clarification cards must be explicit and complete before a turn can pause."""
import json
import unittest

from app.clarification import add_clarification_policy, clarification_questions, follow_up_suggestions


def card(value):
    return '```bobquestion\n' + json.dumps(value) + '\n```'


class ClarificationTests(unittest.TestCase):
    def test_valid_cards_with_surrounding_text(self):
        question = {'question': 'Which audience?', 'options': ['Customers', 'Employees'], 'context': 'This changes the detail.'}
        self.assertEqual(clarification_questions('Please clarify.\n' + card(question)), [question])

    def test_incomplete_and_invalid_cards_cannot_pause(self):
        for value in [[], {'question': '', 'options': ['A', 'B']},
                      {'question': 'Scope?', 'options': ['A']},
                      {'question': 'Scope?', 'options': ['A', ' a ']},
                      {'question': 'Scope?', 'options': ['A', 1]},
                      {'question': 'Scope?', 'options': ['A', 'B'], 'context': 1}]:
            with self.subTest(value=value):
                self.assertEqual(clarification_questions(card(value)), [])
        self.assertEqual(clarification_questions('```bobquestion\n{"question":'), [])
        self.assertEqual(clarification_questions('```json\n{"question":"Scope?","options":["A","B"]}\n```'), [])

    def test_nested_example_cannot_pause(self):
        example = card({'question': 'Scope?', 'options': ['A', 'B']})
        self.assertEqual(clarification_questions('````markdown\n' + example + '\n````'), [])

    def test_caps_questions(self):
        self.assertEqual(len(clarification_questions('\n'.join(card({'question': f'Question {i}?', 'options': ['A', 'B']}) for i in range(5)))), 3)

    def test_policy_keeps_original_context_and_disables_automated_cards(self):
        self.assertTrue(add_clarification_policy('Original user task').startswith('Original user task'))
        self.assertIn('stop this turn', add_clarification_policy('Task'))
        self.assertIn('Do not emit bobquestion', add_clarification_policy('Task', supported=False))

    def test_array_questions_and_indented_fences(self):
        question = {'question': 'Scope?', 'options': ['A', 'B']}
        self.assertEqual(clarification_questions(card([question, {'question': 'Invalid'}])), [])
        indented = '\n'.join('  ' + line for line in card(question).splitlines())
        self.assertEqual(clarification_questions(indented), [question])
        self.assertEqual(clarification_questions('    ' + card(question)), [])
        self.assertEqual(clarification_questions('~~~markdown\n' + indented + '\n~~~'), [])

    def test_context_validation_for_presets(self):
        for context in [1, 'x' * 2001]:
            self.assertEqual(clarification_questions(card({'preset': 'data-analysis', 'context': context})), [])

    def test_contextual_next_prompts(self):
        options = ['Compare the two recommended approaches', 'Draft a rollout plan']
        block = '```bobnext\n' + json.dumps({'options': options}) + '\n```'
        self.assertEqual(follow_up_suggestions('Completed result.\n' + block), options)
        self.assertEqual(follow_up_suggestions('````markdown\n' + block + '\n````'), [])
        self.assertEqual(follow_up_suggestions(block + '\n' + card({'question': 'Scope?', 'options': ['A', 'B']})), [])
        for invalid in [[], ['A', ' a '], [1], ['x' * 501], ['A', 'B', 'C', 'D']]:
            self.assertEqual(follow_up_suggestions('```bobnext\n' + json.dumps({'options': invalid}) + '\n```'), [])
        self.assertEqual(follow_up_suggestions('```bobnext\n{"options":'), [])
        # Trailing text on closing fence line (the user reported defect)
        user_case = '```bobnext\n{"options":["Export to Word","Breakdown Phase 2"]}\n```The project plan covers all sections.'
        self.assertEqual(follow_up_suggestions(user_case), ['Export to Word', 'Breakdown Phase 2'])
        # Standalone JSON options fallback
        self.assertEqual(follow_up_suggestions('Prose here.\n{"options":["Action A","Action B"]}'), ['Action A', 'Action B'])
        # Generic code-fenced options fallback
        self.assertEqual(follow_up_suggestions('Prose here.\n```json\n{"options":["Action X","Action Y"]}\n```'), ['Action X', 'Action Y'])

    def test_policy_prefers_contextual_forms_and_optional_suggestions(self):
        policy = add_clarification_policy('Task')
        self.assertIn('Prefer one focused question', policy)
        self.assertIn('```bobnext', policy)
        self.assertIn('Never emit bobnext while asking clarification', policy)

    def test_preset_expansion(self):
        questions = clarification_questions(card({'preset': 'operational-triage'}))
        self.assertEqual(len(questions), 3)
        self.assertIn('What data do you have available', questions[0]['question'])
        self.assertEqual(len(questions[0]['options']), 4)



if __name__ == '__main__':
    unittest.main()
