"""Automatic approvals and explicitly selected review categories."""
import ast
from pathlib import Path
import unittest


namespace = {}
nodes = [node for node in ast.parse(Path('app/approval_policy.py').read_text()).body
         if isinstance(node, ast.FunctionDef) and node.name in {'review_required', 'once_option'}]
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'app/approval_policy.py', 'exec'), namespace)
review_required, once_option = namespace['review_required'], namespace['once_option']


class ApprovalPolicyTests(unittest.TestCase):
    def test_auto_approves_every_tool_kind(self):
        for tool in ({}, {'kind': 'execute'}, {'kind': 'delete'}, {'kind': 'move'},
                     {'kind': 'other'}, {'kind': 'execute', 'mandatory': True}):
            with self.subTest(tool=tool):
                self.assertFalse(review_required({'mode': 'auto', 'actions': ['files']}, tool))

    def test_selected_categories_review_ambiguous_executions(self):
        for action in ('commands', 'files', 'dependencies', 'messages', 'external', 'publish'):
            for kind in ('execute', 'other', None):
                self.assertTrue(review_required({'mode': 'selected', 'actions': [action]}, {'kind': kind}))
        self.assertFalse(review_required({'mode': 'selected', 'actions': []}, {'kind': 'execute'}))
        for kind in ('edit', 'delete', 'move'):
            self.assertTrue(review_required({'mode': 'selected', 'actions': ['files']}, {'kind': kind}))
            self.assertFalse(review_required({'mode': 'selected', 'actions': ['commands']}, {'kind': kind}))

    def test_read_only_kinds_and_configurable_edits(self):
        for action in ('commands', 'files', 'dependencies', 'messages', 'external', 'publish'):
            policy = {'mode': 'selected', 'actions': [action]}
            for kind in ('read', 'search', 'think'):
                self.assertFalse(review_required(policy, {'kind': kind}))
            self.assertEqual(review_required(policy, {'kind': 'edit'}), action == 'files')
        self.assertFalse(review_required({'mode': 'auto', 'actions': []}, {'kind': 'edit'}))

    def test_only_allow_once_is_usable(self):
        self.assertIsNone(once_option([{'kind': 'allow_always', 'optionId': 'unsafe'}]))
        self.assertEqual(once_option([{'kind': 'allow_once', 'optionId': 'once'}]), 'once')

    def test_schema_rejects_unknown_actions(self):
        try:
            from app.approval_policy import ApprovalPolicy
            from pydantic import ValidationError
        except ModuleNotFoundError as error:
            self.skipTest(f'schema dependency unavailable: {error.name}')
        self.assertEqual(ApprovalPolicy().model_dump(), {'mode': 'auto', 'actions': []})
        with self.assertRaises(ValidationError):
            ApprovalPolicy(mode='selected', actions=['unknown'])


if __name__ == '__main__': unittest.main()
