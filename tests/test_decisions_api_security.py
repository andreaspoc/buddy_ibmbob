"""Production authorization and release-gate functions with synthetic adapters."""
import ast
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from app.decisions_buddy.decision_engine import DecisionEngine
from app.decisions_buddy.safe_expression import validate_graph


class Denied(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail


class APISecurityTests(unittest.TestCase):
    def setUp(self):
        self.record = {'id': 'synthetic', 'name': 'Synthetic', 'version': 2, 'owner': 'owner',
                       'updatedBy': 'owner', 'accessPolicy': 'private', 'status': 'draft',
                       'environment': 'development', 'graph': {'nodes': [{'id': 'i', 'type': 'inputNode'}], 'edges': []}}
        self.db = SimpleNamespace(get_decision=Mock(side_effect=lambda identity: dict(self.record)),
            RevisionConflict=type('RevisionConflict', (ValueError,), {}))
        self.gov = SimpleNamespace(governance_ready=Mock(return_value=True))
        self.namespace = {'HTTPException': Denied, 'Depends': lambda value: None,
            'current_user': lambda: None, 'GovernanceStatusRequest': SimpleNamespace,
            'db': self.db, 'governance': self.gov, 'DecisionEngine': DecisionEngine, 'validate_graph': validate_graph,
            'hashlib': hashlib, 'json': json}
        names = {'_caller', '_read', '_write', '_revision', '_mutation', 'set_status', '_engine_for', '_digest'}
        nodes = [node for node in ast.parse(Path('app/decisions_buddy/main.py').read_text()).body
                 if isinstance(node, ast.FunctionDef) and node.name in names]
        for node in nodes: node.decorator_list = []
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'app/decisions_buddy/main.py', 'exec'), self.namespace)
        self.namespace['_gov_snapshot'] = Mock(return_value={'syncStatus': 'synced'})
        self.user = {'username': 'owner', 'is_admin': False}

    def deny(self, status, function, *args):
        with self.assertRaises(Denied) as failure: function(*args)
        self.assertEqual(failure.exception.status_code, status)

    def transition(self, *, status='in_review', actor=None, locked=None):
        def update(identity, status, environment, **kwargs):
            kwargs['validate'](SimpleNamespace(), locked or dict(self.record))
            return {**self.record, 'status': status, 'approver': kwargs.get('approver')}
        self.db.update_governance_status = Mock(side_effect=update)
        return self.namespace['set_status']('synthetic',
            SimpleNamespace(status=status, environment='production', expectedVersion=2), actor or self.user)

    def test_private_models_and_nested_references_do_not_cross_user_boundaries(self):
        self.deny(404, self.namespace['_read'], 'synthetic', {'username': 'other'})
        graph = {'nodes': [{'id': 'sub', 'type': 'decisionNode', 'content': {'key': 'synthetic'}}], 'edges': []}
        self.deny(404, self.namespace['_engine_for'], graph, {'username': 'other'})

    def test_shared_read_does_not_grant_write_or_override(self):
        self.record['accessPolicy'] = 'authenticated'
        other = {'username': 'other'}
        self.assertEqual(self.namespace['_read']('synthetic', other)['id'], 'synthetic')
        self.deny(403, self.namespace['_write'], 'synthetic', other)
        self.deny(409, self.namespace['_revision'], self.record, 1)

    def test_owner_can_submit_but_cannot_self_approve_even_as_admin(self):
        self.assertEqual(self.transition()['decision']['status'], 'in_review')
        self.record['status'] = 'in_review'
        with self.assertRaises(Denied) as failure:
            self.transition(status='approved', actor={'username': 'owner', 'is_admin': True})
        self.assertEqual(failure.exception.status_code, 403)

    def test_fresh_evidence_and_independent_reviewer_are_both_required(self):
        self.record.update(status='in_review', accessPolicy='authenticated')
        reviewer = {'username': 'reviewer', 'is_admin': True}
        self.gov.governance_ready.return_value = False
        with self.assertRaises(Denied) as failure: self.transition(status='approved', actor=reviewer)
        self.assertEqual(failure.exception.status_code, 409)
        self.gov.governance_ready.return_value = True
        self.assertEqual(self.transition(status='approved', actor=reviewer)['decision']['approver'], 'reviewer')

    def test_status_validation_uses_locked_current_state_and_cannot_skip_stages(self):
        self.deny(409, lambda: self.transition(status='published', actor={'username': 'reviewer', 'is_admin': True}))
        with self.assertRaises(Denied) as failure:
            self.transition(locked={**self.record, 'status': 'published'})
        self.assertEqual(failure.exception.status_code, 409)

    def test_recursive_nested_models_and_unpublished_production_models_are_rejected(self):
        nested = {'nodes': [{'id': 'sub', 'type': 'decisionNode', 'content': {'key': 'synthetic'}}], 'edges': []}
        self.record['graph'] = nested
        self.deny(422, self.namespace['_engine_for'], nested, self.user)
        self.deny(409, self.namespace['_engine_for'], nested, self.user, True)


if __name__ == '__main__': unittest.main()
