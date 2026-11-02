"""Synthetic fact lifecycle, pattern joining, agenda conflict and budget tests."""
from copy import deepcopy
import unittest

from app.decisions_buddy.inference_engine import RuleAgenda


class FactInferenceTests(unittest.TestCase):
    def test_pattern_update_then_insert_then_retract(self):
        rules = [
            {'id': 'approve', 'priority': 20,
             'patterns': [{'collection': 'facts.orders', 'as': 'order',
                           'equals': {'status': 'pending'}, 'where': 'order.total >= 100'}],
             'actions': [{'op': 'update', 'fact': 'order', 'values': {'status': '"approved"'}}]},
            {'id': 'notify', 'priority': 10,
             'patterns': [{'collection': 'facts.orders', 'as': 'order', 'equals': {'status': 'approved'}}],
             'actions': [{'op': 'insert', 'collection': 'facts.notifications',
                          'value': '{"orderId": order.id, "message": "approved"}'},
                         {'op': 'retract', 'fact': 'order'}]},
        ]
        memory = {'facts': {'orders': [{'id': 'A', 'status': 'pending', 'total': 120},
                                       {'id': 'B', 'status': 'pending', 'total': 30}]}}
        result = RuleAgenda(rules).run(memory)
        self.assertEqual(result['totalFired'], 2)
        self.assertEqual(memory['facts']['orders'], [{'id': 'B', 'status': 'pending', 'total': 30}])
        self.assertEqual(memory['facts']['notifications'], [{'orderId': 'A', 'message': 'approved'}])
        self.assertEqual(result['firings'][0]['actions'][0]['values'], {'status': 'approved'})

    def test_multiple_fact_tuples_and_join(self):
        rule = {'id': 'join', 'patterns': [
            {'collection': 'orders', 'as': 'order', 'equals': {'status': 'pending'}},
            {'collection': 'customers', 'as': 'customer', 'where': 'customer.id == order.customerId'},
        ], 'condition': 'customer.active', 'actions': [
            {'op': 'insert', 'collection': 'matches', 'value': '{"orderId": order.id, "customerId": customer.id}'}]}
        memory = {'orders': [{'id': 'O1', 'customerId': 'C1', 'status': 'pending'},
                             {'id': 'O2', 'customerId': 'C2', 'status': 'pending'}],
                  'customers': [{'id': 'C1', 'active': True}, {'id': 'C2', 'active': False}]}
        self.assertEqual(RuleAgenda([rule]).run(memory)['totalFired'], 1)
        self.assertEqual(memory['matches'], [{'orderId': 'O1', 'customerId': 'C1'}])
        self.assertNotIn('order', memory)
        self.assertNotIn('customer', memory)

    def test_distinct_identical_facts_each_fire_and_refraction_prevents_loops(self):
        rule = {'patterns': [{'collection': 'items', 'as': 'item'}],
                'actions': [{'op': 'insert', 'collection': 'output', 'value': '{"value": item.value}'}]}
        memory = {'items': [{'value': 1}, {'value': 1}]}
        result = RuleAgenda([rule]).run(memory)
        self.assertEqual(result['totalFired'], 2)
        self.assertEqual(memory['output'], [{'value': 1}, {'value': 1}])
        self.assertNotEqual(result['firings'][0]['bindings'], result['firings'][1]['bindings'])

    def test_priority_and_specificity_conflict_resolution(self):
        rules = [
            {'id': 'general', 'actions': ['add "general" to sequence']},
            {'id': 'specific', 'patterns': [{'collection': 'items', 'as': 'item', 'equals': {'active': True}}],
             'actions': ['add "specific" to sequence']},
        ]
        first = {'items': [{'active': True}]}
        second = deepcopy(first)
        RuleAgenda(rules).run(first)
        result = RuleAgenda(rules, conflict_resolution='specificity').run(second)
        self.assertEqual(first['sequence'], ['general', 'specific'])
        self.assertEqual(second['sequence'], ['specific', 'general'])
        self.assertEqual(result['conflictResolution'], 'specificity')
        high = dict(rules[0], priority=50)
        third = {'items': [{'active': True}]}
        RuleAgenda([high, rules[1]], conflict_resolution='specificity').run(third)
        self.assertEqual(third['sequence'], ['general', 'specific'])

    def test_recency_prefers_updated_fact_and_trace_is_snapshot(self):
        rules = [
            {'id': 'update', 'priority': 10,
             'patterns': [{'collection': 'items', 'as': 'item', 'equals': {'id': 'B'}}],
             'actions': [{'op': 'update', 'fact': 'item', 'values': {'value': 'item.value + 1'}}]},
            {'id': 'record', 'patterns': [{'collection': 'items', 'as': 'item'}],
             'actions': ['add item.id to sequence']},
        ]
        memory = {'items': [{'id': 'A', 'value': 0}, {'id': 'B', 'value': 0}]}
        result = RuleAgenda(rules, conflict_resolution='recency').run(memory)
        self.assertEqual(memory['sequence'], ['B', 'A'])
        memory['items'][1]['value'] = 99
        self.assertEqual(result['firings'][0]['actions'][0]['values']['value'], 1)

    def test_missing_collection_and_json_type_sensitive_equals(self):
        rule = {'patterns': [{'collection': 'items', 'as': 'item', 'equals': {'enabled': True}}],
                'actions': ['add item.id to sequence']}
        self.assertEqual(RuleAgenda([rule]).run({})['totalFired'], 0)
        memory = {'items': [{'id': 'number', 'enabled': 1}, {'id': 'boolean', 'enabled': True}]}
        RuleAgenda([rule]).run(memory)
        self.assertEqual(memory['sequence'], ['boolean'])

    def test_fact_error_and_limit_are_atomic(self):
        memory = {'items': [{'id': 'A'}]}
        original = deepcopy(memory)
        rules = [{'patterns': [{'collection': 'items', 'as': 'item'}], 'actions': [
            {'op': 'update', 'fact': 'item', 'values': {'changed': 'true'}},
            {'op': 'insert', 'collection': 'newItems', 'value': 'unknown'}]}]
        with self.assertRaises(ValueError):
            RuleAgenda(rules).run(memory)
        self.assertEqual(memory, original)
        rule = {'patterns': [{'collection': 'items', 'as': 'item'}],
                'actions': [{'op': 'insert', 'collection': 'items', 'value': '{"id": "new"}'}]}
        with self.assertRaisesRegex(ValueError, 'firing limit'):
            RuleAgenda([rule], max_cycles=2).run(memory)
        self.assertEqual(memory, original)

    def test_validation_shadowing_and_retracted_handle(self):
        invalid = [
            {'patterns': [{'collection': 'items', 'as': '_item'}]},
            {'patterns': [{'collection': 'items', 'as': 'item'}, {'collection': 'other', 'as': 'item'}]},
            {'actions': [{'op': 'retract', 'fact': 'missing'}]},
            {'actions': [{'op': 'insert', 'collection': 'items', 'value': {}}]},
        ]
        for rule in invalid:
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                RuleAgenda([rule])
        with self.assertRaises(ValueError):
            RuleAgenda([], conflict_resolution='random')
        with self.assertRaisesRegex(ValueError, 'shadow'):
            RuleAgenda([{'patterns': [{'collection': 'items', 'as': 'item'}]}]).run({'item': 2})
        memory = {'items': [{'id': 'A'}]}
        with self.assertRaisesRegex(ValueError, 'already been retracted'):
            RuleAgenda([{'patterns': [{'collection': 'items', 'as': 'item'}], 'actions': [
                {'op': 'retract', 'fact': 'item'}, {'op': 'retract', 'fact': 'item'}]}]).run(memory)
        self.assertEqual(memory, {'items': [{'id': 'A'}]})

    def test_vocabulary_conditions_and_actions(self):
        vocabulary = [{'term': 'account balance', 'path': 'account.balance', 'type': 'number'},
                      {'term': 'account eligible', 'path': 'eligible', 'type': 'boolean'}]
        memory = {'account': {'balance': 120}}
        result = RuleAgenda([{'condition': 'account balance is at least 100',
                              'actions': ['set account eligible to true']}], vocabulary=vocabulary).run(memory)
        self.assertEqual(result['totalFired'], 1)
        self.assertTrue(memory['eligible'])
        with self.assertRaises(ValueError):
            RuleAgenda([{'actions': ['set account balance to "bad"']}], vocabulary=vocabulary).run(memory)
        self.assertEqual(memory['account']['balance'], 120)

    def test_missing_field_is_distinct_from_explicit_null(self):
        memory = {'items': [{'id': 'missing'}, {'id': 'null', 'status': None}]}
        RuleAgenda([{'patterns': [{'collection': 'items', 'as': 'item', 'equals': {'status': None}}],
                     'actions': ['add item.id to sequence']}]).run(memory)
        self.assertEqual(memory['sequence'], ['null'])

    def test_match_budget_and_fact_limit(self):
        from unittest.mock import patch
        rule = {'patterns': [{'collection': 'items', 'as': 'item'}], 'actions': []}
        memory = {'items': [{'id': number} for number in range(1001)]}
        with self.assertRaisesRegex(ValueError, 'Fact count limit'):
            RuleAgenda([rule]).run(memory)
        with patch('app.decisions_buddy.inference_engine.MAX_MATCH_VISITS', 1):
            with self.assertRaisesRegex(ValueError, 'matching budget'):
                RuleAgenda([rule]).run({'items': [{'id': 1}]})


if __name__ == '__main__':
    unittest.main()
