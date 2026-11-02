"""Bounded declarative expressions; never evaluate imported Python or JavaScript."""
import ast
from decimal import Decimal, ROUND_HALF_UP
import json
import math
import operator
import re

MAX_VALUE_BYTES = 65536
MAX_EXPRESSION = 2048
MAX_STEPS = 256


def bounded(value):
    if isinstance(value, (int, float)) and (not math.isfinite(value) or abs(value) > 10 ** 15):
        raise ValueError('Expression numeric limit exceeded')
    if len(json.dumps(value, allow_nan=False, ensure_ascii=False).encode()) > MAX_VALUE_BYTES:
        raise ValueError('Expression value limit exceeded')
    return value


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def exact_decimal(value):
    """Read a number by its shortest decimal form so 0.1 means one tenth."""
    return Decimal(str(value))


def exact_round(value, digits=0):
    """Commercial half-up rounding, which binary floats and round() cannot provide."""
    quantum = Decimal(1).scaleb(-int(digits))
    return float(exact_decimal(float(value or 0)).quantize(quantum, rounding=ROUND_HALF_UP))


def exact_sum(values):
    return float(sum((exact_decimal(float(value or 0)) for value in values), Decimal(0)))


def _exact_arithmetic(kind, left, right):
    """Decimal + - * / for numbers; integer results that were integers stay integers."""
    if kind is not ast.Div and type(left) is int and type(right) is int:
        return None
    first, second = exact_decimal(left), exact_decimal(right)
    if kind is ast.Add:
        return float(first + second)
    if kind is ast.Sub:
        return float(first - second)
    if kind is ast.Mult:
        return float(first * second)
    if not second:
        raise ValueError('Division by zero')
    return float(first / second)


def _top_level(source):
    """Yield (index, character, depth) for characters outside quoted text."""
    depth, quote, escaped = 0, None, False
    for index, char in enumerate(source):
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in '"\'':
            quote = char
            continue
        if char in ')]}':
            depth -= 1
        yield index, char, depth
        if char in '([{':
            depth += 1


def _split_ternary(source):
    """Split one depth-zero condition at its first ? and the : that matches it."""
    question, nested = None, 0
    for index, char, depth in _top_level(source):
        if depth or char not in '?:':
            continue
        if char == '?':
            nested += question is not None
            question = index if question is None else question
        elif question is not None and nested == 0:
            return source[:question], source[question + 1:index], source[index + 1:]
        elif question is not None:
            nested -= 1
    return None


def _expand_entry(entry):
    """Expand only the value of a dictionary entry; its first colon separates the key."""
    colon = next((at for at, mark, level in _top_level(entry) if level == 0 and mark == ':'), None)
    if colon is None:
        return _expand_ternary(entry)
    return f'{entry[:colon + 1]}{_expand_ternary(entry[colon + 1:])}'


def _expand_groups(source):
    """Expand conditions inside brackets and function arguments, one argument at a time."""
    output, start, opening = [], 0, None
    for index, char, depth in _top_level(source):
        if depth == 0 and char in '([{':
            opening = index
        elif depth == 0 and char in ')]}' and opening is not None:
            inner = source[opening + 1:index]
            commas = [at for at, mark, level in _top_level(inner) if level == 0 and mark == ',']
            edges = [-1, *commas, len(inner)]
            expand = _expand_entry if source[opening] == '{' else _expand_ternary
            parts = [expand(inner[edges[i] + 1:edges[i + 1]]) for i in range(len(edges) - 1)]
            output += [source[start:opening + 1], ','.join(parts)]
            start, opening = index, None
    output.append(source[start:])
    return ''.join(output)


def _expand_ternary(source):
    source = _expand_groups(source)
    parts = _split_ternary(source)
    if parts is None:
        return source
    condition, yes, no = parts
    return f'({_expand_ternary(yes)}) if ({condition}) else ({_expand_ternary(no)})'


def evaluate(source, context, functions):
    if not isinstance(source, str) or len(source) > MAX_EXPRESSION:
        raise ValueError('Expression length limit exceeded')
    if re.search(r'\b__[A-Za-z_]*', source):
        raise ValueError('Private identifiers are not allowed')
    # Keep the existing simple JDM conditional syntax without executing code.
    tree = ast.parse(_expand_ternary(source), mode='eval')
    if sum(1 for _ in ast.walk(tree)) > MAX_STEPS:
        raise ValueError('Expression complexity limit exceeded')
    steps = 0
    binary = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod}
    compare = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt,
               ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge,
               ast.In: lambda a, b: a in b, ast.NotIn: lambda a, b: a not in b,
               ast.Is: operator.is_, ast.IsNot: operator.is_not}

    def visit(node):
        nonlocal steps
        steps += 1
        if steps > MAX_STEPS:
            raise ValueError('Expression complexity limit exceeded')
        if isinstance(node, ast.Constant):
            return bounded(node.value)
        if isinstance(node, ast.Name):
            if node.id in {'true', 'false', 'null', 'none'}:
                return {'true': True, 'false': False, 'null': None, 'none': None}[node.id]
            if node.id.startswith('_') and node.id != '_unary_val_':
                raise ValueError('Private identifiers are not allowed')
            if node.id not in context:
                raise ValueError('Unknown expression field')
            return bounded(context[node.id])
        if isinstance(node, ast.Attribute):
            value = visit(node.value)
            if node.attr.startswith('_') or not isinstance(value, dict):
                raise ValueError('Only document field access is allowed')
            return bounded(value.get(node.attr))
        if isinstance(node, ast.Subscript):
            value, key = visit(node.value), visit(node.slice)
            if isinstance(value, dict) and isinstance(key, str) and not key.startswith('_'):
                return bounded(value.get(key))
            if isinstance(value, (list, str)) and type(key) is int and -len(value) <= key < len(value):
                return bounded(value[key])
            raise ValueError('Invalid field or index')
        if isinstance(node, (ast.List, ast.Tuple)):
            return bounded([visit(item) for item in node.elts])
        if isinstance(node, ast.Dict):
            if any(key is None for key in node.keys):
                raise ValueError('Dictionary unpacking is not allowed')
            return bounded({visit(key): visit(value) for key, value in zip(node.keys, node.values)})
        if isinstance(node, ast.BinOp) and type(node.op) in binary:
            left, right = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Mult):
                for sequence, count in ((left, right), (right, left)):
                    if isinstance(sequence, (str, list)) and (type(count) is not int or count < 0 or count * len(sequence) > MAX_VALUE_BYTES):
                        raise ValueError('Expression allocation limit exceeded')
            if type(node.op) in (ast.Add, ast.Sub, ast.Mult, ast.Div) and _is_number(left) and _is_number(right):
                exact = _exact_arithmetic(type(node.op), left, right)
                if exact is not None:
                    return bounded(exact)
            return bounded(binary[type(node.op)](left, right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in {ast.Not, ast.USub, ast.UAdd}:
            operation = {ast.Not: operator.not_, ast.USub: operator.neg, ast.UAdd: operator.pos}[type(node.op)]
            return bounded(operation(visit(node.operand)))
        if isinstance(node, ast.BoolOp):
            values = node.values
            result = visit(values[0])
            for item in values[1:]:
                if isinstance(node.op, ast.And) and not result or isinstance(node.op, ast.Or) and result:
                    return result
                result = visit(item)
            return result
        if isinstance(node, ast.Compare):
            left = visit(node.left)
            for operation, other in zip(node.ops, node.comparators):
                if type(operation) not in compare:
                    raise ValueError('Unsupported comparison')
                right = visit(other)
                # An absent value is unknown: it never satisfies an exclusion such as != "IR".
                explicit_null = isinstance(other, ast.Name) and other.id in {'null', 'none'}
                if isinstance(operation, (ast.NotEq, ast.NotIn)) and left is None and not explicit_null:
                    return False
                if not compare[type(operation)](left, right):
                    return False
                left = right
            return True
        if isinstance(node, ast.IfExp):
            return visit(node.body if visit(node.test) else node.orelse)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions:
            if node.keywords or len(node.args) > 16:
                raise ValueError('Unsupported function arguments')
            return bounded(functions[node.func.id](*[visit(arg) for arg in node.args]))
        raise ValueError('Only declarative expressions and approved functions are supported')

    return bounded(visit(tree.body))


def validate_graph(graph):
    if not isinstance(graph, dict):
        raise ValueError('Decision graph must be an object')
    if isinstance(graph.get('graph'), dict):
        graph = graph['graph']
    from .vocabulary import validate_vocabulary
    validate_vocabulary(graph.get('vocabulary'))
    nodes, edges = graph.get('nodes'), graph.get('edges')
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= 100 or not isinstance(edges, list) or len(edges) > 500:
        raise ValueError('Use 1–100 nodes and at most 500 edges')
    if len(json.dumps(graph, allow_nan=False).encode()) > 1024 * 1024:
        raise ValueError('Decision graph size limit exceeded')
    allowed = {
        'inputNode', 'outputNode', 'decisionTableNode', 'expressionNode',
        'switchNode', 'decisionNode', 'watsonxAiNode', 'watsonxMlNode',
        'aiInferenceNode', 'mlComponentNode',
        'actionRuleNode', 'businessRuleNode', 'balRuleNode',
        'inferenceNode', 'ruleAgendaNode', 'forkNode', 'joinNode'
    }
    ids = set()
    rule_operations = 0
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not node['id'] or node['id'] in ids:
            raise ValueError('Every graph node requires a unique identifier')
        ids.add(node['id'])
        if node.get('type') not in allowed:
            raise ValueError('Executable function nodes are disabled; use declarative rule or expression nodes')
        content = node.get('content') or {}
        if not isinstance(content, dict):
            raise ValueError('Node content must be an object')
        validate_vocabulary(content.get('vocabulary'))
        for field, maximum in (('rules', 500), ('inputs', 50), ('outputs', 50), ('expressions', 100), ('statements', 100)):
            items = content.get(field, [])
            if not isinstance(items, list) or len(items) > maximum:
                raise ValueError('Decision table or expression complexity limit exceeded')
        rule_operations += len(content.get('rules', [])) * max(1, len(content.get('inputs', [])))
        if rule_operations > 50000:
            raise ValueError('Decision rule operation limit exceeded')
        if node.get('type') in {'actionRuleNode', 'businessRuleNode', 'balRuleNode'}:
            from .bal_engine import validate_bal_rule
            validate_bal_rule(content.get('source') or content.get('rule') or '',
                              content.get('vocabulary', graph.get('vocabulary')))
        if node.get('type') in {'inferenceNode', 'ruleAgendaNode'}:
            from .inference_engine import RuleAgenda
            RuleAgenda(content.get('rules', []), max_cycles=content.get('maxCycles', 500),
                       vocabulary=content.get('vocabulary', graph.get('vocabulary')),
                       conflict_resolution=content.get('conflictResolution', 'priority'))
        if node.get('type') == 'decisionTableNode':
            hp = content.get('hitPolicy', 'first')
            if not isinstance(hp, str) or hp.lower() not in {'first', 'collect', 'ruleorder', 'rule_order'}:
                raise ValueError('Decision table hitPolicy must be first, collect, or ruleOrder')
            column_ids = set()
            for column in content.get('inputs', []) + content.get('outputs', []):
                if (not isinstance(column, dict) or not isinstance(column.get('id'), str)
                        or not column['id'].strip() or column['id'] in column_ids
                        or not isinstance(column.get('field'), str) or not column['field'].strip()):
                    raise ValueError('Decision table columns require unique identifiers and nonempty fields')
                column_ids.add(column['id'])
            rule_ids = set()
            for index, rule in enumerate(content.get('rules', [])):
                if not isinstance(rule, dict):
                    raise ValueError('Decision table rules must be objects')
                rule_id = rule.get('_id', f'rule_{index + 1}')
                if not isinstance(rule_id, str) or not rule_id.strip() or rule_id in rule_ids:
                    raise ValueError('Decision table rule identifiers must be nonempty and unique')
                rule_ids.add(rule_id)
        if node.get('type') == 'switchNode':
            if content.get('hitPolicy', 'first') != 'first':
                raise ValueError('Only first-hit switch routing is supported')
            statement_ids = set()
            for statement in content.get('statements', []):
                if (not isinstance(statement, dict) or not isinstance(statement.get('id'), str)
                        or not statement['id'] or statement['id'] in statement_ids
                        or not isinstance(statement.get('condition', ''), str)):
                    raise ValueError('Switch statements require unique identifiers and string conditions')
                statement_ids.add(statement['id'])
    incoming = dict.fromkeys(ids, 0)
    outgoing = {node_id: [] for node_id in ids}
    edge_ids = set()
    node_by_id = {node['id']: node for node in nodes}
    for edge in edges:
        if not isinstance(edge, dict) or edge.get('sourceId') not in ids or edge.get('targetId') not in ids:
            raise ValueError('Every edge must connect existing nodes')
        if not isinstance(edge.get('id'), str) or not edge['id'] or edge['id'] in edge_ids:
            raise ValueError('Every edge requires a unique identifier')
        edge_ids.add(edge['id'])
        source = node_by_id[edge['sourceId']]
        if source['type'] == 'switchNode':
            statement_ids = {statement['id'] for statement in (source.get('content') or {}).get('statements', [])}
            if edge.get('sourceHandle') not in statement_ids:
                raise ValueError('Switch edges require a sourceHandle matching a statement identifier')
        outgoing[edge['sourceId']].append(edge['targetId'])
        incoming[edge['targetId']] += 1
    queue = [key for key, value in incoming.items() if value == 0]
    visited = 0
    while queue:
        current = queue.pop()
        visited += 1
        for target in outgoing[current]:
            incoming[target] -= 1
            if incoming[target] == 0:
                queue.append(target)
    if visited != len(ids):
        raise ValueError('Decision graphs cannot contain cycles')
    from .decision_engine import validate_parallel_regions
    validate_parallel_regions(graph)
    return graph
