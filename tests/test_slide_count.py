"""Selected slide counts override suggested outlines in both presentation formats."""
import unittest
from unittest.mock import patch
from pydantic import ValidationError
from app.main import StreamRequest
from app.presentation import build_presentation_prompt, build_html_presentation_prompt, slide_count_instruction


class SlideCountTests(unittest.TestCase):
    def test_counts_reach_both_formats(self):
        with patch('app.presentation.get_presentation_template', return_value={'title': 'Test', 'theme': {}}):
            for count in (1, 5, 12, 50):
                for prompt in (build_presentation_prompt('test', 'Our findings', slide_count=count),
                               build_html_presentation_prompt('Our findings', template_id='test', slide_count=count)):
                    self.assertIn(f'Generate exactly {count} slides in total', prompt)
                    self.assertIn('including any title, agenda, and closing slides', prompt)
                    self.assertIn('count the actual slides in the saved file', prompt)
                    self.assertNotIn('Structure 4 to 6', prompt)

    def test_html_requires_meaningful_interactions_and_cost_controls(self):
        with patch('app.presentation.get_presentation_template', return_value={'title': 'Test', 'theme': {}}):
            prompt = build_html_presentation_prompt('Compare model costs', slide_count=8)
        for requirement in ('every substantive content slide', 'interactive calculator',
                            'coordinator overhead', 'verification date', 'editable sample rates',
                            'Keyboard slide shortcuts must not intercept'):
            self.assertIn(requirement, prompt)

    def test_invalid_counts_rejected(self):
        for count in (0, 51, 3.5, True, '5'):
            with self.assertRaises(ValidationError):
                StreamRequest(prompt='Create deck', slide_count=count)
            with self.assertRaises(ValueError):
                slide_count_instruction(count)

    def test_existing_clients_can_omit_count(self):
        self.assertIsNone(StreamRequest(prompt='Create deck').slide_count)
        self.assertIn('suitable number', slide_count_instruction(None))


if __name__ == '__main__':
    unittest.main()
