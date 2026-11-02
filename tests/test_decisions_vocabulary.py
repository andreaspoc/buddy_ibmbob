"""Synthetic controlled-vocabulary, type and publication-validation tests."""
from copy import deepcopy
import unittest
import subprocess
import sys

from app.decisions_buddy.bal_engine import evaluate_bal_rule, verbalize_to_expression
from app.decisions_buddy.decision_engine import DecisionEngine
from app.decisions_buddy.safe_expression import validate_graph
from app.decisions_buddy.vocabulary import replace_terms, validate_vocabulary


VOCABULARY = [
    {'term': 'customer credit score', 'path': 'customer.creditScore', 'type': 'integer', 'required': True},
    {'term': 'decision approved', 'path': 'approved', 'type': 'boolean'},
]


def graph(source, vocabulary=None):
    return {'vocabulary': deepcopy(VOCABULARY if vocabulary is None else vocabulary), 'nodes': [
        {'id': 'input', 'type': 'inputNode'},
        {'id': 'rule', 'type': 'actionRuleNode', 'content': {'source': source}},
        {'id': 'out', 'type': 'outputNode', 'content': {'schema': ['approved']}},
    ], 'edges': [{'id': 'a', 'sourceId': 'input', 'targetId': 'rule'},
                 {'id': 'b', 'sourceId': 'rule', 'targetId': 'out'}]}


class VocabularyTests(unittest.TestCase):
    def test_non_ascii_case_variants_do_not_crash_or_match_ascii_terms(self):
        for text, term in [('İ', 'i'), ('ı', 'i'), ('ſ', 's'), ('K', 'k')]:
            with self.subTest(text=text):
                self.assertEqual(replace_terms(text, [{'term': term, 'path': 'value'}]), text)

    def test_overlapping_terms_and_long_near_miss_are_bounded(self):
        program = '''
from app.decisions_buddy.vocabulary import replace_terms
terms = [{'term': 'a' * n, 'path': 'field'} for n in range(1, 101)]
text = ('a' * 120 + ' ') * 130
assert replace_terms(text, terms) == text
'''
        subprocess.run([sys.executable, '-c', program], check=True, timeout=5)

    def test_case_insensitive_multiword_terms_and_typed_targets(self):
        source = 'if the Customer Credit Score is at least 700 then set decision approved to true; else set decision approved to false;'
        model = graph(source)
        result = DecisionEngine().evaluate(model, {'customer': {'creditScore': 720}})
        self.assertEqual(result['result'], {'approved': True})
        result = DecisionEngine().evaluate(model, {'customer': {'creditScore': 699}})
        self.assertEqual(result['result'], {'approved': False})
        self.assertEqual(model['vocabulary'], VOCABULARY)

    def test_longest_term_and_quoted_literal_protection(self):
        terms = [{'term': 'credit score', 'path': 'score'}, {'term': 'customer credit score', 'path': 'customer.score'}]
        self.assertEqual(verbalize_to_expression('customer credit score > credit score', terms), 'customer.score > score')
        self.assertEqual(verbalize_to_expression('note == "customer credit score is great"', terms), 'note == "customer credit score is great"')
        self.assertEqual(verbalize_to_expression('customer.score > 2', terms), 'customer.score > 2')

    def test_required_input_and_boolean_integer_distinction(self):
        model = graph('then set decision approved to true;')
        for value in ({}, {'customer': {}}, {'customer': {'creditScore': True}}, {'customer': {'creditScore': '720'}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                DecisionEngine().evaluate(model, value)

    def test_type_mismatch_does_not_commit_actions(self):
        context = {'customer': {'creditScore': 700}}
        before = deepcopy(context)
        with self.assertRaisesRegex(ValueError, 'requires type boolean'):
            evaluate_bal_rule('then set customer credit score to 710; set decision approved to 1;', context, VOCABULARY)
        self.assertEqual(context, before)

    def test_reject_invalid_vocabulary_and_conflicting_path_types(self):
        malformed = [
            [{'term': 'private', 'path': '_secret'}],
            [{'term': 'if approved', 'path': 'approved'}],
            [{'term': 'score', 'path': 'score', 'type': []}],
            [{'term': 'Score', 'path': 'a'}, {'term': 'score', 'path': 'b'}],
            [{'term': 'score', 'path': 'a', 'type': 'number'}, {'term': 'credit score', 'path': 'a', 'type': 'string'}],
            [{'term': 'score', 'path': 'a', 'required': 'yes'}],
        ]
        for entries in malformed:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                validate_vocabulary(entries)

    def test_graph_validation_rejects_invalid_business_rules_before_execution(self):
        for source in ('if true then', 'then set approved to open("secret");', 'then set approved to (1).__class__;',
                       'then set approved to [x for x in values];', 'then frobnicate approved;'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                validate_graph(graph(source))

    def test_node_vocabulary_override_and_agenda_compilation(self):
        model = graph('then set final verdict to true;', [])
        model['nodes'][1]['content']['vocabulary'] = [{'term': 'final verdict', 'path': 'approved', 'type': 'boolean'}]
        self.assertEqual(DecisionEngine().evaluate(model, {})['result'], {'approved': True})
        model['nodes'][1] = {'id': 'rule', 'type': 'inferenceNode', 'content': {'maxCycles': 0}}
        with self.assertRaises(ValueError):
            validate_graph(model)
