"""Regression cases from the functional review, using synthetic rule data only."""
import unittest
from unittest.mock import patch

from app.decisions_buddy.analysis import analyze_decision_table
from app.decisions_buddy.decision_engine import DecisionEngine, evaluate_expression, evaluate_unary
from app.decisions_buddy.safe_expression import validate_graph


def node(identity, kind, content=None):
    return {'id': identity, 'type': kind, 'content': content or {}}


def edge(identity, source, target, **metadata):
    return {'id': identity, 'sourceId': source, 'targetId': target, **metadata}


def switch_graph(condition='true and false'):
    return {
        'nodes': [node('i', 'inputNode'), node('s', 'switchNode', {'statements': [
            {'id': 'yes', 'condition': condition}, {'id': 'no', 'condition': ''}]}),
            node('yes', 'expressionNode', {'expressions': [{'key': 'answer', 'value': '1'}]}),
            node('no', 'expressionNode', {'expressions': [{'key': 'answer', 'value': '2'}]}),
            node('o', 'outputNode')],
        'edges': [edge('is', 'i', 's'), edge('sy', 's', 'yes', sourceHandle='yes'),
                  edge('sn', 's', 'no', sourceHandle='no'), edge('yo', 'yes', 'o'), edge('no', 'no', 'o')],
    }


class TableIdentityTests(unittest.TestCase):
    def test_ambiguous_table_identifiers_are_rejected(self):
        def graph(content):
            return {'nodes': [node('table', 'decisionTableNode', content)], 'edges': []}

        with self.assertRaisesRegex(ValueError, 'columns require unique'):
            validate_graph(graph({'inputs': [{'id': 'x', 'field': 'a'}],
                                  'outputs': [{'id': 'x', 'field': 'b'}]}))
        with self.assertRaisesRegex(ValueError, 'columns require unique'):
            validate_graph(graph({'inputs': [{'id': 'x', 'field': ''}]}))
        with self.assertRaisesRegex(ValueError, 'rule identifiers'):
            validate_graph(graph({'rules': [{}, {'_id': 'rule_1'}]}))
        with self.assertRaisesRegex(ValueError, 'hitPolicy'):
            validate_graph(graph({'hitPolicy': None}))
        validate_graph(graph({'inputs': [{'id': 'x', 'field': 'a'}],
                              'outputs': [{'id': 'y', 'field': 'b'}],
                              'rules': [{}, {'_id': 'other'}]}))


class ExpressionCorrectnessTests(unittest.TestCase):
    def test_boolean_syntax_is_evaluated_instead_of_returned_as_literal(self):
        self.assertIs(evaluate_expression('true and false', {}), False)
        self.assertIs(evaluate_expression('false or true', {}), True)
        self.assertIs(evaluate_expression('not true', {}), False)
        self.assertIs(evaluate_expression('a and b', {'a': True, 'b': False}), False)
        self.assertEqual(evaluate_expression('standard', {}), 'standard')
        self.assertEqual(evaluate_expression('price - discount', {'price': 20, 'discount': 5}), 15)
        with self.assertRaises(SyntaxError):
            evaluate_expression('unquoted label', {})

    def test_quoted_concatenation_and_escaped_strings_are_expressions(self):
        self.assertEqual(evaluate_expression('"a" + "b"', {}), 'ab')
        self.assertEqual(evaluate_expression("'a' + 'b'", {}), 'ab')
        self.assertEqual(evaluate_expression('"line\\nnext"', {}), 'line\nnext')
        self.assertEqual(evaluate_expression('"a" if false else "b"', {}), 'b')

    def test_singleton_and_many_element_min_max(self):
        for fn in ('min', 'max'):
            self.assertEqual(evaluate_expression(f'{fn}(values)', {'values': [7]}), 7)
            with self.assertRaises(ValueError):
                evaluate_expression(f'{fn}(values)', {'values': []})
        self.assertEqual(evaluate_expression('min(values)', {'values': [7, -2, 5]}), -2)
        self.assertEqual(evaluate_expression('max(values)', {'values': [7, -2, 5]}), 7)
        self.assertEqual(evaluate_expression('min(7, 2)', {}), 2)

    def test_numeric_order_does_not_accept_missing_or_incompatible_values(self):
        for value in (None, {}, [], 'not numeric', True, float('inf'), float('nan')):
            for condition in ('> 10', '< 10', '>= 10', '<= 10'):
                with self.subTest(value=value, condition=condition):
                    self.assertFalse(evaluate_unary(condition, value)['passed'])
        self.assertTrue(evaluate_unary('> 10', '11')['passed'])
        self.assertTrue(evaluate_unary('> "alpha"', 'beta')['passed'])
        self.assertFalse(evaluate_unary('> null', 11)['passed'])
        self.assertTrue(evaluate_unary('== null', None)['passed'])

    def test_logical_words_inside_quoted_literal_are_not_split(self):
        for text in ('A or B', 'A and B'):
            self.assertTrue(evaluate_unary('"' + text + '"', text)['passed'])
            self.assertFalse(evaluate_unary('"' + text + '"', 'different')['passed'])


class GraphCorrectnessTests(unittest.TestCase):
    def test_switch_false_condition_routes_only_fallback(self):
        result = DecisionEngine().evaluate(switch_graph(), {})
        self.assertEqual(result['result']['answer'], 2)
        states = {item['id']: item['status'] for item in result['trace']}
        self.assertEqual(states['yes'], 'skipped')
        self.assertEqual(states['no'], 'success')
        self.assertEqual(states['o'], 'success')

    def test_switch_true_condition_routes_only_matching_branch(self):
        result = DecisionEngine().evaluate(switch_graph('true'), {})
        self.assertEqual(result['result']['answer'], 1)
        states = {item['id']: item['status'] for item in result['trace']}
        self.assertEqual(states['no'], 'skipped')

    def test_non_boolean_switch_results_fail_instead_of_becoming_truthy(self):
        for condition in ('"false"', 'standard', '1', 'null'):
            with self.subTest(condition=condition), self.assertRaisesRegex(ValueError, 'boolean|Unknown field'):
                DecisionEngine().evaluate(switch_graph(condition), {})

    def test_missing_duplicate_and_empty_edge_ids_are_rejected(self):
        for change in ('missing', 'duplicate', 'empty'):
            graph = switch_graph()
            if change == 'missing':
                graph['edges'][0].pop('id')
            elif change == 'duplicate':
                graph['edges'][1]['id'] = graph['edges'][0]['id']
            else:
                graph['edges'][0]['id'] = ''
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'unique identifier'):
                validate_graph(graph)

    def test_switch_handles_and_statement_ids_are_required_and_valid(self):
        for change in ('handle_missing', 'handle_unknown', 'statement_missing', 'statement_duplicate', 'condition_number'):
            graph = switch_graph()
            if change == 'handle_missing': graph['edges'][1].pop('sourceHandle')
            elif change == 'handle_unknown': graph['edges'][1]['sourceHandle'] = 'unknown'
            elif change == 'statement_missing': graph['nodes'][1]['content']['statements'][0].pop('id')
            elif change == 'statement_duplicate': graph['nodes'][1]['content']['statements'][1]['id'] = 'yes'
            else: graph['nodes'][1]['content']['statements'][0]['condition'] = 5
            with self.subTest(change=change), self.assertRaises(ValueError): validate_graph(graph)

    def test_unsupported_hit_policy_cannot_silently_use_another_policy(self):
        graph = switch_graph()
        graph['nodes'][1]['content']['hitPolicy'] = 'collect'
        with self.assertRaisesRegex(ValueError, 'first-hit'): validate_graph(graph)
        graph['nodes'][1] = node('s', 'decisionTableNode', {'hitPolicy': 'unexpected'})
        with self.assertRaisesRegex(ValueError, 'hitPolicy'): validate_graph(graph)

    def test_repeated_nested_fanout_shares_one_root_node_budget(self):
        def fanout(child):
            return {'nodes': [node(f'ref{index}', 'decisionNode', {'key': child})
                              for index in range(4)], 'edges': []}
        terminal = {'nodes': [node('e', 'expressionNode', {
            'expressions': [{'key': 'answer', 'value': '42'}]}), node('o', 'outputNode')],
            'edges': [edge('eo', 'e', 'o')]}
        engine = DecisionEngine({'leaf': terminal, 'branch': fanout('leaf')})
        # Every individual graph fits below this budget. Only the combined
        # repeated references exceed it; giving each child a fresh budget fails
        # to protect the root request.
        with patch('app.decisions_buddy.decision_engine.MAX_NODE_EVALUATIONS', 16):
            with self.assertRaisesRegex(ValueError, 'node budget exceeded'):
                engine.evaluate(fanout('branch'), {})
            self.assertEqual(engine.evaluate(terminal, {})['result']['answer'], 42)
        self.assertEqual(engine.evaluate(fanout('branch'), {})['result']['answer'], 42)

    def test_nested_writes_never_mutate_input_or_prior_trace_snapshots(self):
        graph = {'nodes': [node('i', 'inputNode'), node('e', 'expressionNode', {
            'expressions': [{'key': 'customer.tier', 'value': '"gold"'}]}), node('o', 'outputNode')],
            'edges': [edge('ie', 'i', 'e'), edge('eo', 'e', 'o')]}
        original = {'customer': {'tier': 'bronze'}}
        result = DecisionEngine().evaluate(graph, original)
        self.assertEqual(original['customer']['tier'], 'bronze')
        self.assertEqual(result['trace'][0]['outputSnapshot']['customer']['tier'], 'bronze')
        self.assertEqual(result['trace'][1]['inputSnapshot']['customer']['tier'], 'bronze')
        self.assertEqual(result['result']['customer']['tier'], 'gold')
        result['result']['customer']['tier'] = 'changed after evaluation'
        self.assertEqual(result['trace'][-1]['outputSnapshot']['customer']['tier'], 'gold')

    def test_output_objects_and_rule_trace_are_independent_of_later_nested_writes(self):
        graph = {'nodes': [node('i', 'inputNode'), node('t', 'decisionTableNode', {
            'hitPolicy': 'first', 'inputs': [{'id': 'c', 'field': 'customer'}],
            'outputs': [{'id': 'o', 'field': 'copy'}], 'rules': [{'c': '-', 'o': 'customer'}]}),
            node('e', 'expressionNode', {'expressions': [{'key': 'customer.tier', 'value': '"gold"'}]}),
            node('o', 'outputNode')], 'edges': [edge('it', 'i', 't'), edge('te', 't', 'e'), edge('eo', 'e', 'o')]}
        result = DecisionEngine().evaluate(graph, {'customer': {'tier': 'bronze'}})
        table = result['trace'][1]
        self.assertEqual(table['outputSnapshot']['copy']['tier'], 'bronze')
        self.assertEqual(table['ruleTrace'][0]['conditions'][0]['actual']['tier'], 'bronze')


class AnalysisCorrectnessTests(unittest.TestCase):
    def analyze(self, first, second, policy='first'):
        return analyze_decision_table({'hitPolicy': policy, 'inputs': [{'id': 'x'}],
                                      'outputs': [], 'rules': [{'x': first}, {'x': second}]})

    def test_collect_catchall_does_not_make_later_rows_unreachable(self):
        self.assertFalse(any(item['severity'] == 'error' for item in self.analyze('-', '> 0', 'collect')))
        self.assertTrue(any(item['code'] == 'UNREACHABLE_RULE' for item in self.analyze('-', '> 0')))

    def test_inequality_shadowing_respects_equal_boundary_inclusion(self):
        for first, second, expected in [('> 10', '>= 10', False), ('>= 10', '> 10', True),
                                        ('< 10', '<= 10', False), ('<= 10', '< 10', True),
                                        ('> 10', '> 10', True), ('< 10', '< 10', True),
                                        ('> -10', '>= -9', True), ('< -9', '<= -10', True)]:
            with self.subTest(first=first, second=second):
                diagnostics = self.analyze(first, second)
                self.assertEqual(any(item['code'] == 'INEQUALITY_SHADOW' for item in diagnostics), expected)
