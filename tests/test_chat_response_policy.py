"""Scope regressions for ordinary-chat restraint and protected deliverables."""
import ast
from pathlib import Path
import unittest

from app.chat_response_policy import (CHAT_RESPONSE_POLICY, INTERACTIVE_RESPONSE_POLICY,
                                      interactive_response_policy, ordinary_chat_response,
                                      response_policies)
from app.diagram_policy import DIAGRAM_POLICY


class ChatResponsePolicyTests(unittest.TestCase):
    def test_interactive_timing_applies_to_chat_and_specialized_assistants(self):
        for payload in ({'prompt': 'Hello'}, {'agent_name': 'project-buddy'},
                        {'skill_name': 'people-buddy'}, {'mode': 'presentation'},
                        {'research': {'topic': 'Sources'}}):
            with self.subTest(payload=payload):
                self.assertEqual(interactive_response_policy(payload), INTERACTIVE_RESPONSE_POLICY)

    def test_voice_keeps_its_own_turn_taking_policy(self):
        self.assertEqual(interactive_response_policy({'voice_mode': True}), '')

    def assert_protected(self, payload, history=None, files=None):
        self.assertFalse(ordinary_chat_response(payload, history, files))
        self.assertEqual(response_policies(payload, history, files), (DIAGRAM_POLICY, ''))

    def test_linked_breach_roundup_and_followup_receive_restrained_policy(self):
        original = 'search online for the latest data breaches the last 2 days'
        followup = ('My answers to your follow-up questions:\n\n'
                    '1. Question: What would you like to do next?\n'
                    'Answer: Show me details on the Cisco SEG zero-day and how to patch it\n\n'
                    'Continue the original task using these answers.')
        history = [{'type': 'request', 'prompt': original}]
        for request in (original, followup):
            for skill in (None, 'research-buddy'):
                with self.subTest(request=request, skill=skill):
                    diagram, response = response_policies({'mode': 'agent', 'prompt': request, 'skill_name': skill}, history)
                    self.assertEqual(response, CHAT_RESPONSE_POLICY)
                    self.assertNotIn('For every substantive explanation', diagram)
                    # Keep the full existing protocol, schemas and layout guidance.
                    tail = DIAGRAM_POLICY[DIAGRAM_POLICY.index('When a diagram helps explain'):]
                    self.assertTrue(diagram.endswith(tail))

    def test_reports_presentations_workflows_and_edits_are_exactly_unchanged(self):
        cases = [
            {'research': {'topic': 'Current breaches'}}, {'research': {}},
            {'workflow': {'steps': []}}, {'workflow': {}},
            {'mode': 'presentation'}, {'mode': 'plan'}, {'mode': 'custom-analysis'},
            {'edit_artifact_path': 'report.md'}, {'agent_name': 'specialist'},
            {'prompt': 'Write a comprehensive research report on current breaches'},
            {'prompt': 'Create a presentation from these findings'},
            {'skill_name': 'presentation-buddy'}, {'skill_name': 'custom-report-buddy'},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                self.assert_protected({'mode': 'agent', 'prompt': 'Current breaches', **overrides})

    def test_data_analysis_remains_unchanged_including_ambiguous_followups(self):
        for overrides in [
            {'prompt': 'Analyze sales figures'}, {'prompt': 'Compare revenue by region'},
            {'prompt': 'Make a histogram of response times'}, {'skill_name': 'data-buddy'},
            {'mode': 'data-analysis'},
        ]:
            self.assert_protected({'mode': 'agent', 'prompt': 'Why?', **overrides})
        self.assert_protected({'prompt': 'Why?'}, [{'type': 'request', 'prompt': 'Analyze the spreadsheet'}])
        self.assert_protected({'prompt': 'Γιατί;'}, files=[{'path': 'πωλήσεις.XLSX'}])
        self.assert_protected({'prompt': 'Continue'}, files=[{'path': 'data.csv'}])

    def test_notes_creation_enrichment_and_followups_are_unchanged(self):
        for request in ['Make notes from that answer', 'Turn this into sticky notes',
                        'Revise this sticky note according to the user\'s instruction. SOURCE NOTE (JSON): {}']:
            self.assert_protected({'prompt': request})
        self.assert_protected({'prompt': 'Yes, do that'}, [{'type': 'request', 'prompt': 'Create notes for this explanation'}])

    def test_assistant_output_does_not_reclassify_ordinary_chat(self):
        history = [{'type': 'delta', 'text': 'An unsolicited report with charts and notes'}]
        self.assertTrue(ordinary_chat_response({'prompt': 'Explain the Cisco vulnerability'}, history))

    def test_worker_wires_scope_selector_to_real_request_context(self):
        source = Path('app/worker.py').read_text()
        tree = ast.parse(source)
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == 'response_policies']
        self.assertEqual(len(calls), 1)
        self.assertEqual([node.id for node in calls[0].args], ['payload', 'history', 'files'])
        self.assertIn('{diagram_policy}', source)
        self.assertIn("if chat_response_policy:", source)


if __name__ == '__main__':
    unittest.main()
