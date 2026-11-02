"""Synthetic impact reports: types, errors, independent cases and baseline changes."""
from copy import deepcopy
import unittest
from app.decisions_buddy.decision_engine import DecisionEngine
from app.decisions_buddy.simulation_kpis import simulate, compare_reports, validate_simulation


def graph(threshold=18):
    return {'nodes': [
        {'id': 'i', 'type': 'inputNode'},
        {'id': 'e', 'type': 'expressionNode', 'content': {'expressions': [
            {'key': 'approved', 'value': f'age >= {threshold}'},
            {'key': 'fee', 'value': 'amount * 0.1'}]}},
        {'id': 'o', 'type': 'outputNode', 'content': {'schema': ['approved', 'fee']}}
    ], 'edges': [{'id': 'ie', 'sourceId': 'i', 'targetId': 'e'},
                 {'id': 'eo', 'sourceId': 'e', 'targetId': 'o'}]}


def metric(name, expression, aggregation, **kwargs):
    return dict(name=name, expression=expression, aggregation=aggregation, **kwargs)


class SimulationKpiTests(unittest.TestCase):
    def setUp(self):
        self.cases = [
            {'name': 'Adult', 'input': {'age': 20, 'amount': 100}},
            {'name': 'Minor', 'input': {'age': 15, 'amount': 200}},
        ]
        self.config = {'title': 'Synthetic impact report', 'metrics': [
            metric('Approvals', 'result.approved', 'count'),
            metric('Approval rate', 'result.approved', 'rate'),
            metric('Total fees', 'result.fee', 'sum'),
            metric('Average fee', 'result.fee', 'avg'),
            metric('Minimum fee', 'result.fee', 'min'),
            metric('Maximum fee', 'result.fee', 'max'),
            metric('Adult fees', 'result.fee', 'sum', where='input.age >= 18'),
        ]}

    def test_all_aggregations_filters_and_input_isolation(self):
        before = deepcopy(self.cases)
        report = simulate(DecisionEngine(), graph(), self.cases, self.config)
        self.assertEqual([item['value'] for item in report['metrics']], [1, 50, 30, 15, 10, 20, 10])
        self.assertEqual(report['summary'], {'totalScenarios': 2, 'successfulScenarios': 2, 'failedScenarios': 0})
        self.assertEqual(report['metrics'][-1]['excludedCount'], 1)
        self.assertEqual(self.cases, before)
        self.assertNotIn('approved', self.cases[0]['input'])

    def test_empty_samples_errors_and_wrong_types_are_visible(self):
        config = {'includeCases': False, 'metrics': [
            metric('Empty', 'result.fee', 'sum', where='false'),
            metric('Missing', 'result.missing', 'avg'),
            metric('Wrong count', 'result.fee', 'count'),
            metric('Wrong where', 'result.fee', 'avg', where='1'),
            metric('Unsafe', '__import__("os").getcwd()', 'avg'),
        ]}
        report = simulate(DecisionEngine(), graph(), self.cases, config)
        self.assertNotIn('scenarios', report)
        for index, item in enumerate(report['metrics']):
            self.assertIsNone(item['value'])
            self.assertEqual(item['sampleCount'], 0)
            self.assertEqual(item['errorCount'], 0 if index == 0 else 2)
        self.assertEqual(report['metrics'][0]['excludedCount'], 2)
        self.assertEqual(report['metrics'][1]['status'], 'partial')

    def test_failed_decisions_do_not_become_zero_samples(self):
        cases = self.cases + [{'name': 'Bad input', 'input': {'age': 'invalid', 'amount': 10}}]
        report = simulate(DecisionEngine(), graph(), cases, self.config)
        self.assertEqual(report['summary']['failedScenarios'], 1)
        self.assertEqual(report['metrics'][1]['value'], 50)
        self.assertEqual(report['metrics'][1]['sampleCount'], 2)
        self.assertEqual(report['metrics'][1]['status'], 'partial')
        self.assertEqual(report['scenarios'][-1]['status'], 'error')

    def test_baseline_deltas_and_scenario_set_comparability(self):
        current = simulate(DecisionEngine(), graph(10), self.cases, self.config)
        baseline = simulate(DecisionEngine(), graph(18), self.cases, self.config)
        comparison = compare_reports(current, baseline)
        self.assertEqual(comparison[1]['delta'], 50)
        self.assertEqual(comparison[1]['unit'], 'percentage points')
        self.assertTrue(comparison[1]['comparable'])
        config = {'metrics': [metric('Conditional', 'result.fee', 'sum', where='result.approved')]}
        first = simulate(DecisionEngine(), graph(18), self.cases, config)
        second = deepcopy(first)
        second['metrics'][0]['sampleIndexes'] = [1]
        self.assertFalse(compare_reports(first, second)[0]['comparable'])

    def test_invalid_configuration_and_case_limits(self):
        invalid_configs = [
            {'metrics': []}, {'metrics': [metric('A', 'true', 'unknown')]},
            {'metrics': [metric('A', '(', 'sum')]},
            {'metrics': [metric('A', 'true', 'count')] * 2},
            {'metrics': [metric('A', 'true', 'count')], 'includeCases': 'false'},
        ]
        for config in invalid_configs:
            with self.subTest(config=config), self.assertRaises(ValueError):
                validate_simulation(self.cases, config)
        for cases in ([], self.cases * 51, [{'input': []}], [{'input': {}, 'unexpected': True}]):
            with self.subTest(cases=cases), self.assertRaises(ValueError):
                validate_simulation(cases, self.config)


if __name__ == '__main__':
    unittest.main()
