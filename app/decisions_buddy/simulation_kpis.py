"""Bounded, independent scenario simulations with explicit KPI sample counts."""
import ast
from copy import deepcopy
import json
import math

from .decision_engine import BUILTINS
from .safe_expression import evaluate as evaluate_expression

AGGREGATIONS = {'sum', 'avg', 'min', 'max', 'count', 'rate'}


def validate_simulation(cases, config):
    if not isinstance(cases, list) or not 1 <= len(cases) <= 100:
        raise ValueError('Provide 1–100 independent scenarios')
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get('input'), dict):
            raise ValueError('Each scenario requires an input object')
        if set(case) - {'input', 'name', 'expected'} or ('name' in case and not isinstance(case['name'], str)):
            raise ValueError('Scenario fields are input, optional name and expected')
    if not isinstance(config, dict) or set(config) - {'title', 'metrics', 'includeCases'}:
        raise ValueError('Report fields are title, metrics and includeCases')
    if 'title' in config and (not isinstance(config['title'], str) or len(config['title']) > 200):
        raise ValueError('Report title must be a string of at most 200 characters')
    if type(config.get('includeCases', True)) is not bool:
        raise ValueError('includeCases must be a boolean')
    metrics = config.get('metrics')
    if not isinstance(metrics, list) or not 1 <= len(metrics) <= 20:
        raise ValueError('Configure 1–20 KPI metrics')
    names = set()
    for metric in metrics:
        if not isinstance(metric, dict) or set(metric) - {'name', 'expression', 'aggregation', 'where'}:
            raise ValueError('Metric fields are name, expression, aggregation and optional where')
        name = metric.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 100 or name in names:
            raise ValueError('Metric names must be unique nonempty strings of at most 100 characters')
        names.add(name)
        if metric.get('aggregation') not in AGGREGATIONS:
            raise ValueError('Metric aggregation must be sum, avg, min, max, count or rate')
        for field in ('expression', 'where'):
            source = metric.get(field, 'true' if field == 'where' else None)
            if not isinstance(source, str) or not source.strip() or len(source) > 2048:
                raise ValueError('Metric expressions must contain 1–2048 characters')
            try:
                tree = ast.parse(source, mode='eval')
            except SyntaxError as error:
                raise ValueError(f'Metric {name}: invalid {field} expression') from error
            if sum(1 for _ in ast.walk(tree)) > 256:
                raise ValueError('Metric expression complexity limit exceeded')
    # Reject non-JSON and nonfinite inputs/configurations before execution.
    json.dumps([cases, config], allow_nan=False)


def _aggregate(values, aggregation):
    if not values:
        return None
    if aggregation == 'count':
        return sum(values)
    if aggregation == 'rate':
        return sum(values) / len(values) * 100
    if aggregation == 'sum':
        value = sum(values)
    elif aggregation == 'avg':
        value = sum(values) / len(values)
    else:
        value = (min if aggregation == 'min' else max)(values)
    if not math.isfinite(value):
        raise ValueError('Aggregated KPI is nonfinite')
    return value


def simulate(engine, graph, cases, config):
    """Errors stay visible and do not become measured zeros or passing test evidence."""
    validate_simulation(cases, config)
    metric_samples = [[] for _ in config['metrics']]
    metric_errors = [[] for _ in config['metrics']]
    metric_indexes = [[] for _ in config['metrics']]
    metric_excluded = [0 for _ in config['metrics']]
    results = []
    successful = 0
    for index, case in enumerate(cases):
        name = case.get('name') or f'Scenario {index + 1}'
        try:
            actual = engine.evaluate(graph, deepcopy(case['input']))['result']
        except (ValueError, TypeError, KeyError, ArithmeticError) as error:
            results.append({'name': name, 'status': 'error', 'error': 'Decision evaluation failed'})
            continue
        successful += 1
        results.append({'name': name, 'status': 'success', 'result': actual})
        context = {'input': deepcopy(case['input']), 'result': actual}
        for metric_index, metric in enumerate(config['metrics']):
            try:
                include = evaluate_expression(metric.get('where', 'true'), context, BUILTINS)
                if type(include) is not bool:
                    raise ValueError('KPI where expression must return a boolean')
                if not include:
                    metric_excluded[metric_index] += 1
                    continue
                value = evaluate_expression(metric['expression'], context, BUILTINS)
                if metric['aggregation'] in {'count', 'rate'}:
                    if type(value) is not bool:
                        raise ValueError('Count/rate expressions must return a boolean')
                elif type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError('Numeric KPI expressions must return a finite number')
                metric_samples[metric_index].append(value)
                metric_indexes[metric_index].append(index)
            except (ValueError, TypeError, KeyError, ArithmeticError, SyntaxError):
                metric_errors[metric_index].append(name)
    metrics = []
    for index, metric in enumerate(config['metrics']):
        values = metric_samples[index]
        try:
            value = _aggregate(values, metric['aggregation'])
            aggregation_error = None
        except (ValueError, OverflowError):
            value = None
            aggregation_error = 'Aggregation exceeded numeric limits'
        errors = metric_errors[index]
        metrics.append({
            'name': metric['name'], 'aggregation': metric['aggregation'], 'value': value,
            'unit': 'percent' if metric['aggregation'] == 'rate' else 'value',
            'sampleCount': len(values), 'sampleIndexes': metric_indexes[index],
            'excludedCount': metric_excluded[index],
            'errorCount': len(errors), 'errorScenarios': errors,
            'status': 'error' if aggregation_error else 'partial' if errors or successful != len(cases) else 'complete',
            **({'error': aggregation_error} if aggregation_error else {}),
        })
    report = {
        'title': config.get('title', 'Scenario KPI simulation'),
        'summary': {'totalScenarios': len(cases), 'successfulScenarios': successful,
                    'failedScenarios': len(cases) - successful},
        'metrics': metrics,
        'configuration': deepcopy(config),
    }
    if config.get('includeCases', True):
        report['scenarios'] = results
    return report


def compare_reports(current, baseline):
    """Absolute KPI differences; percentage rates are compared in percentage points."""
    baseline_metrics = {metric['name']: metric for metric in baseline['metrics']}
    comparison = []
    for metric in current['metrics']:
        previous = baseline_metrics[metric['name']]
        current_value, baseline_value = metric['value'], previous['value']
        delta = current_value - baseline_value if current_value is not None and baseline_value is not None else None
        comparison.append({'name': metric['name'], 'current': current_value, 'baseline': baseline_value,
                           'delta': delta, 'unit': 'percentage points' if metric['aggregation'] == 'rate' else 'value',
                           'comparable': metric['status'] == previous['status'] == 'complete'
                                         and metric['sampleIndexes'] == previous['sampleIndexes']
                                         and current_value is not None and baseline_value is not None})
    return comparison
