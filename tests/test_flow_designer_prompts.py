"""Rules written in a prompt must survive into the generated flow and execute correctly."""
import unittest

from app.decisions_buddy.decision_engine import DecisionEngine
from app.decisions_buddy.flow_designer import generate_decision_flow
from app.decisions_buddy.safe_expression import validate_graph
from app.decisions_buddy.watsonx_inference import _simulate_ml_scoring


def tables(flow):
    return [node for node in flow['graph']['nodes'] if node['type'] == 'decisionTableNode']


def cells(table, column):
    return [rule.get(column) for rule in table['content']['rules']]


class ConditionParsingTests(unittest.TestCase):
    def test_comparison_signs_stay_in_the_condition(self):
        for prompt, expected in (('if age >= 18 then approve', '>= 18'), ('if age > 18 then approve', '> 18'),
                                 ('if age <= 18 then approve', '<= 18')):
            with self.subTest(prompt=prompt):
                flow = generate_decision_flow(prompt)
                self.assertEqual(cells(tables(flow)[0], 'in_1')[0], expected)

    def test_comparison_prompt_decides_correctly(self):
        flow = generate_decision_flow('if age >= 18 then approve')
        validate_graph(flow['graph'])
        engine = DecisionEngine()
        field = tables(flow)[0]['content']['inputs'][0]['field']
        self.assertEqual(field, 'age')
        out = tables(flow)[0]['content']['outputs'][0]['field']
        self.assertEqual(engine.evaluate(flow['graph'], {'age': 18})['result'][out], 'APPROVED')
        self.assertEqual(engine.evaluate(flow['graph'], {'age': 17})['result'][out], 'STANDARD')

    def test_arrows_and_colons_still_separate(self):
        for prompt in ('if amount >= 100 -> 20% discount', 'if amount >= 100 => 20% discount', 'if amount >= 100: 20% discount'):
            with self.subTest(prompt=prompt):
                table = tables(generate_decision_flow(prompt))[0]
                self.assertEqual((cells(table, 'in_1')[0], cells(table, 'out_1')[0]), ('>= 100', 20))

    def test_hyphenated_words_do_not_split_a_rule(self):
        table = tables(generate_decision_flow('if non-member amount >= 50 then 5% discount'))[0]
        self.assertEqual((cells(table, 'in_1')[0], cells(table, 'out_1')[0]), ('>= 50', 5))

    def test_decimals_are_kept_and_sentences_still_end(self):
        table = tables(generate_decision_flow('Set the interest rate. If score >= 700.5 then rate 4.5. Ignore this: 9'))[0]
        self.assertEqual((cells(table, 'in_1')[0], cells(table, 'out_1')[0]), ('>= 700.5', 4.5))

    def test_free_text_actions_are_quoted_and_execute(self):
        flow = generate_decision_flow('if value >= 10 then send welcome letter')
        out = tables(flow)[0]['content']['outputs'][0]['field']
        self.assertEqual(DecisionEngine().evaluate(flow['graph'], {'value': 10})['result'][out], 'send welcome letter')


class RequestedRulesTests(unittest.TestCase):
    def test_routing_branches_apply_requested_rules(self):
        flow = generate_decision_flow('Route with a switch router: if amount >= 300 then 35% discount, if amount >= 90 then 12% discount')
        by_id = {table['id']: table for table in tables(flow)}
        self.assertEqual(set(by_id), {'node_table_priority', 'node_table_standard'})
        for table in by_id.values():
            self.assertEqual(cells(table, 'in_amt'), ['>= 300', '>= 90', '-'])
            self.assertEqual(cells(table, 'out_val'), [35, 12, 0])
        result = DecisionEngine().evaluate(flow['graph'], {'amount': 95})['result']
        self.assertEqual(result['discountPercent'], 12)

    def test_multistage_applies_requested_rules(self):
        flow = generate_decision_flow('Build a multi-stage screening and offer flow: if amount >= 300 then 35% discount, if amount >= 90 then 12% discount')
        first, second = tables(flow)
        self.assertEqual(cells(first, 'in_val'), ['>= 300', '>= 90', '-'])
        self.assertEqual(cells(second, 'out_offer'), [35, 12, 0])
        engine = DecisionEngine()
        self.assertEqual(engine.evaluate(flow['graph'], {'amount': 95})['result']['discountPercent'], 12)
        declined = engine.evaluate(flow['graph'], {'amount': 10})['result']
        self.assertEqual((declined['isEligible'], declined['discountPercent'], declined['finalVerdict']), ('NO', 0, 'DECLINED'))

    def test_prompts_without_rules_keep_their_built_in_tables(self):
        flow = generate_decision_flow('Build a two-step multi-stage screening and offer matrix flow for applicant loan')
        self.assertEqual(tables(flow)[0]['content']['rules'][0]['_id'], 's1_r1')
        self.assertIn('Passes', tables(flow)[0]['content']['rules'][0]['_description'])


class SimulatedScoringTests(unittest.TestCase):
    def test_booleans_are_scored_as_booleans(self):
        _, approved = _simulate_ml_scoring('d', {'flag': True}, 'classification')
        _, rejected = _simulate_ml_scoring('d', {'flag': False}, 'classification')
        self.assertEqual((approved, rejected), (0.65, 0.4))

    def test_numbers_keep_their_weighting(self):
        self.assertEqual(_simulate_ml_scoring('d', {'value': 5}, 'classification')[1], 0.7)


if __name__ == '__main__':
    unittest.main()
