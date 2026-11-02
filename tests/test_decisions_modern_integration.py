"""Synthetic end-to-end engine combinations of modern decision features."""
from copy import deepcopy
from unittest import TestCase
from app.decisions_buddy.decision_engine import DecisionEngine
from app.decisions_buddy.safe_expression import validate_graph


class ModernIntegrationTests(TestCase):
    def model(self):
        return {
            'vocabulary': [
                {'term': 'applicant age', 'path': 'customer.age', 'type': 'integer', 'required': True},
                {'term': 'decision approved', 'path': 'approved', 'type': 'boolean'}],
            'nodes': [
                {'id': 'input', 'type': 'inputNode'},
                {'id': 'fork', 'type': 'forkNode', 'content': {'joinId': 'join', 'maxWorkers': 2}},
                {'id': 'policy', 'type': 'actionRuleNode', 'content': {
                    'source': 'if applicant age is at least 18 then set decision approved to true; else set decision approved to false;'}},
                {'id': 'facts', 'type': 'inferenceNode', 'content': {
                    'conflictResolution': 'specificity', 'maxCycles': 5,
                    'rules': [{'id': 'review', 'patterns': [
                        {'collection': 'facts.orders', 'as': 'order', 'equals': {'status': 'pending'}}],
                        'condition': 'order.total > 100',
                        'actions': [{'op': 'update', 'fact': 'order', 'values': {'reviewed': 'true'}}]}]}},
                {'id': 'join', 'type': 'joinNode', 'content': {'mergePolicy': 'error'}},
                {'id': 'output', 'type': 'outputNode'}],
            'edges': [
                {'id': 'if', 'sourceId': 'input', 'targetId': 'fork'},
                {'id': 'fp', 'sourceId': 'fork', 'targetId': 'policy'},
                {'id': 'ff', 'sourceId': 'fork', 'targetId': 'facts'},
                {'id': 'pj', 'sourceId': 'policy', 'targetId': 'join'},
                {'id': 'fj', 'sourceId': 'facts', 'targetId': 'join'},
                {'id': 'jo', 'sourceId': 'join', 'targetId': 'output'}]}

    def test_typed_business_policy_and_fact_inference_merge_in_parallel(self):
        payload = {'customer': {'age': 20}, 'facts': {'orders': [
            {'status': 'pending', 'total': 150}, {'status': 'pending', 'total': 10}]}}
        original = deepcopy(payload)
        result = DecisionEngine().evaluate(self.model(), payload)
        self.assertTrue(result['result']['approved'])
        self.assertTrue(result['result']['facts']['orders'][0]['reviewed'])
        self.assertNotIn('reviewed', result['result']['facts']['orders'][1])
        self.assertEqual(payload, original)
        self.assertEqual([item['id'] for item in result['trace']], ['input', 'fork', 'policy', 'facts', 'join', 'output'])

    def test_typed_required_terms_and_invalid_fork_controls_rejected_before_execution(self):
        for payload in ({'customer': {}}, {'customer': {'age': True}}, {'customer': {'age': '20'}}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                DecisionEngine().evaluate(self.model(), payload)
        for kind, content in [('forkNode', {'maxWorkers': True}),
                              ('forkNode', {'maxWorkers': '2'}),
                              ('joinNode', {'mergePolicy': 'unsupported'})]:
            model = {'nodes': [{'id': 'bad', 'type': kind, 'content': content}], 'edges': []}
            with self.subTest(content=content), self.assertRaises(ValueError):
                validate_graph(model)
        validate_graph({'nodes': [{'id': 'join', 'type': 'joinNode', 'content': {}}], 'edges': []})

    def test_business_term_type_error_in_one_branch_aborts_without_mutation(self):
        model = self.model()
        model['nodes'][2]['content']['source'] = 'then set decision approved to "yes";'
        payload = {'customer': {'age': 20}, 'facts': {'orders': [{'status': 'pending', 'total': 150}]}}
        original = deepcopy(payload)
        with self.assertRaisesRegex(ValueError, 'boolean'):
            DecisionEngine().evaluate(model, payload)
        self.assertEqual(payload, original)

    def test_graph_vocabulary_types_cover_expression_outputs(self):
        model = {'vocabulary': [{'term': 'approval flag', 'path': 'approved', 'type': 'boolean'}],
                 'nodes': [{'id': 'expression', 'type': 'expressionNode', 'content': {
                     'expressions': [{'key': 'approved', 'value': '"yes"'}]}}], 'edges': []}
        with self.assertRaisesRegex(ValueError, 'boolean'):
            DecisionEngine().evaluate(model, {})
