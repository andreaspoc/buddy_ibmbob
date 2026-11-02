"""Standalone routing checks avoid optional server dependency requirements."""
import ast
from pathlib import Path
import re
import unittest

module = ast.parse(Path('app/presentation.py').read_text())
nodes = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in {'presentation_intent', 'artifact_role', 'build_html_edit_guidance', 'build_html_presentation_prompt', 'build_presentation_prompt', 'slide_count_instruction'}]
namespace = {'re': re, 'Path': Path, 'list_presentation_templates': lambda username=None: [{'id': 'new-theme'}], 'json': __import__('json'), 'Any': object, 'get_presentation_template': lambda template_id, username=None: {'title': 'New theme', 'theme': {'background': '#abcdef'}}}
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'presentation_helpers', 'exec'), namespace)
intent = namespace['presentation_intent']
role = namespace['artifact_role']

class PresentationRoutingTests(unittest.TestCase):
    def test_chat_requests_and_live_catalog(self):
        result = intent('Please turn my report into a 12-slide interactive deck', 'agent')
        self.assertTrue(result['presentation'])
        self.assertEqual(result['slide_count'], 12)
        self.assertEqual(result['format'], 'html')
        self.assertEqual(result['templates'], [{'id': 'new-theme'}])
        self.assertEqual(intent('Make a PowerPoint presentation')['format'], 'pptx')
        for request in ('Could you put this into slides?', 'a presentation about X', 'prepare slides about our project'):
            self.assertTrue(intent(request)['presentation'], request)

    def test_report_and_questions_do_not_trigger_setup(self):
        for prompt in ('Create an HTML report', 'How do I create a presentation?', 'slide changes', 'Please change slide 2', 'What is a presentation?', 'Create a report without a presentation', 'My answers to your follow-up questions: create slides'):
            self.assertFalse(intent(prompt)['presentation'], prompt)

    def test_content_classification_not_filename_or_script_text(self):
        self.assertFalse(role('presentation.html', '<html><body><h1>Report</h1></body></html>')['is_presentation'])
        self.assertFalse(role('report.html', '<script>const example = \'<section class="slide">\';</script>')['is_presentation'])
        self.assertTrue(role('analysis.html', '<section class="active slide">Hello</section>')['is_presentation'])
        self.assertTrue(role('draft.html', '<meta name="bob-artifact-role" content="presentation">')['is_presentation'])
        self.assertEqual(role('sample.bobdeck')['role'], 'presentation')
        self.assertEqual(role('notes.md')['role'], 'artifact')

    def test_new_output_path_and_catalog_theme(self):
        html = namespace['build_html_presentation_prompt']('Topic', template_id='new-theme', output_path='presentation-unique.html')
        deck = namespace['build_presentation_prompt']('new-theme', 'Topic', output_path='presentation-unique.bobdeck')
        self.assertIn('Create a new presentation-unique.html', html)
        self.assertIn('#abcdef', html)
        self.assertNotIn('An existing', html)
        self.assertIn('presentation-unique.bobdeck', deck)
        for prompt in (html, deck):
            self.assertIn('incrementally', prompt)
            self.assertIn('Do not wait until all slides are finished before the first write', prompt)
        self.assertIn('JSON valid', deck)
        self.assertIn('</body>, </html>', html)
        self.assertNotIn('Strategic Pillars', deck)
        self.assertNotIn('KPI Metrics', deck)
        self.assertIn("Derive the outline", deck)

    def test_edit_guidance_supports_reports(self):
        guidance = namespace['build_html_edit_guidance']('Change the heading', 'report.html')
        self.assertIn('only presentations require slide sections', guidance)
        self.assertIn('report.html', guidance)

if __name__ == '__main__':
    unittest.main()
