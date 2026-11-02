"""Business-rule and flow parsing on realistic and long synthetic inputs."""
import importlib
import subprocess
import sys
import unittest


PACKAGES = ('app.decisions_buddy',)


class DecisionTextBoundaryTests(unittest.TestCase):
    def test_actions_keep_quoted_delimiters_and_nested_paths(self):
        for package in PACKAGES:
            bal = importlib.import_module(package + '.bal_engine')
            with self.subTest(package=package):
                self.assertEqual(bal.parse_action_statement('set order.total to 2 + 3', {}),
                                 ('set', 'order.total', 5))
                self.assertEqual(bal.parse_action_statement('add "go to review" to notes', {}),
                                 ('add', 'notes', 'go to review'))
                self.assertEqual(bal.parse_action_statement('SET\tapproved\tTO\ttrue;', {}),
                                 ('set', 'approved', True))
                for action in ('add 2 to', 'set wrong-path to 2', 'add 2 from notes'):
                    with self.assertRaises(ValueError):
                        bal.parse_action_statement(action, {})

    def test_validation_retains_strict_action_grammar(self):
        for package in PACKAGES:
            bal = importlib.import_module(package + '.bal_engine')
            with self.subTest(package=package):
                source = 'definitions set threshold to 2; if total > threshold then add "to audit" to notes;'
                self.assertIn('then', bal.validate_bal_rule(source))
                for source in ('definitions add 2 to values; then set approved to true;',
                               'then set .answer to 2;', 'then add 2 to _private;'):
                    with self.assertRaises(ValueError):
                        bal.validate_bal_rule(source)

    def test_unary_lists_ranges_and_keyword_operands(self):
        cases = [
            ('"a,b", "c"', 'a,b', True),
            ('"a,b", "c"', 'different', False),
            ('[ -1.25 .. 2.5 )', 2.5, False),
            ('[ -1.25 .. 2.5 ]', -1.25, True),
            ('contains\t"item"', ['item'], True),
            ('some\t>= 3', [1, 3], True),
            ('all >= 3', [1, 3], False),
            ('none\t< 0', [1, 3], True),
            ('>=\t3', 3, True),
            ('[1...3]', 2, False),
        ]
        for package in PACKAGES:
            engine = importlib.import_module(package + '.decision_engine')
            for test, value, expected in cases:
                with self.subTest(package=package, test=test):
                    self.assertEqual(engine.evaluate_unary(test, value)['passed'], expected)

    def test_flow_rules_keep_conditions_actions_and_input_paths(self):
        for package in PACKAGES:
            designer = importlib.import_module(package + '.flow_designer')
            with self.subTest(package=package):
                flow = designer.generate_decision_flow('Use input customer.amount; if amount above 20 then 10% discount')
                table = next(node for node in flow['graph']['nodes'] if node['type'] == 'decisionTableNode')
                self.assertEqual(table['content']['inputs'][0]['field'], 'customer.amount')
                self.assertEqual(table['content']['rules'][0]['_description'], 'amount above 20 -> 10% discount')
                self.assertEqual(designer._implicit_rule('amount above 20 euros 10% discount'),
                                 ('amount above', '20 euros 10% discount'))
                self.assertEqual(designer._implicit_rule('VIP discount 15', discount=True),
                                 ('VIP', 'discount 15'))
                self.assertEqual(designer._trim_action('10% discount and create an output'), '10% discount')
                self.assertEqual(designer._fallback_rules('whatif amount then approve; when age then review'),
                                 [('amount', 'approve'), ('age', 'review')])

    def test_long_near_misses_finish_in_bounded_subprocess(self):
        program = '''
from app.decisions_buddy.bal_engine import _action_parts
from app.decisions_buddy.decision_engine import _split_unary_list, _unary_operand, _unary_range
from app.decisions_buddy.flow_designer import _implicit_rule, _fallback_rules, _explicit_input_name, _trim_action
text = "a " * 100000
assert _action_parts("add " + text + "!") is None
assert len(_split_unary_list("'a,b'," * 30000 + "'last'")) == 30001
assert _unary_operand("contains " + " " * 200000 + "item", "contains") == "item"
assert _unary_range("[" + "9" * 200000 + "! .. 2]") is None
assert _implicit_rule("amount " + "9" * 200000 + "!") is None
assert _fallback_rules("if " * 30000 + "unfinished") == []
assert _explicit_input_name("input " + " " * 200000 + "!") is None
assert _trim_action("approve" + " " * 200000 + "!").endswith("!")
'''
        subprocess.run([sys.executable, '-c', program], check=True, timeout=5)
