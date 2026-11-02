"""Verify the shared policy's progressive protocol contract."""
import json
import re
import unittest
from app.diagram_policy import DIAGRAM_POLICY


class DiagramPolicyTests(unittest.TestCase):
    def test_example_has_complete_json_lines_and_valid_endpoints(self):
        for example in re.findall(r'```bobdiagram\n(.*?)\n```', DIAGRAM_POLICY, re.S):
            records = [json.loads(line) for line in example.splitlines()]
            self.assertEqual(records[0]['type'], 'diagram')
            ids = {record['id'] for record in records if record['type'] == 'node'}
            lanes = {record['id'] for record in records if record['type'] == 'lane'}
            for record in records:
                if record['type'] == 'edge':
                    self.assertIn(record['source'], ids)
                    self.assertIn(record['target'], ids)
                if record['type'] == 'node' and 'lane' in record:
                    self.assertIn(record['lane'], lanes)

    def test_contract_requires_progressive_records_and_truthful_facts(self):
        for requirement in ('one complete JSON object per line', 'newline immediately',
                            '100 nodes', '200 edges', 'Do not invent operational facts',
                            'Mermaid only when the user explicitly asks'):
            self.assertIn(requirement, DIAGRAM_POLICY)

    def test_explanatory_examples_grow_down_with_decision_paths_intact(self):
        examples = re.findall(r'```bobdiagram\n(.*?)\n```', DIAGRAM_POLICY, re.S)
        for example in examples:
            records = [json.loads(line) for line in example.splitlines()]
            if records[0]['kind'] == 'flow':
                self.assertEqual(records[0]['direction'], 'TB')
        approval = next([json.loads(line) for line in example.splitlines()]
                        for example in examples if 'approval_example' in example)
        decision_edges = {record['label']: (record['source'], record['target'])
                          for record in approval if record['type'] == 'edge' and record['source'] == 'Approve'}
        self.assertEqual(decision_edges, {'Yes': ('Approve', 'Proceed'), 'Revise': ('Approve', 'Prepare')})


if __name__ == '__main__':
    unittest.main()
