"""Synthetic declarative rule evaluation and code-execution denial tests."""
import unittest
from app.decisions_buddy.decision_engine import DecisionEngine, evaluate_expression, evaluate_unary, execute_function_node
from app.decisions_buddy.safe_expression import validate_graph


class ExecutionTests(unittest.TestCase):
    def test_declarative_fields_functions_conditions_and_booleans(self):
        context = {'cart': {'total': 100}, 'discount': 20, 'values': [1, 2, 3]}
        self.assertEqual(evaluate_expression('cart.total * (1 - discount / 100)', context), 80)
        self.assertEqual(evaluate_expression('discount > 10 ? "large" : "small"', context), 'large')
        self.assertEqual(evaluate_expression('sum(values)', context), 6)
        self.assertIs(evaluate_expression('true', context), True)
        self.assertIs(evaluate_expression('True', context), True)

    def test_imported_code_and_introspection_never_execute(self):
        for source in ('__import__("os").getcwd()', '(1).__class__', 'open("/etc/passwd").read()',
                       '[x for x in values]', '(lambda: 1)()', 'cart.get("total")', '2 ** 1000000000'):
            with self.subTest(source=source), self.assertRaises((ValueError, SyntaxError)):
                evaluate_expression(source, {'values': [], 'cart': {}})
        with self.assertRaises(ValueError):
            execute_function_node({'source': 'import os; output = dict(os.environ)'}, {})

    def test_allocations_graph_cycles_and_executable_nodes_are_bounded(self):
        for source in ('"x" * 1000000000', '1' * 2049):
            with self.assertRaises(ValueError): evaluate_expression(source, {})
        for graph in ({'nodes': [{'id': 'a', 'type': 'functionNode'}], 'edges': []},
                      {'nodes': [{'id': 'a', 'type': 'inputNode'}], 'edges': [{'id': 'loop', 'sourceId': 'a', 'targetId': 'a'}]},
                      {'nodes': [{'id': 'a', 'type': 'inputNode'}, {'id': 'a', 'type': 'outputNode'}], 'edges': []}):
            with self.assertRaises(ValueError): validate_graph(graph)

    def test_rule_table_executes_with_real_trace_and_rejects_partial_error_results(self):
        graph = {'nodes': [{'id': 'i', 'type': 'inputNode', 'content': {}},
            {'id': 't', 'type': 'decisionTableNode', 'content': {'hitPolicy': 'first',
              'inputs': [{'id': 'age', 'field': 'age'}], 'outputs': [{'id': 'result', 'field': 'eligible'}],
              'rules': [{'_id': 'adult', 'age': '>= 18', 'result': True}, {'_id': 'minor', 'age': '-', 'result': False}]}},
            {'id': 'o', 'type': 'outputNode', 'content': {}}],
            'edges': [{'id': 'it', 'sourceId': 'i', 'targetId': 't'}, {'id': 'to', 'sourceId': 't', 'targetId': 'o'}]}
        result = DecisionEngine().evaluate(graph, {'age': 21})
        self.assertTrue(result['result']['eligible'])
        self.assertEqual(result['performance']['nodesExecuted'], 3)
        graph['nodes'][1]['content']['rules'][0]['result'] = 'open("/etc/passwd")'
        with self.assertRaises(ValueError): DecisionEngine().evaluate(graph, {'age': 21})

    def test_watsonx_ai_and_ml_nodes_execute_in_decision_graph(self):
        from app.decisions_buddy.flow_designer import generate_decision_flow
        churn_flow = generate_decision_flow("software customer churn with watsonx ml")
        self.assertIn("graph", churn_flow)
        validate_graph(churn_flow["graph"])

        result = DecisionEngine().evaluate(churn_flow["graph"], churn_flow["defaultInput"])
        self.assertIn("strategy", result["result"])
        self.assertIn("mlScore", result["result"])
        self.assertIn("probability", result["result"]["mlScore"])

        fraud_flow = generate_decision_flow("fraud anomaly detection with watsonx.ai")
        validate_graph(fraud_flow["graph"])
        res_fraud = DecisionEngine().evaluate(fraud_flow["graph"], fraud_flow["defaultInput"])
        self.assertIn("verdict", res_fraud["result"])
        self.assertIn("aiRisk", res_fraud["result"])

    def test_zen_unary_placeholder_and_negation(self):
        self.assertTrue(evaluate_unary("endsWith(?, '@gorules.io')", "dev@gorules.io")['passed'])
        self.assertFalse(evaluate_unary("endsWith(?, '@gorules.io')", "dev@external.com")['passed'])
        self.assertTrue(evaluate_unary("matches(?, '^[A-Z]{3}-\\d{3}$')", "XYZ-999")['passed'])
        self.assertFalse(evaluate_unary("matches(?, '^[A-Z]{3}-\\d{3}$')", "xyz-999")['passed'])
        self.assertTrue(evaluate_unary("? >= 10 and ? <= 50", 25)['passed'])
        self.assertFalse(evaluate_unary("? >= 10 and ? <= 50", 5)['passed'])
        self.assertTrue(evaluate_unary("$ >= 100", 150)['passed'])
        self.assertTrue(evaluate_unary("not(in ['FRAUD', 'BLOCKED'])", "ACTIVE")['passed'])
        self.assertFalse(evaluate_unary("not(in ['FRAUD', 'BLOCKED'])", "FRAUD")['passed'])
        self.assertTrue(evaluate_unary("10, 20, 30", 20)['passed'])
        self.assertFalse(evaluate_unary("10, 20, 30", 40)['passed'])
        self.assertTrue(evaluate_unary("'alpha', 'beta', 'gamma'", "beta")['passed'])

    def test_zen_higher_order_and_collection_builtins(self):
        ctx = {
            'orders': [{'id': 1, 'total': 100}, {'id': 2, 'total': 250}, {'id': 3, 'total': 50}],
            'users': [{'id': 10, 'role': 'admin'}, {'id': 20, 'role': 'member'}, {'id': 30, 'role': 'admin'}]
        }
        self.assertEqual(evaluate_expression("map(orders, 'total')", ctx), [100, 250, 50])
        self.assertEqual(len(evaluate_expression("filter(users, 'role', 'admin')", ctx)), 2)
        self.assertEqual(evaluate_expression("find(users, 'id', 20)['role']", ctx), 'member')
        self.assertEqual(evaluate_expression("flatten([[1, 2], [3, 4]])", {}), [1, 2, 3, 4])
        self.assertEqual(evaluate_expression("unique([1, 2, 2, 3, 1])", {}), [1, 2, 3])
        self.assertEqual(evaluate_expression("join(['alpha', 'beta'], '-')", {}), "alpha-beta")
        self.assertEqual(evaluate_expression("split('a,b,c', ',')", {}), ['a', 'b', 'c'])
        self.assertEqual(evaluate_expression("replace('hello world', 'world', 'zen')", {}), "hello zen")
        self.assertEqual(evaluate_expression("slice([10, 20, 30, 40], 1, 3)", {}), [20, 30])

    def test_rule_order_hit_policy(self):
        graph = {
            'nodes': [
                {'id': 'inp', 'type': 'inputNode', 'content': {}},
                {'id': 'tbl', 'type': 'decisionTableNode', 'content': {
                    'hitPolicy': 'ruleOrder',
                    'inputs': [{'id': 'score', 'field': 'score'}],
                    'outputs': [{'id': 'badge', 'field': 'badge'}],
                    'rules': [
                        {'_id': 'r1', 'score': '>= 50', 'badge': 'BRONZE'},
                        {'_id': 'r2', 'score': '>= 80', 'badge': 'SILVER'},
                        {'_id': 'r3', 'score': '>= 95', 'badge': 'GOLD'}
                    ]
                }},
                {'id': 'out', 'type': 'outputNode', 'content': {}}
            ],
            'edges': [
                {'id': 'e1', 'sourceId': 'inp', 'targetId': 'tbl'},
                {'id': 'e2', 'sourceId': 'tbl', 'targetId': 'out'}
            ]
        }
        validate_graph(graph)
        result = DecisionEngine().evaluate(graph, {'score': 90})
        # Score 90 matches r1 (>= 50) and r2 (>= 80), in order
        expected_rows = [
            {'badge': 'BRONZE'},
            {'badge': 'SILVER'}
        ]
        self.assertEqual(result['result']['tbl'], expected_rows)
        self.assertEqual(result['result']['results'], expected_rows)

    def test_json_schema_validation_in_input_and_output_nodes(self):
        graph = {
            'nodes': [
                {
                    'id': 'inp',
                    'type': 'inputNode',
                    'content': {
                        'schema': {
                            'type': 'object',
                            'required': ['age'],
                            'properties': {
                                'age': {'type': 'integer', 'minimum': 18}
                            }
                        }
                    }
                },
                {
                    'id': 'tbl',
                    'type': 'decisionTableNode',
                    'content': {
                        'hitPolicy': 'first',
                        'inputs': [{'id': 'age', 'field': 'age'}],
                        'outputs': [{'id': 'approved', 'field': 'approved'}],
                        'rules': [
                            {'_id': 'r1', 'age': '>= 18', 'approved': True}
                        ]
                    }
                },
                {
                    'id': 'out',
                    'type': 'outputNode',
                    'content': {
                        'schema': {
                            'type': 'object',
                            'required': ['approved'],
                            'properties': {
                                'approved': {'type': 'boolean'}
                            }
                        }
                    }
                }
            ],
            'edges': [
                {'id': 'e1', 'sourceId': 'inp', 'targetId': 'tbl'},
                {'id': 'e2', 'sourceId': 'tbl', 'targetId': 'out'}
            ]
        }
        # Valid execution
        res = DecisionEngine().evaluate(graph, {'age': 25})
        self.assertEqual(res['result']['approved'], True)

        # Fails schema minimum
        with self.assertRaises(ValueError) as ctx:
            DecisionEngine().evaluate(graph, {'age': 16})
        self.assertIn("Input schema validation failed", str(ctx.exception))

        # Fails schema type
        with self.assertRaises(ValueError) as ctx:
            DecisionEngine().evaluate(graph, {'age': 'twenty-five'})
        self.assertIn("Input schema validation failed", str(ctx.exception))

    def test_bal_natural_language_action_rules(self):
        from app.decisions_buddy.bal_engine import evaluate_bal_rule
        rule = """
        definitions
            set discount_limit to 100;
        if
            the age of customer is at least 18
            and cart.total is greater than discount_limit
        then
            set order.discount to 0.15;
            set order.approved to true;
            add "Qualified" to order.notes;
        else
            set order.discount to 0.0;
            set order.approved to false;
        """
        ctx_pass = {"customer": {"age": 25}, "cart": {"total": 150}, "order": {}}
        res_pass = evaluate_bal_rule(rule, ctx_pass)
        self.assertTrue(res_pass["passed"])
        self.assertEqual(ctx_pass["order"]["discount"], 0.15)
        self.assertTrue(ctx_pass["order"]["approved"])
        self.assertIn("Qualified", ctx_pass["order"]["notes"])

        ctx_fail = {"customer": {"age": 16}, "cart": {"total": 150}, "order": {}}
        res_fail = evaluate_bal_rule(rule, ctx_fail)
        self.assertFalse(res_fail["passed"])
        self.assertEqual(ctx_fail["order"]["discount"], 0.0)
        self.assertFalse(ctx_fail["order"]["approved"])

    def test_forward_chaining_rule_agenda(self):
        from app.decisions_buddy.inference_engine import RuleAgenda
        rules = [
            {
                "id": "r1",
                "priority": 10,
                "condition": "customer.spending > 1000",
                "actions": ["set customer.tier to 'Gold'"]
            },
            {
                "id": "r2",
                "priority": 5,
                "condition": "customer.tier == 'Gold'",
                "actions": ["set customer.discount to 0.20"]
            }
        ]
        agenda = RuleAgenda(rules)
        wm = {"customer": {"spending": 1500, "tier": "Bronze", "discount": 0.0}}
        res = agenda.run(wm)
        # r1 fired first (priority 10), updated tier to Gold; r2 then fired because tier is now Gold!
        self.assertEqual(res["totalFired"], 2)
        self.assertEqual(res["result"]["customer"]["tier"], "Gold")
        self.assertEqual(res["result"]["customer"]["discount"], 0.20)

    def test_agenda_ids_errors_limits_and_atomicity(self):
        from app.decisions_buddy.inference_engine import RuleAgenda
        rules = [{'condition': 'true', 'actions': ['set a to 1']},
                 {'condition': 'a == 1', 'actions': ['set b to 2']}]
        context = {}
        result = RuleAgenda(rules, max_cycles=2).run(context)
        self.assertEqual(result['totalFired'], 2)
        self.assertEqual(context, {'a': 1, 'b': 2})
        for bad_rules, cycles in (([{'id': 'a'}, {'id': 'a'}], 5), ([], 0), ([], 501)):
            with self.assertRaises(ValueError):
                RuleAgenda(bad_rules, max_cycles=cycles)
        context = {'count': 0}
        with self.assertRaisesRegex(ValueError, 'firing limit'):
            RuleAgenda([{'loopable': True, 'actions': ['set count to count + 1']}], 2).run(context)
        self.assertEqual(context, {'count': 0})
        with self.assertRaises(ValueError):
            RuleAgenda([{'condition': 'unknown > 1'}]).run(context)

    def test_decision_graph_with_fork_join_and_action_rule(self):
        graph = {
            'nodes': [
                {'id': 'inp', 'type': 'inputNode', 'content': {}},
                {'id': 'fork1', 'type': 'forkNode', 'content': {}},
                {'id': 'action1', 'type': 'actionRuleNode', 'content': {
                    'source': 'if cart.total >= 100 then set discount to 0.10;'
                }},
                {'id': 'join1', 'type': 'joinNode', 'content': {}},
                {'id': 'out', 'type': 'outputNode', 'content': {}}
            ],
            'edges': [
                {'id': 'e1', 'sourceId': 'inp', 'targetId': 'fork1'},
                {'id': 'e2', 'sourceId': 'fork1', 'targetId': 'action1'},
                {'id': 'e3', 'sourceId': 'action1', 'targetId': 'join1'},
                {'id': 'e4', 'sourceId': 'join1', 'targetId': 'out'}
            ]
        }
        validate_graph(graph)
        res = DecisionEngine().evaluate(graph, {'cart': {'total': 120}})
        self.assertEqual(res['result']['discount'], 0.10)

    def test_dvs_scenario_testing_suite(self):
        from app.decisions_buddy.dvs_engine import evaluate_dvs_suite
        graph = {
            'nodes': [
                {'id': 'inp', 'type': 'inputNode', 'content': {}},
                {'id': 'tbl', 'type': 'decisionTableNode', 'content': {
                    'hitPolicy': 'first',
                    'inputs': [{'id': 'age', 'field': 'age'}],
                    'outputs': [{'id': 'approved', 'field': 'approved'}],
                    'rules': [
                        {'_id': 'r1', 'age': '>= 18', 'approved': True},
                        {'_id': 'r2', 'age': '< 18', 'approved': False}
                    ]
                }},
                {'id': 'out', 'type': 'outputNode', 'content': {}}
            ],
            'edges': [
                {'id': 'e1', 'sourceId': 'inp', 'targetId': 'tbl'},
                {'id': 'e2', 'sourceId': 'tbl', 'targetId': 'out'}
            ]
        }
        scenarios = [
            {'id': 'sc1', 'description': 'Adult check', 'input': {'age': 20}, 'expected': {'approved': True}},
            {'id': 'sc2', 'description': 'Minor check', 'input': {'age': 15}, 'expected': {'approved': False}},
            {'id': 'sc3', 'description': 'Intentional failure', 'input': {'age': 25}, 'expected': {'approved': False}}
        ]
        scorecard = evaluate_dvs_suite(graph, scenarios)
        self.assertEqual(scorecard['summary']['totalScenarios'], 3)
        self.assertEqual(scorecard['summary']['passedScenarios'], 2)
        self.assertEqual(scorecard['summary']['failedScenarios'], 1)
        self.assertAlmostEqual(scorecard['summary']['passRatePercentage'], 66.7, places=1)



if __name__ == '__main__': unittest.main()
