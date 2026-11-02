"""Bounded forward chaining with fact patterns and deterministic conflict resolution.

This is a DecisionsBuddy agenda, not an implementation of IBM RetePlus.
"""
from copy import deepcopy
import json
import re
from typing import Any, Dict, List

from .safe_expression import evaluate as safe_evaluate, bounded
from .decision_engine import BUILTINS, get_by_path, set_by_path
from .bal_engine import verbalize_to_expression, parse_action_statement, split_statements

MAX_RULES = 500
MAX_FACTS = 1000
MAX_MATCH_VISITS = 50000
MAX_ACTIVATIONS = 2000
_PATH = re.compile(r'^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$')
_ALIAS = re.compile(r'^[A-Za-z][A-Za-z0-9_]*$')


def _path(value):
    if not isinstance(value, str) or not _PATH.fullmatch(value):
        raise ValueError('Fact paths must contain public document field names')
    return value


def _field_key(fact, path):
    value = fact
    for part in path.split('.'):
        if not isinstance(value, dict) or part not in value:
            return (False, '')
        value = value[part]
    return (True, _key(value))


def _key(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(',', ':'))


class RuleAgenda:
    """A deterministic agenda with atomic working-memory commits.

    Patterned rules fire once per matching tuple of fact identities unless loopable.
    Unpatterned rules retain the existing once-per-rule behavior.
    """
    def __init__(self, rules: List[Dict[str, Any]], max_cycles: int = 500,
                 vocabulary=None, conflict_resolution='priority'):
        if not isinstance(rules, list) or len(rules) > MAX_RULES:
            raise ValueError('Provide at most 500 agenda rules')
        if type(max_cycles) is not int or not 1 <= max_cycles <= 500:
            raise ValueError('maxCycles must be an integer between 1 and 500')
        if conflict_resolution not in ('priority', 'specificity', 'recency'):
            raise ValueError('conflictResolution must be priority, specificity, or recency')
        from .vocabulary import validate_vocabulary
        self.vocabulary = validate_vocabulary(vocabulary)
        self.conflict_resolution = conflict_resolution
        self.max_cycles = max_cycles
        normalized = []
        seen = set()
        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                raise ValueError('Each agenda rule must be an object')
            rule = deepcopy(rule)
            identity = rule.get('id') or rule.get('_id') or f'rule_{index + 1}'
            if not isinstance(identity, str) or identity in seen:
                raise ValueError('Agenda rule IDs must be unique strings')
            seen.add(identity)
            rule['id'] = identity
            rule['_order'] = index
            if type(rule.get('priority', 0)) is not int:
                raise ValueError('Agenda priority must be an integer')
            if not isinstance(rule.get('condition', 'true'), str):
                raise ValueError('Agenda condition must be an expression string')
            if type(rule.get('loopable', False)) is not bool:
                raise ValueError('Agenda loopable must be a boolean')
            patterns = rule.get('patterns', [])
            if not isinstance(patterns, list) or len(patterns) > 4:
                raise ValueError('Provide at most four fact patterns per rule')
            aliases = set()
            for pattern in patterns:
                if not isinstance(pattern, dict) or set(pattern) - {'collection', 'as', 'where', 'equals'}:
                    raise ValueError('Fact patterns support collection, as, equals, and where')
                _path(pattern.get('collection'))
                alias = pattern.get('as')
                if not isinstance(alias, str) or not _ALIAS.fullmatch(alias) or alias in aliases or alias in BUILTINS:
                    raise ValueError('Fact aliases must be unique public identifiers')
                aliases.add(alias)
                if not isinstance(pattern.get('where', 'true'), str):
                    raise ValueError('Fact pattern where must be an expression')
                equals = pattern.get('equals', {})
                if not isinstance(equals, dict) or len(equals) > 20:
                    raise ValueError('Fact equals must be an object with at most 20 fields')
                for field, value in equals.items():
                    _path(field)
                    bounded(value)
            actions = rule.get('actions', [])
            if isinstance(actions, str):
                actions = split_statements(actions)
            if not isinstance(actions, list) or len(actions) > 100:
                raise ValueError('Provide at most 100 action statements per rule')
            for action in actions:
                if isinstance(action, str):
                    continue
                if not isinstance(action, dict):
                    raise ValueError('Agenda actions must be strings or structured fact actions')
                op = action.get('op')
                fields = {'insert': {'op', 'collection', 'value'},
                          'update': {'op', 'fact', 'values'}, 'retract': {'op', 'fact'}}
                if not isinstance(op, str) or op not in fields or set(action) != fields[op]:
                    raise ValueError('Invalid structured fact action')
                if op == 'insert':
                    _path(action['collection'])
                    if not isinstance(action['value'], str):
                        raise ValueError('Inserted fact value must be an expression')
                else:
                    if not isinstance(action['fact'], str) or action['fact'] not in aliases:
                        raise ValueError('Fact actions must reference a declared pattern alias')
                    if op == 'update':
                        if not isinstance(action['values'], dict) or not 1 <= len(action['values']) <= 50:
                            raise ValueError('Fact updates require 1–50 field expressions')
                        for field, expression in action['values'].items():
                            _path(field)
                            if not isinstance(expression, str):
                                raise ValueError('Updated fact values must be expressions')
            rule['actions'] = actions
            rule['patterns'] = patterns
            normalized.append(rule)
        self.rules = sorted(normalized, key=lambda rule: (-rule.get('priority', 0), rule['_order']))

    def _expression(self, expression, context):
        # Optional vocabulary support preserves compatibility with existing callers.
        source = (verbalize_to_expression(expression, self.vocabulary) if self.vocabulary
                  else verbalize_to_expression(expression))
        return safe_evaluate(source, context, BUILTINS)

    def run(self, working_memory: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(working_memory, dict):
            raise ValueError('Agenda working memory must be an object')
        memory = deepcopy(working_memory)
        if len(_key(memory).encode()) > 1024 * 1024:
            raise ValueError('Agenda working-memory size limit exceeded')
        if self.vocabulary:
            from .vocabulary import validate_vocabulary_values
            validate_vocabulary_values(memory, self.vocabulary, check_required=True)
        for rule in self.rules:
            if any(pattern['as'] in memory for pattern in rule['patterns']):
                raise ValueError('Fact aliases must not shadow working-memory fields')
        collections = {pattern['collection'] for rule in self.rules for pattern in rule['patterns']}
        collections.update(action['collection'] for rule in self.rules for action in rule['actions']
                           if isinstance(action, dict) and action['op'] == 'insert')
        for path in collections:
            _path(path)
        # Stable fact identity survives list deletion and distinguishes equal objects.
        identities = {}
        retained_facts = {}
        recencies = {}
        next_identity = 0
        scans = 0
        firings = []
        fired = set()

        def collection(path, create=False):
            facts = get_by_path(memory, path)
            if facts is None:
                if create:
                    facts = []
                    set_by_path(memory, path, facts)
                else:
                    return []
            if not isinstance(facts, list) or any(not isinstance(fact, dict) for fact in facts):
                raise ValueError('Fact collections must contain objects')
            return facts

        def refresh_identities():
            nonlocal next_identity
            total = 0
            for path in sorted(collections):
                facts = collection(path)
                total += len(facts)
                for fact in facts:
                    identity_key = id(fact)
                    if identity_key not in identities:
                        next_identity += 1
                        identities[identity_key] = next_identity
                        retained_facts[identity_key] = fact
                        recencies[identity_key] = len(firings)
            if total > MAX_FACTS:
                raise ValueError('Fact count limit exceeded (1000)')

        refresh_identities()
        # Rebuild equality indexes after every firing. Where clauses retain safe AST evaluation.
        while True:
            indexes = {}
            activations = []

            def candidates(pattern):
                nonlocal scans
                path = pattern['collection']
                equals = pattern.get('equals', {})
                if not equals:
                    return collection(path)
                fields = tuple(sorted(equals))
                cache_key = (path, fields)
                if cache_key not in indexes:
                    index = {}
                    for fact in collection(path):
                        scans += 1
                        if scans > MAX_MATCH_VISITS:
                            raise ValueError('Agenda matching budget exceeded')
                        key = tuple(_field_key(fact, field) for field in fields)
                        index.setdefault(key, []).append(fact)
                    indexes[cache_key] = index
                key = tuple((True, _key(equals[field])) for field in fields)
                return indexes[cache_key].get(key, [])

            for rule in self.rules:
                # Lower-priority conditions cannot win this agenda step. Avoid
                # evaluating them against fields the selected action may create.
                if activations and (self.conflict_resolution == 'priority' or
                                    rule.get('priority', 0) < activations[0][1].get('priority', 0)):
                    break
                patterns = rule['patterns']
                if any(pattern['as'] in memory for pattern in patterns):
                    raise ValueError('Fact aliases must not shadow working-memory fields')

                def match(position, bindings, handles):
                    nonlocal scans
                    if position == len(patterns):
                        activation_key = (rule['id'], tuple(identities[id(fact)] for _, fact in handles.values()))
                        if activation_key in fired and not rule.get('loopable', False):
                            return
                        context = dict(memory, **bindings)
                        scans += 1
                        if scans > MAX_MATCH_VISITS:
                            raise ValueError('Agenda matching budget exceeded')
                        if self._expression(rule.get('condition', 'true'), context):
                            if len(activations) >= MAX_ACTIVATIONS:
                                raise ValueError('Agenda activation limit exceeded')
                            specificity = len(patterns) + sum(len(p.get('equals', {})) for p in patterns)
                            recency = max((recencies[id(fact)] for _, fact in handles.values()), default=0)
                            secondary = {'priority': 0, 'specificity': specificity, 'recency': recency}[self.conflict_resolution]
                            activations.append(((-rule.get('priority', 0), -secondary, rule['_order']),
                                                rule, bindings.copy(), handles.copy(), activation_key))
                        return
                    pattern = patterns[position]
                    for fact in candidates(pattern):
                        scans += 1
                        if scans > MAX_MATCH_VISITS:
                            raise ValueError('Agenda matching budget exceeded')
                        alias = pattern['as']
                        bindings[alias] = fact
                        handles[alias] = (pattern['collection'], fact)
                        if self._expression(pattern.get('where', 'true'), dict(memory, **bindings)):
                            match(position + 1, bindings, handles)
                        del bindings[alias]
                        del handles[alias]

                match(0, {}, {})
            if not activations:
                break
            if len(firings) >= self.max_cycles:
                raise ValueError('Agenda firing limit exceeded before reaching equilibrium')
            _, rule, bindings, handles, activation_key = min(activations, key=lambda item: item[0])
            actions_trace = []
            for action in rule['actions']:
                context = dict(memory, **bindings)
                if isinstance(action, str):
                    op, path, value = (parse_action_statement(action, context, self.vocabulary)
                                       if self.vocabulary else parse_action_statement(action, context))
                    if op == 'noop':
                        continue
                    if path.split('.')[0] in bindings:
                        raise ValueError('Use structured update/retract actions to modify bound facts')
                    if op == 'add':
                        existing = get_by_path(memory, path)
                        value = (list(existing) if isinstance(existing, list) else
                                 [existing] if existing is not None else []) + [value]
                    set_by_path(memory, path, deepcopy(value))
                    actions_trace.append({'action': op, 'target': path, 'value': deepcopy(value)})
                elif action['op'] == 'insert':
                    value = self._expression(action['value'], context)
                    if not isinstance(value, dict):
                        raise ValueError('Inserted facts must be objects')
                    collection(action['collection'], create=True).append(deepcopy(value))
                    actions_trace.append({'action': 'insert', 'target': action['collection'], 'value': deepcopy(value)})
                else:
                    alias = action['fact']
                    path, fact = handles[alias]
                    facts = collection(path)
                    if not any(item is fact for item in facts):
                        raise ValueError('Cannot modify or retract a fact that has already been retracted')
                    if action['op'] == 'retract':
                        facts[:] = [item for item in facts if item is not fact]
                        actions_trace.append({'action': 'retract', 'target': alias, 'value': deepcopy(fact)})
                    else:
                        # All field expressions see the same pre-update fact state.
                        values = {field: self._expression(expression, context)
                                  for field, expression in action['values'].items()}
                        for field, value in values.items():
                            set_by_path(fact, field, deepcopy(value))
                        bounded(fact)
                        recencies[id(fact)] = len(firings) + 1
                        actions_trace.append({'action': 'update', 'target': alias, 'values': deepcopy(values)})
            if self.vocabulary:
                validate_vocabulary_values(memory, self.vocabulary, check_required=False)
            # Limit accumulated memory even when each individual expression is small.
            if len(_key(memory).encode()) > 1024 * 1024:
                raise ValueError('Agenda working-memory size limit exceeded')
            firings.append({'cycle': len(firings) + 1, 'ruleId': rule['id'],
                            'priority': rule.get('priority', 0),
                            'bindings': {alias: identities[id(fact)] for alias, (_, fact) in handles.items()},
                            'actions': actions_trace})
            fired.add(activation_key)
            refresh_identities()
        working_memory.clear()
        working_memory.update(memory)
        return {'result': working_memory, 'cycles': len(firings), 'firings': firings,
                'totalFired': len(firings), 'matchVisits': scans,
                'conflictResolution': self.conflict_resolution}
