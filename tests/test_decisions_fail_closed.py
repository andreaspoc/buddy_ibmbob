"""Synthetic offer rules must refuse bad data instead of deciding from it."""
import unittest

from app.decisions_buddy.bal_engine import action_target
from app.decisions_buddy.decision_engine import (
    DecisionEngine, evaluate_decision_table, evaluate_expression, evaluate_unary)
from app.decisions_buddy.safe_expression import exact_round, exact_sum


def node(identifier, kind, content=None):
    return {'id': identifier, 'type': kind, 'content': content or {}}


def edge(identifier, source, target, handle=None):
    item = {'id': identifier, 'sourceId': source, 'targetId': target}
    return {**item, 'sourceHandle': handle} if handle else item


def stop_table(cell, field='flag', **column):
    return {'hitPolicy': 'first', 'inputs': [{'id': 'c', 'field': field, **column}],
            'outputs': [{'id': 'o', 'field': 'blocked'}],
            'rules': [{'c': cell, 'o': 'true'}, {'c': '', 'o': 'false'}]}


def run(graph, payload, engine=None):
    return (engine or DecisionEngine()).evaluate(graph, payload)


class MissingDataTests(unittest.TestCase):
    def test_tested_column_with_missing_value_stops_the_decision(self):
        for cell in ('< 18', 'true', 'false', '!= "IR"', 'not in ["IR"]', '[1..5]'):
            with self.subTest(cell=cell), self.assertRaisesRegex(ValueError, 'Required decision input is missing: flag'):
                evaluate_decision_table(stop_table(cell), {})

    def test_optional_column_skips_unknown_values_instead_of_matching_them(self):
        for cell in ('< 18', '!= "IR"', 'not in ["IR"]', 'not(in ["IR"])', 'true'):
            with self.subTest(cell=cell):
                result, _ = evaluate_decision_table(stop_table(cell, optional=True), {})
                self.assertIs(result['blocked'], False)

    def test_null_aware_cells_and_untested_columns_accept_missing_values(self):
        result, _ = evaluate_decision_table(stop_table('is null'), {})
        self.assertIs(result['blocked'], True)
        result, _ = evaluate_decision_table(stop_table('< 18 or is null'), {})
        self.assertIs(result['blocked'], True)
        result, _ = evaluate_decision_table(stop_table('-'), {})
        self.assertIs(result['blocked'], True)

    def test_unary_null_rules(self):
        self.assertFalse(evaluate_unary('!= "IR"', None)['passed'])
        self.assertFalse(evaluate_unary('none < 0', None)['passed'])
        self.assertTrue(evaluate_unary('== null', None)['passed'])
        self.assertTrue(evaluate_unary('is null', None)['passed'])
        self.assertFalse(evaluate_unary('is not null', None)['passed'])
        self.assertTrue(evaluate_unary('? == null', None)['passed'])
        self.assertFalse(evaluate_unary('"null"', None)['passed'])

    def test_expression_exclusions_do_not_match_unknown_values(self):
        self.assertIs(evaluate_expression('country != "IR"', {'country': None}), False)
        self.assertIs(evaluate_expression('country not in ["IR"]', {'country': None}), False)
        self.assertIs(evaluate_expression('country != null', {'country': None}), False)
        self.assertIs(evaluate_expression('country == null', {'country': None}), True)
        self.assertIs(evaluate_expression('country != "IR"', {'country': 'CY'}), True)
        self.assertIs(evaluate_expression('country != null', {'country': 'CY'}), True)


class BooleanTests(unittest.TestCase):
    def test_boolean_cells_require_real_booleans(self):
        for value in ('false', 'no', 'true', 0, 1, [], {}):
            for cell in ('true', 'false'):
                with self.subTest(value=value, cell=cell), self.assertRaisesRegex(ValueError, 'boolean value'):
                    evaluate_unary(cell, value)

    def test_boolean_cells_match_booleans(self):
        self.assertTrue(evaluate_unary('true', True)['passed'])
        self.assertFalse(evaluate_unary('true', False)['passed'])
        self.assertTrue(evaluate_unary('false', False)['passed'])
        self.assertFalse(evaluate_unary('false', True)['passed'])

    def test_consent_text_stops_the_graph(self):
        graph = {'nodes': [node('i', 'inputNode'), node('t', 'decisionTableNode', stop_table('true', 'consent')),
                           node('o', 'outputNode', {'schema': ['blocked']})],
                 'edges': [edge('a', 'i', 't'), edge('b', 't', 'o')]}
        with self.assertRaisesRegex(ValueError, 'boolean value'):
            run(graph, {'consent': 'false'})
        self.assertEqual(run(graph, {'consent': True})['result'], {'blocked': True})


class OutputBoundaryTests(unittest.TestCase):
    def switch_graph(self, schema):
        return {'nodes': [node('i', 'inputNode'),
                          node('s', 'switchNode', {'statements': [{'id': 'gold', 'condition': 'tier == "gold"'}]}),
                          node('e', 'expressionNode', {'expressions': [{'key': 'offer', 'value': '"GOLD"'}]}),
                          node('o', 'outputNode', {'schema': schema})],
                'edges': [edge('a', 'i', 's'), edge('b', 's', 'e', 'gold'), edge('c', 'e', 'o')]}

    def test_unreached_output_returns_nothing(self):
        result = run(self.switch_graph(['offer']), {'tier': 'none', 'nationalId': 'SYNTHETIC', 'income': 1})
        self.assertEqual(result['result'], {})
        self.assertIs(result['reachedOutput'], False)

    def test_reached_output_publishes_only_listed_fields(self):
        result = run(self.switch_graph(['offer']), {'tier': 'gold', 'nationalId': 'SYNTHETIC'})
        self.assertEqual(result['result'], {'offer': 'GOLD'})
        self.assertIs(result['reachedOutput'], True)

    def test_object_schema_properties_limit_the_output(self):
        schema = {'type': 'object', 'properties': {'offer': {'type': 'string'}}}
        result = run(self.switch_graph(schema), {'tier': 'gold', 'nationalId': 'SYNTHETIC'})
        self.assertEqual(result['result'], {'offer': 'GOLD'})
        schema = {**schema, 'additionalProperties': True}
        result = run(self.switch_graph(schema), {'tier': 'gold', 'nationalId': 'SYNTHETIC'})
        self.assertEqual(result['result']['nationalId'], 'SYNTHETIC')

    def test_graph_without_output_node_keeps_returning_its_document(self):
        graph = {'nodes': [node('e', 'expressionNode', {'expressions': [{'key': 'a', 'value': '1'}]})], 'edges': []}
        result = run(graph, {'b': 2})
        self.assertEqual(result['result'], {'a': 1, 'b': 2})
        self.assertIs(result['reachedOutput'], True)


class CallerDecisionTests(unittest.TestCase):
    def graph(self, decider, schema=None):
        schema = schema or {'type': 'object'}
        return {'nodes': [node('i', 'inputNode'), decider, node('o', 'outputNode', {'schema': schema})],
                'edges': [edge('a', 'i', decider['id']), edge('b', decider['id'], 'o')]}

    def table(self):
        return node('t', 'decisionTableNode', {'hitPolicy': 'first', 'inputs': [{'id': 'c', 'field': 'tier'}],
                                               'outputs': [{'id': 'r', 'field': 'offer'}],
                                               'rules': [{'c': '"gold"', 'r': '"GOLD"'}]})

    def test_unmatched_table_drops_a_caller_supplied_decision(self):
        result = run(self.graph(self.table()), {'tier': 'none', 'offer': 'CALLER'})['result']
        self.assertEqual(result, {'tier': 'none'})
        self.assertIsNone(run(self.graph(self.table(), ['offer']), {'tier': 'none', 'offer': 'CALLER'})['result']['offer'])

    def test_computed_decision_replaces_a_caller_value(self):
        result = run(self.graph(self.table(), ['offer']), {'tier': 'gold', 'offer': 'CALLER'})['result']
        self.assertEqual(result, {'offer': 'GOLD'})

    def test_action_rule_only_counts_when_it_writes(self):
        rule = node('r', 'businessRuleNode', {'source': 'if tier == "gold" then set offer to "GOLD";'})
        self.assertEqual(run(self.graph(rule, ['offer']), {'tier': 'none', 'offer': 'CALLER'})['result'], {'offer': None})
        self.assertEqual(run(self.graph(rule, ['offer']), {'tier': 'gold', 'offer': 'CALLER'})['result'], {'offer': 'GOLD'})

    def test_agenda_writes_are_recognized(self):
        agenda = node('a', 'inferenceNode', {'rules': [
            {'id': 'text', 'condition': 'tier == "gold"', 'actions': 'set offer to "GOLD"'},
            {'id': 'insert', 'condition': 'tier == "gold"', 'actions': [
                {'op': 'insert', 'collection': 'offers', 'value': '{"code": "GOLD"}'}]}]})
        payload = {'tier': 'none', 'offer': 'CALLER', 'offers': [{'code': 'CALLER'}]}
        self.assertEqual(run(self.graph(agenda, ['offer', 'offers']), payload)['result'], {'offer': None, 'offers': None})
        payload['tier'] = 'gold'
        result = run(self.graph(agenda, ['offer', 'offers']), payload)['result']
        self.assertEqual(result['offer'], 'GOLD')
        self.assertEqual(result['offers'], [{'code': 'CALLER'}, {'code': 'GOLD'}])

    def test_sub_decision_writes_are_recognized_and_cycles_stop(self):
        engine = DecisionEngine({'child': {'nodes': [self.table()], 'edges': []}})
        parent = self.graph(node('d', 'decisionNode', {'key': 'child'}), ['offer'])
        self.assertEqual(run(parent, {'tier': 'gold', 'offer': 'CALLER'}, engine)['result'], {'offer': 'GOLD'})
        self.assertEqual(run(parent, {'tier': 'none', 'offer': 'CALLER'}, engine)['result'], {'offer': None})
        loop = DecisionEngine({'self': {'nodes': [node('d', 'decisionNode', {'key': 'self'})], 'edges': []}})
        self.assertEqual(loop._declared_writes(loop.decisions['self']), set())
        wrapped = {'graph': {'nodes': [self.table()], 'edges': []}}
        self.assertEqual(engine._declared_writes(wrapped), {'offer'})

    def test_graph_without_output_also_drops_unwritten_decisions(self):
        graph = {'nodes': [self.table()], 'edges': []}
        self.assertEqual(run(graph, {'tier': 'none', 'offer': 'CALLER'})['result'], {'tier': 'none'})

    def test_nested_paths_and_unmodified_inputs_survive(self):
        table = node('t', 'decisionTableNode', {'hitPolicy': 'first', 'inputs': [{'id': 'c', 'field': 'tier'}],
                                                'outputs': [{'id': 'r', 'field': 'out.offer'}],
                                                'rules': [{'c': '"gold"', 'r': '"GOLD"'}]})
        result = run({'nodes': [table], 'edges': []}, {'tier': 'none', 'out': {'offer': 'CALLER', 'keep': 1}})['result']
        self.assertEqual(result, {'tier': 'none', 'out': {'keep': 1}})


class AuthoringMistakeTests(unittest.TestCase):
    def expression_graph(self, value):
        return {'nodes': [node('e', 'expressionNode', {'expressions': [{'key': 'price', 'value': value}]})], 'edges': []}

    def test_misspelled_field_in_formula_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Unknown field basePric'):
            run(self.expression_graph('basePric'), {'basePrice': 100})
        self.assertEqual(run(self.expression_graph('basePrice'), {'basePrice': 100})['result']['price'], 100)
        self.assertEqual(run(self.expression_graph('"basePric"'), {})['result']['price'], 'basePric')

    def test_table_cells_accept_constants_but_not_lowercase_words(self):
        table = {'hitPolicy': 'first', 'inputs': [], 'outputs': [{'id': 'o', 'field': 'band'}], 'rules': [{'o': 'TIER_1'}]}
        self.assertEqual(evaluate_decision_table(table, {})[0], {'band': 'TIER_1'})
        table['rules'] = [{'o': 'tier_one'}]
        with self.assertRaisesRegex(ValueError, 'Unknown field tier_one'):
            evaluate_decision_table(table, {})

    def test_list_functions_refuse_conditions_passed_as_field_names(self):
        offers = {'offers': [{'code': 'A', 'net': 3}]}
        for source in ('filter(offers, "net > 4")', 'map(offers, "net > 4")', 'find(offers, "net > 4")', 'sortBy(offers, "net > 4")'):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'field name'):
                evaluate_expression(source, offers)

    def test_action_target_reads_set_and_add(self):
        self.assertEqual(action_target('set order.discount to 1;'), 'order.discount')
        self.assertEqual(action_target('add "x" to order.notes'), 'order.notes')
        self.assertIsNone(action_target('   '))
        self.assertIsNone(action_target('unknown statement'))


class MoneyTests(unittest.TestCase):
    def test_decimal_arithmetic(self):
        self.assertEqual(evaluate_expression('0.1 + 0.2', {}), 0.3)
        self.assertEqual(evaluate_expression('0.3 - 0.1', {}), 0.2)
        self.assertEqual(evaluate_expression('3.35 * 0.9', {}), 3.015)
        self.assertEqual(evaluate_expression('1 / 4', {}), 0.25)
        self.assertEqual(evaluate_expression('2 + 3', {}), 5)
        self.assertIs(type(evaluate_expression('2 * 3', {})), int)
        self.assertEqual(evaluate_expression('"a" * 2', {}), 'aa')

    def test_division_by_zero_is_a_clear_refusal(self):
        with self.assertRaisesRegex(ValueError, 'Division by zero'):
            evaluate_expression('a / 0', {'a': 1})

    def test_half_up_rounding_and_exact_totals(self):
        self.assertEqual(exact_round(2.675, 2), 2.68)
        self.assertEqual(exact_round(3.015, 2), 3.02)
        self.assertEqual(exact_round(-2.5), -3.0)
        self.assertEqual(exact_round(None), 0.0)
        self.assertEqual(exact_round(1250, -2), 1300.0)
        self.assertEqual(exact_sum([0.1, 0.2, None]), 0.3)
        self.assertEqual(evaluate_expression('round(2.675, 2)', {}), 2.68)
        self.assertEqual(evaluate_expression('sum(values)', {'values': [0.1, 0.2]}), 0.3)
        self.assertEqual(evaluate_expression('avg(values)', {'values': [0.1, 0.2]}), 0.15)
        self.assertEqual(evaluate_expression('avg(values)', {'values': []}), 0)

    def test_collect_sum_is_exact(self):
        table = {'hitPolicy': 'collect', 'inputs': [], 'outputs': [{'id': 'o', 'field': 'fee', 'collect': 'sum'}],
                 'rules': [{'o': '0.1'}, {'o': '0.2'}]}
        self.assertEqual(evaluate_decision_table(table, {})[0], {'fee': 0.3})


class CapabilityTests(unittest.TestCase):
    OFFERS = {'offers': [{'code': 'A', 'net': 3}, {'code': 'B', 'net': 9}, {'code': 'C', 'net': 9}]}

    def test_sort_by_is_stable_and_refuses_gaps(self):
        ranked = evaluate_expression('slice(sortBy(offers, "net", true), 0, 2)', self.OFFERS)
        self.assertEqual([item['code'] for item in ranked], ['B', 'C'])
        self.assertEqual(evaluate_expression('sort_by(offers, "net")', self.OFFERS)[0]['code'], 'A')
        self.assertEqual(evaluate_expression('sortBy(missing_value, "net")', {'missing_value': None}), [])
        with self.assertRaisesRegex(ValueError, 'on every item'):
            evaluate_expression('sortBy(offers, "net")', {'offers': [{'net': 1}, {}]})

    def test_list_helpers_handle_ordinary_inputs(self):
        self.assertEqual(evaluate_expression('map(offers, "code")', self.OFFERS), ['A', 'B', 'C'])
        self.assertEqual(evaluate_expression('filter(offers, "net", 9)', self.OFFERS), self.OFFERS['offers'][1:])
        self.assertEqual(evaluate_expression('find(offers, "net", 9)', self.OFFERS)['code'], 'B')
        self.assertIsNone(evaluate_expression('find(offers, "net", 1)', self.OFFERS))
        self.assertEqual(evaluate_expression('map(items, "a")', {'items': None}), [])
        self.assertEqual(evaluate_expression('filter(items, "a")', {'items': None}), [])

    def test_bucket_is_stable_and_bounded(self):
        first = evaluate_expression('bucket(id, 100)', {'id': 'SYN-1'})
        self.assertEqual(first, evaluate_expression('bucket(id, 100)', {'id': 'SYN-1'}))
        self.assertTrue(0 <= first < 100)
        for source in ('bucket(id, 0)', 'bucket(gone, 10)'):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'bucket requires'):
                evaluate_expression(source, {'id': 'SYN-1', 'gone': None})

    def test_mixed_timestamps_are_compared_as_utc(self):
        self.assertEqual(evaluate_expression('diffDays("2026-11-01T00:00:00Z", "2026-11-30")', {}), 29)
        self.assertEqual(evaluate_expression('diff_days("2026-11-01", "2026-11-30")', {}), 29)

    def test_conditional_syntax(self):
        self.assertEqual(evaluate_expression('a > 1 ? "x" : "code:2"', {'a': 0}), 'code:2')
        self.assertEqual(evaluate_expression('a > 1 ? "why?" : "no"', {'a': 2}), 'why?')
        self.assertEqual(evaluate_expression('a > 1 ? "x" : a > 0 ? "y" : "z"', {'a': 0}), 'z')
        self.assertEqual(evaluate_expression('a > 1 ? a > 2 ? "big" : "mid" : "low"', {'a': 2}), 'mid')
        self.assertEqual(evaluate_expression('a ? {"k": 1} : {"k": 2}', {'a': False}), {'k': 2})
        self.assertEqual(evaluate_expression('"a\\"?b:c"', {}), 'a"?b:c')
        self.assertEqual(evaluate_expression('10 + (free ? 0.0 : 14.99)', {'free': False}), 24.99)
        self.assertEqual(evaluate_expression('round(free ? 1.005 : 2.005, 2)', {'free': True}), 1.01)
        self.assertEqual(evaluate_expression('[a ? 1 : 2, a ? 3 : 4]', {'a': False}), [2, 4])
        self.assertEqual(evaluate_expression('{"k": a ? 1 : 2}', {'a': True}), {'k': 1})
        self.assertEqual(evaluate_expression('(a ? (b ? 1 : 2) : 3) + 1', {'a': True, 'b': False}), 3)

    def test_default_rule_limit_handles_large_carts(self):
        rule = {'id': 'each', 'patterns': [{'collection': 'items', 'as': 'item', 'equals': {'done': False}}],
                'actions': [{'op': 'update', 'fact': 'item', 'values': {'done': 'true'}}]}
        graph = {'nodes': [node('a', 'inferenceNode', {'rules': [rule]})], 'edges': []}
        result = run(graph, {'items': [{'done': False} for _ in range(120)]})['result']
        self.assertTrue(all(item['done'] for item in result['items']))


if __name__ == '__main__':
    unittest.main()
