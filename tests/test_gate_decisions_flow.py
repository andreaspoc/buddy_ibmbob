"""Natural-language flow synthesis and offline watsonx behaviour; the HTTP call is always mocked."""
import json
from unittest import TestCase
from unittest.mock import patch

import httpx

from app.decisions_buddy import flow_designer as flow, watsonx_inference as wx
from app.decisions_buddy.safe_expression import validate_graph
from app.decisions_buddy.sample_decisions import SAMPLE_DECISIONS


def nodes_of(result, kind):
    return [node for node in result['graph']['nodes'] if node['type'] == kind]


def table(result):
    return nodes_of(result, 'decisionTableNode')[0]['content']


class ParserHelperTests(TestCase):
    def test_word_separator_finds_symbols_and_words(self):
        self.assertEqual(list(flow._word_separator('a: b')), [(1, 2)])
        self.assertEqual(list(flow._word_separator('x then y', then_only=True)), [(1, 7)])
        self.assertEqual(list(flow._word_separator('then y', then_only=True)), [])
        self.assertEqual(list(flow._word_separator('x thenceforth y', then_only=True)), [])

    def test_implicit_rule_splits_before_a_numeric_action(self):
        self.assertEqual(flow._implicit_rule('amount over 5 10% off'), ('amount over 5', '10% off'))
        self.assertEqual(flow._implicit_rule('vip 20 mbps'), ('vip', '20 mbps'))
        self.assertEqual(flow._implicit_rule('vip discount 5', discount=True), ('vip', 'discount 5'))
        self.assertIsNone(flow._implicit_rule('no action here'))

    def test_fallback_rules_handle_overlaps_and_boundaries(self):
        self.assertEqual(flow._fallback_rules('if a then b.'), [('a', 'b')])
        self.assertEqual(flow._fallback_rules('if a'), [])
        self.assertEqual(flow._fallback_rules('if a\nb then c.'), [])
        self.assertEqual(flow._fallback_rules('if a then b'), [('a', 'b')])

    def test_fallback_rule_skips_clause_consumed_by_previous_rule(self):
        self.assertEqual(flow._fallback_rules('if a then if b, c. if d then e.'), [('a', 'if b'), ('d', 'e')])

    def test_explicit_input_name_variants(self):
        for source, expected in (('input is age', 'age'), ('inputs: credit_score', 'credit_score'), ('input = cart.total', 'cart.total'),
                                 ('input should be speed', 'speed'), ('no match', None), ('input ???', None)):
            with self.subTest(source=source):
                self.assertEqual(flow._explicit_input_name(source), expected)

    def test_trim_action_removes_trailing_commentary(self):
        self.assertEqual(flow._trim_action(' give 5 and create a flow'), 'give 5')
        self.assertEqual(flow._trim_action('give 5,'), 'give 5')
        self.assertEqual(flow._trim_action('to create it'), 'to create it')


class RuleExtractionTests(TestCase):
    def test_comparison_condition_keeps_operator(self):
        rules = table(flow.generate_decision_flow('if age < 30 then approve. if age < 10 then reject.'))['rules']
        self.assertEqual([rule['in_1'] for rule in rules], ['< 30', '< 10', '-'])
        self.assertEqual([rule['out_1'] for rule in rules[:2]], ['APPROVED', 'DECLINED'])
        self.assertEqual(rules[1]['out_status'], 'INELIGIBLE')

    def test_non_numeric_condition_becomes_quoted_label(self):
        rules = table(flow.generate_decision_flow('if plan is gold then ship it'))['rules']
        self.assertEqual(rules[0]['in_1'], '"gold"')

    def test_implicit_percentage_rule_without_separator(self):
        result = flow.generate_decision_flow('when amount over 100 15% discount')
        self.assertEqual(table(result)['rules'][0]['out_1'], 15)
        self.assertEqual(table(result)['rules'][0]['out_status'], 'PROMO_APPLIED')
        self.assertEqual(result['defaultInput'], {'amount': 100})

    def test_discount_token_rule_without_percent_sign(self):
        rules = table(flow.generate_decision_flow('when gold members discount 7'))['rules']
        self.assertEqual(rules[0]['out_1'], 7)

    def test_empty_clause_is_ignored(self):
        result = flow.generate_decision_flow('if . when age < 5 then approve')
        self.assertEqual(len(table(result)['rules']), 2)

    def test_new_customer_column_is_added_to_rules_and_defaults(self):
        result = flow.generate_decision_flow('for a new customer with amount: if amount < 10 then 5% discount')
        content = table(result)
        self.assertEqual([column['field'] for column in content['inputs']], ['amount', 'customer.isNew'])
        self.assertEqual(content['rules'][0]['in_cust'], 'true')
        self.assertEqual(content['rules'][-1]['in_cust'], '-')
        self.assertEqual(result['defaultInput']['customer'], {'id': 'CUST-1001', 'isNew': True})

    def test_placeholder_input_name_is_ignored(self):
        result = flow.generate_decision_flow('input is the customer age for review')
        self.assertEqual(table(result)['inputs'][0]['field'], 'age')

    def test_output_field_follows_the_domain(self):
        for prompt, field, value in (('if tier is gold then 100 mbps speed', 'speedMbps', 100),
                                     ('if age < 3 then rate 4', 'interestRate', 4),
                                     ('if age < 3 then status approved', 'decision', 'APPROVED'),
                                     ('if age < 3 then nothing', 'result', '"nothing"')):
            with self.subTest(prompt=prompt):
                content = table(flow.generate_decision_flow(prompt))
                self.assertEqual(content['outputs'][0]['field'], field)
                self.assertEqual(content['rules'][0]['out_1'], value)

    def test_input_detection_by_domain_vocabulary(self):
        for prompt, field in (('recharge rules', 'topupAmount'), ('credit score policy', 'creditScore'),
                              ('cart price policy', 'amount'), ('age gate', 'age'), ('loyalty level', 'customer.tier'),
                              ('plain policy', 'value')):
            with self.subTest(prompt=prompt):
                self.assertEqual(table(flow.generate_decision_flow(prompt))['inputs'][0]['field'], field)


class TopologyTests(TestCase):
    def test_calculation_adds_expression_and_output_schema(self):
        result = flow.generate_decision_flow('if amount < 5 then 10% discount and calculate the final total')
        self.assertEqual(len(nodes_of(result, 'expressionNode')), 1)
        self.assertIn('finalTotal', nodes_of(result, 'outputNode')[0]['content']['schema'])
        self.assertIn('Expression Calculator', result['explanation'])

    def test_linear_flow_with_foundation_model(self):
        result = flow.generate_decision_flow('use watsonx.ai to review: if age < 3 then approve')
        node = nodes_of(result, 'watsonxAiNode')[0]
        self.assertEqual(node['content']['modelId'], 'ibm/granite-13b-instruct-v2')
        self.assertTrue(all(rule['in_wx'] == '-' for rule in table(result)['rules']))

    def test_linear_flow_with_predictive_model(self):
        result = flow.generate_decision_flow('use a predictive ml model: if age < 3 then approve')
        node = nodes_of(result, 'watsonxMlNode')[0]
        self.assertEqual(node['content']['inputMapping'], {'age': 'age'})
        self.assertEqual(table(result)['inputs'][-1]['field'], 'mlScore.prediction')

    def test_routing_flow_inserts_watsonx_before_switch(self):
        for prompt, kind in (('route by predictive ml model: if age < 3 then approve', 'watsonxMlNode'),
                             ('route with watsonx.ai: if age < 3 then approve', 'watsonxAiNode')):
            with self.subTest(prompt=prompt):
                result = flow.generate_decision_flow(prompt)
                self.assertEqual(len(nodes_of(result, kind)), 1)
                switch = nodes_of(result, 'switchNode')[0]
                self.assertEqual(switch['position']['x'], 640)
                self.assertIn('e_node_watsonx_node_switch', [edge['id'] for edge in result['graph']['edges']])

    def test_routing_condition_uses_customer_tier_for_customers(self):
        result = flow.generate_decision_flow('route each customer by age: if age < 3 then approve')
        self.assertEqual(nodes_of(result, 'switchNode')[0]['content']['statements'][0]['condition'], "customer.tier == 'VIP'")

    def test_multistage_flow_has_two_tables(self):
        result = flow.generate_decision_flow('a two-step screening pipeline: if age < 3 then approve')
        self.assertEqual(len(nodes_of(result, 'decisionTableNode')), 2)

    def test_presets_are_selected_only_without_explicit_rules(self):
        for prompt, marker in (('customer retention', 'watsonx'), ('fraud triage', 'fraud'), ('loan underwriting', 'loan')):
            with self.subTest(prompt=prompt):
                result = flow.generate_decision_flow(prompt)
                self.assertIn(marker, json.dumps(result).lower())
                self.assertTrue(validate_graph(result['graph']))
        self.assertTrue(nodes_of(flow.generate_decision_flow('route loyalty tier'), 'switchNode'))
        self.assertTrue(nodes_of(flow.generate_decision_flow('calculate cart tax'), 'expressionNode'))

    def test_generated_graphs_pass_validation(self):
        for prompt in ('if age < 3 then approve', 'route by age: if age < 3 then approve', 'two-step: if age < 3 then approve',
                       'watsonx: if age < 3 then approve', 'calculate: if amount < 3 then 5% discount'):
            with self.subTest(prompt=prompt):
                graph = flow.generate_decision_flow(prompt)['graph']
                self.assertEqual(validate_graph(graph), graph)


class WatsonxAiTests(TestCase):
    CONTENT = {'endpoint': 'https://wx.synthetic.invalid', 'apiKey': 'synthetic-key', 'projectId': 'p', 'promptTemplate': 'Hello {name} {none}'}

    def setUp(self):
        self.post = self.enterContext(patch.object(wx, '_post_watsonx'))
        self.enterContext(patch.object(wx, '_validate_watsonx_url'))
        self.enterContext(patch.object(wx, '_get_provider_config', return_value={}))
        self.enterContext(patch.dict('os.environ', {'WATSONX_URL': '', 'WATSONX_APIKEY': ''}))

    def test_live_call_payload_and_json_extraction(self):
        self.post.return_value = {'results': [{'generated_text': ' {"decision": "HOLD", "x": 1} '}]}
        output = wx.execute_watsonx_ai({**self.CONTENT, 'spaceId': 's', 'outputField': 'ai'}, {'name': 'Bo'})['ai']
        endpoint, payload, auth = self.post.call_args.args
        self.assertTrue(endpoint.endswith('/ml/v1/text/generation?version=2023-05-29'))
        self.assertEqual((payload['project_id'], payload['space_id'], payload['input']), ('p', 's', 'Hello Bo '))
        self.assertEqual(auth, 'Bearer synthetic-key')
        self.assertEqual((output['recommendation'], output['x']), ('HOLD', 1))
        self.assertNotIn('score', output)

    def test_prefixed_credential_and_full_endpoint_are_kept(self):
        self.post.return_value = {'results': [{'generated_text': 'plain'}]}
        url = 'https://wx.synthetic.invalid/ml/v1/text/generation?version=x'
        output = wx.execute_watsonx_ai({**self.CONTENT, 'endpoint': url, 'apiKey': 'ZenApiKey k', 'projectId': '', 'space_id': 's'}, {})
        self.assertEqual(self.post.call_args.args[0], url)
        self.assertEqual(self.post.call_args.args[2], 'ZenApiKey k')
        self.assertEqual(output['aiResult']['recommendation'], 'plain')

    def test_invalid_json_shapes_are_left_as_text(self):
        self.post.return_value = {'results': [{'generated_text': '{not json}'}]}
        self.assertEqual(wx.execute_watsonx_ai(self.CONTENT, {})['aiResult']['output'], '{not json}')

    def test_empty_results_fall_back_to_offline_synthesis(self):
        self.post.return_value = {'results': []}
        result = wx.execute_watsonx_ai({**self.CONTENT, 'promptTemplate': 'general intent'}, {})['aiResult']
        self.assertEqual(result['classification'], 'ELIGIBLE')
        self.assertEqual(result['score'], 0.92)

    def test_simulated_response_bands(self):
        cases = (('churn', {'customer': {'openTickets': 4}}, 'LOYALTY_DISCOUNT_20'),
                 ('churn', {'customer': {'accountAgeMonths': 60}}, 'STANDARD_PROMO'),
                 ('fraud', {'transaction': {'amount': 9000, 'isForeignCountry': True}}, 'FLAG_REVIEW'),
                 ('risk', {}, 'APPROVE'),
                 ('credit', {'applicant': {'creditScore': 800}}, 'PRIME'),
                 ('loan', {'applicant': {'creditScore': 680}}, 'NEAR_PRIME'),
                 ('underwriting', {'applicant': {'creditScore': 400}}, 'SUBPRIME'))
        for prompt, context, marker in cases:
            with self.subTest(prompt=prompt, marker=marker):
                text, score = wx._simulate_ai_response('m', prompt, context)
                self.assertIn(marker, text)
                self.assertTrue(0 <= score <= 1)


class WatsonxMlTests(TestCase):
    CONTENT = {'endpoint': 'https://wx.synthetic.invalid', 'apiKey': 'synthetic-key', 'deploymentId': 'dep', 'spaceId': 's',
               'inputMapping': {'age': 'customer.age', 'blank': ''}}

    def setUp(self):
        self.post = self.enterContext(patch.object(wx, '_post_watsonx'))
        self.enterContext(patch.object(wx, '_validate_watsonx_url'))
        self.enterContext(patch.object(wx, '_get_provider_config', return_value={}))
        self.enterContext(patch.dict('os.environ', {'WATSONX_URL': '', 'WATSONX_APIKEY': '', 'WATSONX_SPACE_ID': ''}))

    def test_live_prediction_with_probability(self):
        self.post.return_value = {'predictions': [{'values': [['YES']], 'probabilities': [[0.8]]}]}
        output = wx.execute_watsonx_ml(self.CONTENT, {'customer': {'age': 40}})['mlResult']
        self.assertEqual((output['prediction'], output['probability']), ('YES', 0.8))
        self.assertEqual(output['features'], {'age': 40, 'blank': None})
        payload = self.post.call_args.args[1]
        self.assertEqual(payload['space_id'], 's')
        self.assertEqual(payload['input_data'][0]['values'], [[40, None]])

    def test_scalar_prediction_and_probability(self):
        self.post.return_value = {'predictions': [{'values': ['NO'], 'probabilities': [0.3]}]}
        output = wx.execute_watsonx_ml({**self.CONTENT, 'spaceId': ''}, {})['mlResult']
        self.assertEqual((output['prediction'], output['probability']), ('NO', 0.3))
        self.assertNotIn('space_id', self.post.call_args.args[1])

    def test_prediction_without_probability(self):
        self.post.return_value = {'predictions': [{'values': [['YES']]}]}
        self.assertIsNone(wx.execute_watsonx_ml(self.CONTENT, {})['mlResult']['probability'])

    def test_list_feature_mapping(self):
        self.post.return_value = {'predictions': []}
        mapping = [{'field': 'a', 'source': 'x'}, {'name': 'b', 'path': 'y'}, {'name': 'c'}]
        features = wx.execute_watsonx_ml({'inputMapping': mapping}, {'x': 1, 'y': 2})['mlResult']['features']
        self.assertEqual(features, {'a': 1, 'b': 2, 'c': None})

    def test_unsupported_mapping_type_yields_no_features(self):
        self.assertEqual(wx.execute_watsonx_ml({'inputMapping': 'nope'}, {})['mlResult']['features'], {})

    def test_failed_call_falls_back_to_offline_scoring(self):
        self.post.side_effect = httpx.ConnectError('offline')
        output = wx.execute_watsonx_ml({**self.CONTENT, 'deploymentId': 'churn-model'}, {})['mlResult']
        self.assertIn(output['prediction'], {'CHURN_RISK', 'RETAINED'})

    def test_simulated_labels(self):
        cases = (('churn', {'a': 9}, 'classification', 'CHURN_RISK'), ('churn', {'a': -30.0}, 'classification', 'RETAINED'),
                 ('fraud', {'a': 9}, 'classification', 'FRAUDULENT'), ('fraud', {'a': 0}, 'classification', 'LEGITIMATE'),
                 ('credit', {'a': 9}, 'classification', 'LOW_RISK'), ('risk', {'a': 'text'}, 'classification', 'LOW_RISK'),
                 ('other', {'a': 9}, 'classification', 'POSITIVE'))
        for deployment, features, kind, label in cases:
            with self.subTest(deployment=deployment, features=features):
                self.assertEqual(wx._simulate_ml_scoring(deployment, features, kind)[0], label)

    def test_regression_returns_percentage(self):
        value, probability = wx._simulate_ml_scoring('d', {'a': 1}, 'regression')
        self.assertEqual(value, round(probability * 100, 2))


class WatsonxTransportTests(TestCase):
    def test_http_endpoint_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'HTTPS'):
            wx._validate_watsonx_url('http://wx.synthetic.invalid')

    def test_post_returns_json_and_raises_for_status(self):
        for status, expectation in ((200, {'ok': True}), (500, None)):
            with self.subTest(status=status):
                transport = httpx.MockTransport(lambda request: httpx.Response(status, json={'ok': True}))
                with patch.object(wx, '_validate_watsonx_url'), patch.object(wx, 'sync_transport', return_value=transport):
                    if expectation:
                        self.assertEqual(wx._post_watsonx('https://wx.synthetic.invalid/x', {}, 'Bearer k'), expectation)
                    else:
                        with self.assertRaises(httpx.HTTPStatusError):
                            wx._post_watsonx('https://wx.synthetic.invalid/x', {}, 'Bearer k')

    def test_provider_config_failure_is_empty(self):
        with patch('app.decisions_buddy.cp4d_settings.load_connection', side_effect=RuntimeError('no db')):
            self.assertEqual(wx._get_provider_config('wxdi'), {})


class SampleDecisionTests(TestCase):
    def test_every_sample_graph_validates_and_declares_identity(self):
        self.assertTrue(SAMPLE_DECISIONS)
        for key, sample in SAMPLE_DECISIONS.items():
            with self.subTest(sample=key):
                self.assertTrue(sample['name'])
                self.assertTrue(sample['graph']['nodes'])
                self.assertEqual({'inputNode', 'outputNode'} - {node['type'] for node in sample['graph']['nodes']}, set())
