"""Structured parallel execution with synthetic deterministic rule graphs."""
from copy import deepcopy
from threading import Barrier
from unittest import TestCase
from unittest.mock import patch

from app.decisions_buddy.decision_engine import DecisionEngine, validate_parallel_regions


def graph(left='base + 1', right='base + 2', policy='error'):
    return {'nodes': [
        {'id': 'input', 'type': 'inputNode'},
        {'id': 'fork', 'type': 'forkNode', 'content': {'joinId': 'join', 'maxWorkers': 2}},
        {'id': 'left', 'type': 'expressionNode', 'content': {'expressions': [{'key': 'result.left', 'value': left}]}},
        {'id': 'right', 'type': 'expressionNode', 'content': {'expressions': [{'key': 'result.right', 'value': right}]}},
        {'id': 'join', 'type': 'joinNode', 'content': {'mergePolicy': policy}},
        {'id': 'output', 'type': 'outputNode'}],
        'edges': [
            {'id': 'if', 'sourceId': 'input', 'targetId': 'fork'},
            {'id': 'fl', 'sourceId': 'fork', 'targetId': 'left'},
            {'id': 'fr', 'sourceId': 'fork', 'targetId': 'right'},
            {'id': 'lj', 'sourceId': 'left', 'targetId': 'join'},
            {'id': 'rj', 'sourceId': 'right', 'targetId': 'join'},
            {'id': 'jo', 'sourceId': 'join', 'targetId': 'output'}]}


class ParallelTests(TestCase):
    def test_concurrent_isolated_branches_merge_disjoint_nested_fields(self):
        model = graph()
        model['nodes'][2]['content']['expressions'].append({'key': 'base', 'value': '100'})
        barrier = Barrier(2)
        from app.decisions_buddy import decision_engine
        original = decision_engine.evaluate_expression

        def concurrent_expression(source, context, **options):
            if source in ('base + 1', 'base + 2'):
                # If branches are sequential this times out, proving the test
                # exercises actual simultaneous execution rather than graph shape.
                barrier.wait(timeout=3)
            return original(source, context, **options)

        payload = {'base': 10}
        with patch.object(decision_engine, 'evaluate_expression', concurrent_expression):
            result = DecisionEngine().evaluate(model, payload)
        self.assertEqual(result['result'], {'base': 100, 'result': {'left': 11, 'right': 12}})
        self.assertEqual(payload, {'base': 10})
        traces = result['trace']
        self.assertEqual([trace['id'] for trace in traces], ['input', 'fork', 'left', 'right', 'join', 'output'])
        self.assertEqual(traces[3]['inputSnapshot'], {'base': 10})
        self.assertEqual(result['performance']['nodesExecuted'], 6)

    def test_conflict_policies_use_declared_branch_order(self):
        for policy, expected in [('first', 1), ('last', 2)]:
            model = graph('1', '2', policy)
            for node in model['nodes'][2:4]:
                node['content']['expressions'][0]['key'] = 'answer'
            self.assertEqual(DecisionEngine().evaluate(model, {})['result'], {'answer': expected})
        model['nodes'][4]['content']['mergePolicy'] = 'error'
        with self.assertRaisesRegex(ValueError, 'merge conflict'):
            DecisionEngine().evaluate(model, {})
        model['nodes'][3]['content']['expressions'][0]['value'] = '1'
        self.assertEqual(DecisionEngine().evaluate(model, {})['result'], {'answer': 1})

    def test_ancestor_and_array_conflicts(self):
        model = graph('2', '3')
        model['nodes'][2]['content']['expressions'][0]['key'] = 'record'
        model['nodes'][3]['content']['expressions'][0]['key'] = 'record.child'
        with self.assertRaisesRegex(ValueError, 'merge conflict'):
            DecisionEngine().evaluate(model, {'record': {'child': 1}})
        model = graph('[1]', '[2]')
        for node in model['nodes'][2:4]:
            node['content']['expressions'][0]['key'] = 'values'
        with self.assertRaisesRegex(ValueError, 'merge conflict'):
            DecisionEngine().evaluate(model, {'values': []})

    def test_failure_does_not_mutate_input_and_budget_is_shared(self):
        payload = {'base': 10}
        with self.assertRaises(ValueError):
            DecisionEngine().evaluate(graph(right='missing + 1'), payload)
        self.assertEqual(payload, {'base': 10})
        budget = {'remaining': 3}
        with self.assertRaisesRegex(ValueError, 'budget exceeded'):
            DecisionEngine().evaluate(graph(), payload, _budget=budget)
        self.assertEqual(budget['remaining'], 0)

    def test_inferred_join_single_branch_and_empty_branch(self):
        model = graph()
        del model['nodes'][1]['content']['joinId']
        self.assertEqual(validate_parallel_regions(model)['fork']['joinId'], 'join')
        model['edges'] = [edge for edge in model['edges'] if edge['id'] not in ('fr', 'rj')]
        model['nodes'] = [node for node in model['nodes'] if node['id'] != 'right']
        self.assertEqual(DecisionEngine().evaluate(model, {'base': 1})['result']['result']['left'], 2)
        model['edges'].append({'id': 'empty', 'sourceId': 'fork', 'targetId': 'join'})
        self.assertEqual(DecisionEngine().evaluate(model, {'base': 1})['result']['result']['left'], 2)

    def test_reject_unstructured_or_invalid_forks(self):
        mutations = [
            lambda model: model['nodes'][1]['content'].update({'maxWorkers': 0}),
            lambda model: model['nodes'][1]['content'].update({'joinId': 'output'}),
            lambda model: model['nodes'][4]['content'].update({'mergePolicy': 'arbitrary'}),
            lambda model: model['edges'].append({'id': 'cross', 'sourceId': 'left', 'targetId': 'right'}),
            lambda model: model['edges'].append({'id': 'external', 'sourceId': 'input', 'targetId': 'left'}),
            lambda model: model['edges'].append({'id': 'escape', 'sourceId': 'left', 'targetId': 'output'}),
        ]
        for mutation in mutations:
            model = graph()
            mutation(model)
            with self.subTest(model=model), self.assertRaises(ValueError):
                DecisionEngine().evaluate(model, {'base': 1})

    def test_nested_decision_forks_rejected_without_partial_success(self):
        model = graph()
        model['nodes'][2] = {'id': 'left', 'type': 'decisionNode', 'content': {'key': 'nested'}}
        with self.assertRaisesRegex(ValueError, 'Nested parallel'):
            DecisionEngine({'nested': graph()}).evaluate(model, {'base': 1})
