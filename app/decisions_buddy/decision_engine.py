"""
DecisionsBuddy bounded declarative decision engine.
Implements a documented subset of JDM-shaped decision graphs:
- Directed Acyclic Graph (DAG) with topological execution
- Decision Tables (Hit Policy: 'first', 'collect')
- Nested dot-path assignment & reading (e.g. flag.companyType, customer.tier)
- Numeric literals with underscores (e.g. 1_000_000, 200_000)
- Comma-separated unary string literals ("INC", "LTD", "LLC")
- Expression Nodes with multi-variable transformations
- Switch Nodes with statement-based branch routing (sourceHandle)
- Executable function nodes are intentionally rejected
- Microsecond-precision performance tracing
"""

import time
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import math
import re
import json
from datetime import datetime, timezone
import hashlib
from typing import Any, Dict, List, Optional, Tuple, Union

from .safe_expression import exact_decimal, exact_round, exact_sum

# Shared across all sub-decision calls made by one root evaluation.
MAX_NODE_EVALUATIONS = 10_000


def get_by_path(obj: Any, path: str) -> Any:
    """Safe retrieval of nested property by dot path (e.g. 'company.turnover', 'items[0].price')."""
    if not path or path == "$" or obj is None:
        return obj
    normalized = re.sub(r'\[(\w+)\]', r'.\1', str(path)).lstrip('.')
    parts = normalized.split('.')
    curr = obj
    for part in parts:
        if curr is None:
            return None
        if isinstance(curr, dict):
            curr = curr.get(part)
        elif isinstance(curr, (list, tuple)):
            try:
                idx = int(part)
                curr = curr[idx] if 0 <= idx < len(curr) else None
            except ValueError:
                return None
        else:
            return None
    return curr

def set_by_path(obj: Dict[str, Any], path: str, value: Any) -> None:
    """Sets a nested property by dot path (e.g. 'flag.companyType' -> obj['flag']['companyType'] = value)."""
    if not path or path == "$":
        if isinstance(value, dict):
            obj.update(value)
        return
    parts = path.split('.')
    curr = obj
    for part in parts[:-1]:
        if part not in curr or not isinstance(curr[part], dict):
            curr[part] = {}
        curr = curr[part]
    curr[parts[-1]] = value

_MAX_PATTERN_LEN = 200
_MAX_SUBJECT_LEN = 10_000


def _safe_matches(s, p) -> bool:
    """ReDoS-safe regex match: hard-limits pattern and subject length."""
    if s is None:
        return False
    pattern = str(p)
    subject = str(s)
    if len(pattern) > _MAX_PATTERN_LEN:
        raise ValueError(f'matches() pattern exceeds {_MAX_PATTERN_LEN} character limit')
    if len(subject) > _MAX_SUBJECT_LEN:
        subject = subject[:_MAX_SUBJECT_LEN]
    return bool(re.search(pattern, subject))


_FIELD_PATH = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$')


def _field_path(field):
    # A condition passed as a field name would otherwise silently match nothing.
    if not isinstance(field, str) or not _FIELD_PATH.fullmatch(field):
        raise ValueError(f'Use a field name here, not an expression: {field}')
    return field


def _map_field(items, field):
    _field_path(field)
    return [get_by_path(item, field) if isinstance(item, dict) else item for item in items] if isinstance(items, (list, tuple)) else []


def _filter_field(items, field, value=None):
    _field_path(field)
    if not isinstance(items, (list, tuple)):
        return []
    return [item for item in items if (loose_equals(get_by_path(item, field), value) if value is not None else bool(get_by_path(item, field)))]


def _find_field(items, field, value=None):
    matches = _filter_field(items, field, value)
    return matches[0] if matches else None


def _sort_by(items, field, descending=False):
    """Stable ordering by one field, so equal scores keep their declared order."""
    _field_path(field)
    if not isinstance(items, (list, tuple)):
        return []
    values = [get_by_path(item, field) for item in items]
    if any(value is None for value in values):
        raise ValueError(f'sortBy requires {field} on every item')
    return sorted(items, key=lambda item: get_by_path(item, field), reverse=bool(descending))


def _bucket(value, buckets=100):
    """Stable split for A/B holdouts: the same value always lands in the same bucket."""
    if value is None or type(buckets) is not int or buckets < 1:
        raise ValueError('bucket requires a value and a positive bucket count')
    return int(hashlib.sha256(str(value).encode()).hexdigest()[:12], 16) % buckets


def _moment(value):
    # Offers often mix offset and date-only values; date-only values are read as UTC.
    parsed = datetime.fromisoformat(str(value))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _diff_days(start, end):
    return (_moment(end) - _moment(start)).days


# Built-in helper functions matching GoRules DecisionsBuddy expression standard
BUILTINS = {
    "len": lambda v: 0 if v is None else len(v) if isinstance(v, (str, list, dict, tuple)) else 1,
    "count": lambda v: 0 if v is None else len(v) if isinstance(v, (str, list, dict, tuple)) else 1,
    "upper": lambda v: "" if v is None else str(v).upper(),
    "lower": lambda v: "" if v is None else str(v).lower(),
    "trim": lambda v: "" if v is None else str(v).strip(),
    "contains": lambda container, item: item in container if isinstance(container, (list, tuple, str)) else False,
    "list_contains": lambda container, item: item in container if isinstance(container, (list, tuple, str)) else False,
    "startsWith": lambda s, p: str(s).startswith(str(p)) if s is not None else False,
    "starts_with": lambda s, p: str(s).startswith(str(p)) if s is not None else False,
    "endsWith": lambda s, p: str(s).endswith(str(p)) if s is not None else False,
    "ends_with": lambda s, p: str(s).endswith(str(p)) if s is not None else False,
    "matches": lambda s, p: _safe_matches(s, p),
    "abs": lambda n: abs(float(n or 0)),
    "round": exact_round,
    "floor": lambda n: math.floor(float(n or 0)),
    "ceil": lambda n: math.ceil(float(n or 0)),
    "sum": lambda arr: exact_sum(arr) if isinstance(arr, (list, tuple)) else 0,
    "avg": lambda arr: float(exact_decimal(exact_sum(arr)) / len(arr)) if isinstance(arr, (list, tuple)) and len(arr) > 0 else 0,
    "min": lambda *args: min(args[0]) if len(args) == 1 and isinstance(args[0], (list, tuple)) else min(*args),
    "max": lambda *args: max(args[0]) if len(args) == 1 and isinstance(args[0], (list, tuple)) else max(*args),
    "coalesce": lambda *args: next((x for x in args if x is not None), None),
    "date": lambda s: datetime.fromisoformat(str(s)).isoformat(),
    "year": lambda d: datetime.fromisoformat(str(d)).year,
    "diffDays": _diff_days,
    "diff_days": _diff_days,
    "sortBy": _sort_by,
    "sort_by": _sort_by,
    "bucket": _bucket,
    # High-order array & list utilities matching GoRules Zen standard
    "map": _map_field,
    "filter": _filter_field,
    "find": _find_field,
    "flatten": lambda arr: [item for sub in arr for item in (sub if isinstance(sub, (list, tuple)) else [sub])] if isinstance(arr, (list, tuple)) else [],
    "unique": lambda arr: list(dict.fromkeys(arr)) if isinstance(arr, (list, tuple)) else [],
    "join": lambda arr, sep=', ': str(sep).join(str(x) for x in arr) if isinstance(arr, (list, tuple)) else str(arr),
    "split": lambda s, sep=None: str(s).split(str(sep) if sep is not None else None) if s is not None else [],
    "replace": lambda s, old, new: str(s).replace(str(old), str(new)) if s is not None else '',
    "slice": lambda arr, start, end=None: arr[int(start):(int(end) if end is not None else None)] if isinstance(arr, (list, str)) else arr,
}

def clean_num_str(s: str) -> str:
    """Cleans numeric underscores (e.g. '1_000_000' -> '1000000')."""
    return re.sub(r'(\d)_(\d)', r'\1\2', s)

def parse_literal(val_str: str, context: Optional[Dict[str, Any]] = None) -> Any:
    val_str = clean_num_str(val_str.strip())
    if (val_str.startswith('"') and val_str.endswith('"')) or (val_str.startswith("'") and val_str.endswith("'")):
        return val_str[1:-1]
    if val_str == "true":
        return True
    if val_str == "false":
        return False
    if val_str in ("null", "none"):
        return None
    # Check numeric
    try:
        if "." in val_str:
            return float(val_str)
        return int(val_str)
    except ValueError:
        pass
    
    # Check context
    if context:
        val = get_by_path(context, val_str)
        if val is not None:
            return val
    return val_str

def loose_equals(a: Any, b: Any) -> bool:
    if a == b:
        return True
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, str) and isinstance(b, str):
        return a.strip().lower() == b.strip().lower()
    try:
        return float(clean_num_str(str(a))) == float(clean_num_str(str(b)))
    except (ValueError, TypeError):
        pass
    return str(a).strip() == str(b).strip()


def _split_unary_list(source):
    # The legacy grammar splits commas with an even number of quote characters
    # to their right. A reverse pass preserves that rule without suffix scans.
    boundaries = []
    quoted = False
    for index in range(len(source) - 1, -1, -1):
        if source[index] in ('"', "'"):
            quoted = not quoted
        elif source[index] == ',' and not quoted:
            boundaries.append(index)
    parts, start = [], 0
    for end in reversed(boundaries):
        part = source[start:end].strip()
        if part:
            parts.append(part)
        start = end + 1
    part = source[start:].strip()
    if part:
        parts.append(part)
    return parts


def _unary_operand(source, keyword):
    tail = source[len(keyword):]
    if source[:len(keyword)].lower() != keyword or not tail or not tail[0].isspace():
        return None
    operand = tail.lstrip()
    return operand if '\n' not in operand else None


def _unary_range(source):
    if len(source) < 5 or source[0] not in '[(' or source[-1] not in '])':
        return None
    bounds = source[1:-1].split('..')
    if len(bounds) != 2:
        return None
    low, high = (bound.strip() for bound in bounds)
    number = r'-?\d+(?:\.\d+)?'
    if not re.fullmatch(number, low) or not re.fullmatch(number, high):
        return None
    return source[0], low, high, source[-1]

def _null_aware(test) -> bool:
    """Whether an unquoted test names null, or inspects the value through a placeholder."""
    unquoted = re.sub(r'"[^"]*"|\'[^\']*\'', '', str(test))
    return bool(re.search(r'\b(?:null|none)\b(?!\s*[<>=!])', unquoted)) or '?' in unquoted or '$' in unquoted


def evaluate_unary(test_str: Any, value: Any, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Evaluates a single DecisionsBuddy unary test against a value.
    Supports:
      - Empty string or '-' : always True (pass-through)
      - Numerical comparisons: '> 10', '<= 50', '>= 1_000_000'
      - Range tests: '[18..65]', '[200_000..1_000_000]', '(10..20)'
      - Comma-separated string literals: '"INC", "LTD", "LLC"' or in ['US', 'CA']
      - Negation: not in ['BLOCKED']
      - Compound: test1 and test2, test1 or test2
      - Null & Boolean checks: is null, is not null, true, false
    """
    if test_str is None:
        return {"passed": True, "details": "empty test"}
    s = str(test_str).strip()
    if not s or s == "-":
        return {"passed": True, "details": "pass-through (-)"}

    # Normalize underscores for numbers in condition string
    s = clean_num_str(s)

    # Fail closed: an absent value only satisfies a test that names null explicitly.
    if value is None and not _null_aware(s):
        return {"passed": False, "details": f"missing value does not satisfy {s}"}

    # Dynamic GoRules Zen '?' or '$' cell placeholder evaluation
    if '?' in s or '$' in s:
        has_placeholder = False
        in_q = None
        for ch in s:
            if ch in ('"', "'"):
                in_q = None if in_q == ch else (ch if in_q is None else in_q)
            elif ch in ('?', '$') and in_q is None:
                has_placeholder = True
                break
        if has_placeholder:
            parts = []
            in_q = None
            for ch in s:
                if ch in ('"', "'"):
                    in_q = None if in_q == ch else (ch if in_q is None else in_q)
                    parts.append(ch)
                elif ch in ('?', '$') and in_q is None:
                    parts.append('_unary_val_')
                else:
                    parts.append(ch)
            expr_with_val = "".join(parts)
            eval_ctx = dict(context or {})
            eval_ctx['_unary_val_'] = value
            try:
                from .safe_expression import evaluate
                res = evaluate(expr_with_val, eval_ctx, BUILTINS)
                passed = bool(res)
                return {"passed": passed, "details": f"{s} evaluated with ?={value} -> {passed}"}
            except Exception as ex:
                return {"passed": False, "details": f"Placeholder evaluation error: {ex}"}

    # Negation wrapper: not(...)
    not_match = re.match(r"^not\s*\((.*)\)$", s, re.IGNORECASE)
    if not_match:
        inner = not_match.group(1).strip()
        inner_res = evaluate_unary(inner, value, context)
        passed = not inner_res["passed"]
        return {"passed": passed, "details": f"not({inner}) -> {passed}"}

    # A quoted literal can contain logical words without being a compound test.
    if s.startswith(('"', "'")):
        import ast
        try:
            literal = ast.literal_eval(s)
        except (ValueError, SyntaxError):
            literal = None
        if isinstance(literal, str):
            passed = loose_equals(value, literal)
            return {"passed": passed, "details": f"{value} == {literal} -> {passed}"}

    # Compound OR
    if " or " in s and not s.startswith("in ") and not s.startswith("["):
        parts = s.split(" or ")
        sub_results = [evaluate_unary(p.strip(), value, context) for p in parts]
        passed = any(r["passed"] for r in sub_results)
        return {"passed": passed, "details": " OR ".join(r["details"] for r in sub_results)}

    # Compound AND
    if " and " in s and not s.startswith("in ") and not s.startswith("["):
        parts = s.split(" and ")
        sub_results = [evaluate_unary(p.strip(), value, context) for p in parts]
        passed = all(r["passed"] for r in sub_results)
        return {"passed": passed, "details": " AND ".join(r["details"] for r in sub_results)}

    # Null checks
    if s in ("is null", "null"):
        passed = (value is None)
        return {"passed": passed, "details": f"{value} is null -> {passed}"}
    if s == "is not null":
        passed = (value is not None)
        return {"passed": passed, "details": f"{value} is not null -> {passed}"}

    # Boolean constants
    if s in ("true", "false"):
        # Text such as "false" or "no" is truthy; guessing would flip the decision.
        if not isinstance(value, bool):
            raise ValueError(f'A true/false test requires a boolean value, received {type(value).__name__}')
        passed = value is (s == "true")
        return {"passed": passed, "details": f"{value} == {s} -> {passed}"}

    # in [item1, item2, ...]
    in_match = re.match(r"^in\s*\[(.*)\]$", s, re.IGNORECASE)
    if in_match:
        items = [parse_literal(item) for item in in_match.group(1).split(",") if item.strip()]
        passed = any(loose_equals(value, item) for item in items)
        return {"passed": passed, "details": f"{value} in {items} -> {passed}"}

    # not in [item1, item2, ...]
    not_in_match = re.match(r"^not\s+in\s*\[(.*)\]$", s, re.IGNORECASE)
    if not_in_match:
        items = [parse_literal(item) for item in not_in_match.group(1).split(",") if item.strip()]
        passed = not any(loose_equals(value, item) for item in items)
        return {"passed": passed, "details": f"{value} not in {items} -> {passed}"}

    # Comma-separated list shorthand (e.g. '"INC", "LTD", "LLC"', '1, 2, 3', or "'US', 'CA'")
    if ',' in s and not s.startswith('[') and not s.startswith('(') and not s.lower().startswith(('in ', 'not in ', 'in[', 'not in[')):
        parts = _split_unary_list(s)
        if len(parts) > 1:
            sub_results = [evaluate_unary(p, value, context) for p in parts]
            passed = any(r["passed"] for r in sub_results)
            return {"passed": passed, "details": f"{value} in ({s}) -> {passed}"}

    # contains check: 'contains "item"' or 'contains 10'
    contains_operand = _unary_operand(s, "contains")
    if contains_operand is not None:
        target = parse_literal(contains_operand, context)
        if isinstance(value, (list, tuple)):
            passed = any(loose_equals(item, target) for item in value)
        elif isinstance(value, (str, dict)):
            passed = str(target) in value
        else:
            passed = False
        return {"passed": passed, "details": f"{value} contains {target} -> {passed}"}

    # some <test>: e.g. "some > 10", "some in ['VIP', 'Gold']"
    some_operand = _unary_operand(s, "some")
    if some_operand is not None:
        sub_expr = some_operand.strip()
        items = value if isinstance(value, (list, tuple)) else [value] if value is not None else []
        passed = any(evaluate_unary(sub_expr, item, context)["passed"] for item in items)
        return {"passed": passed, "details": f"some({items}) satisfies {sub_expr} -> {passed}"}

    # all <test>: e.g. "all >= 0"
    all_operand = _unary_operand(s, "all")
    if all_operand is not None:
        sub_expr = all_operand.strip()
        items = value if isinstance(value, (list, tuple)) else [value] if value is not None else []
        passed = bool(items) and all(evaluate_unary(sub_expr, item, context)["passed"] for item in items)
        return {"passed": passed, "details": f"all({items}) satisfies {sub_expr} -> {passed}"}

    # none <test>: e.g. "none < 0"
    none_operand = _unary_operand(s, "none")
    if none_operand is not None:
        sub_expr = none_operand.strip()
        items = value if isinstance(value, (list, tuple)) else [value] if value is not None else []
        passed = not any(evaluate_unary(sub_expr, item, context)["passed"] for item in items)
        return {"passed": passed, "details": f"none({items}) satisfies {sub_expr} -> {passed}"}

    # Range: [min..max]
    range_match = _unary_range(s)
    if range_match:
        l_br, min_val, max_val, r_br = range_match
        min_v = float(min_val)
        max_v = float(max_val)
        try:
            val_num = float(clean_num_str(str(value)))
            min_pass = (val_num >= min_v) if l_br == "[" else (val_num > min_v)
            max_pass = (val_num <= max_v) if r_br == "]" else (val_num < max_v)
            passed = min_pass and max_pass
            return {"passed": passed, "details": f"{val_num} in {l_br}{min_v}..{max_v}{r_br} -> {passed}"}
        except (ValueError, TypeError):
            return {"passed": False, "details": f"Value {value} is not numeric"}

    # Comparison: >=, <=, !=, ==, =, >, <
    comp_operator = next((operator for operator in (">=", "<=", "!=", "==", "=", ">", "<") if s.startswith(operator)), None)
    if comp_operator is not None and "\n" not in s[len(comp_operator):].lstrip():
        op = "==" if comp_operator == "=" else comp_operator
        target = parse_literal(s[len(comp_operator):].lstrip(), context)
        if op in {">", "<", ">=", "<="} and (value is None or target is None or isinstance(value, bool) or isinstance(target, bool)):
            return {"passed": False, "details": "Ordering requires comparable non-null values"}
        try:
            val_cleaned = clean_num_str(str(value)) if isinstance(value, (int, float, str)) else value
            try:
                v1, v2 = float(val_cleaned), float(target)
                if not math.isfinite(v1) or not math.isfinite(v2):
                    return {"passed": False, "details": "Comparison requires finite numbers"}
                if op == ">": passed = v1 > v2
                elif op == "<": passed = v1 < v2
                elif op == ">=": passed = v1 >= v2
                elif op == "<=": passed = v1 <= v2
                elif op == "==": passed = v1 == v2
                elif op == "!=": passed = v1 != v2
                else: passed = False
            except (ValueError, TypeError):
                if op == "==": passed = loose_equals(value, target)
                elif op == "!=": passed = not loose_equals(value, target)
                elif not isinstance(value, str) or not isinstance(target, str): passed = False
                elif op == ">": passed = value > target
                elif op == "<": passed = value < target
                elif op == ">=": passed = value >= target
                elif op == "<=": passed = value <= target
                else: passed = False
            return {"passed": passed, "details": f"{value} {op} {target} -> {passed}"}
        except Exception as e:
            return {"passed": False, "details": f"Comparison error: {e}"}

    # Exact literal comparison
    target = parse_literal(s, context)
    passed = loose_equals(value, target)
    return {"passed": passed, "details": f"{value} == {target} -> {passed}"}

_CONSTANT_LABEL = re.compile(r'^[A-Z][A-Z0-9_]*$')


def evaluate_expression(expr_str: str, context: Dict[str, Any], *, bare_words: str = 'any') -> Any:
    """Evaluates a DecisionsBuddy expression in context with built-in functions."""
    if not expr_str:
        return None
    s = str(expr_str).strip()
    if not s:
        return None
    val = get_by_path(context, s)
    if val is not None:
        return val

    from .safe_expression import evaluate
    # Keep single-word legacy output labels; operators and multiword text must
    # pass the declarative parser (quote multiword labels explicitly).
    if re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', s) and s not in context and not re.search(r'\b(?:and|or|not|true|false|null|none|True|False|None)\b', s):
        # A misspelled field must not become a price or decision that is merely its own name.
        if bare_words == 'none' or bare_words == 'constants' and not _CONSTANT_LABEL.fullmatch(s):
            raise ValueError(f'Unknown field {s}; quote it if it is text')
        return parse_literal(s, context)
    return evaluate(s, context, BUILTINS)

def validate_json_schema(data: Any, schema: Dict[str, Any], path: str = "$") -> List[str]:
    """Validates data against a standard JSON Schema (type, required, properties, minimum, maximum, enum)."""
    errors = []
    if not isinstance(schema, dict):
        return errors

    expected_type = schema.get("type")
    type_map = {
        "object": dict,
        "array": (list, tuple),
        "string": str,
        "number": (int, float),
        "integer": int,
        "boolean": bool,
        "null": type(None)
    }

    if expected_type in type_map and not isinstance(data, type_map[expected_type]):
        if not (expected_type == "number" and isinstance(data, (int, float))):
            errors.append(f"{path}: expected type '{expected_type}', got '{type(data).__name__}'")
            return errors

    if isinstance(data, dict):
        for req in schema.get("required", []):
            if req not in data or data[req] is None:
                errors.append(f"{path}: missing required property '{req}'")
        for prop, prop_schema in schema.get("properties", {}).items():
            if prop in data:
                errors.extend(validate_json_schema(data[prop], prop_schema, f"{path}.{prop}"))

    elif isinstance(data, (int, float)):
        if "minimum" in schema and data < schema["minimum"]:
            errors.append(f"{path}: value {data} is less than minimum {schema['minimum']}")
        if "maximum" in schema and data > schema["maximum"]:
            errors.append(f"{path}: value {data} is greater than maximum {schema['maximum']}")

    if "enum" in schema and data not in schema["enum"]:
        errors.append(f"{path}: value '{data}' is not in enum {schema['enum']}")

    return errors


def evaluate_decision_table(table_def: Dict[str, Any], context: Dict[str, Any]) -> Tuple[Any, List[Dict[str, Any]]]:
    """
    Evaluates a Decision Table according to hitPolicy ('first', 'collect', or 'ruleOrder').
    Supports nested dot-path outputs (e.g. 'flag.companyType').
    """
    hit_policy = table_def.get("hitPolicy", "first").lower()
    if hit_policy not in {"first", "collect", "ruleorder", "rule_order"}:
        raise ValueError('Decision table hitPolicy must be first, collect, or ruleOrder')
    inputs = table_def.get("inputs", [])
    outputs = table_def.get("outputs", [])
    rules = table_def.get("rules", [])

    input_values = []
    for inp in inputs:
        field = inp.get("field", "")
        val = get_by_path(context, field)
        if val is None and not inp.get("optional"):
            cells = [str(rule.get(inp.get("id"), "-")).strip() for rule in rules]
            tested = [cell for cell in cells if cell and cell != "-" and cell != "None"]
            if tested and not any(_null_aware(cell) for cell in tested):
                raise ValueError(f"Required decision input is missing: {field}")
        input_values.append({"id": inp.get("id"), "field": field, "name": inp.get("name", field), "value": val})

    rules_trace = []
    matched_outputs = []

    for rule_idx, rule in enumerate(rules):
        rule_id = rule.get("_id", f"rule_{rule_idx + 1}")
        rule_desc = rule.get("_description", "")
        rule_passed = True
        condition_traces = []

        for inp_meta in input_values:
            col_id = inp_meta["id"]
            test_val = rule.get(col_id, "-")
            eval_res = evaluate_unary(test_val, inp_meta["value"], context)
            condition_traces.append({
                "colId": col_id,
                "field": inp_meta["field"],
                "test": test_val,
                "actual": inp_meta["value"],
                "passed": eval_res["passed"],
                "details": eval_res["details"]
            })
            if not eval_res["passed"]:
                rule_passed = False

        output_data = {}
        if rule_passed:
            for out_meta in outputs:
                col_id = out_meta.get("id")
                target_field = out_meta.get("field", col_id)
                raw_out_val = rule.get(col_id)
                computed_val = (evaluate_expression(str(raw_out_val), context, bare_words='constants')
                                if raw_out_val is not None else None)
                output_data[target_field] = computed_val
            matched_outputs.append(output_data)

        rules_trace.append({
            "ruleId": rule_id,
            "ruleIndex": rule_idx,
            "description": rule_desc,
            "passed": rule_passed,
            "conditions": condition_traces,
            "output": output_data if rule_passed else None
        })

        if rule_passed and hit_policy == "first":
            break

    if hit_policy == "first":
        final_result = matched_outputs[0] if matched_outputs else {}
    elif hit_policy in {"ruleorder", "rule_order"}:
        final_result = matched_outputs
    elif any(out_meta.get("collect") or out_meta.get("aggregation") for out_meta in outputs):
        # GoRules Zen Per-Column Collect Aggregation
        aggregated = {}
        for out_meta in outputs:
            col_id = out_meta.get("id")
            target_field = out_meta.get("field", col_id)
            agg = str(out_meta.get("collect") or out_meta.get("aggregation") or "array").lower()
            vals = [m[target_field] for m in matched_outputs if target_field in m and m[target_field] is not None]
            default_v = out_meta.get("defaultValue")
            if agg == "sum":
                aggregated[target_field] = exact_sum(vals) if vals else (default_v or 0)
            elif agg == "min":
                aggregated[target_field] = min(vals) if vals else default_v
            elif agg == "max":
                aggregated[target_field] = max(vals) if vals else default_v
            elif agg == "count":
                aggregated[target_field] = len(vals)
            elif agg == "first":
                aggregated[target_field] = vals[0] if vals else default_v
            elif agg == "last":
                aggregated[target_field] = vals[-1] if vals else default_v
            else: # "array"
                aggregated[target_field] = vals
        final_result = aggregated
    else:
        final_result = matched_outputs
    return final_result, rules_trace

def execute_function_node(content: Union[str, Dict[str, Any]], context: Dict[str, Any]) -> Dict[str, Any]:
    raise ValueError('Executable function nodes are disabled in the shared DecisionsBuddy service')

# Fork branches share no mutable working memory. Lists are merged as atomic values;
# object changes merge by field, including disjoint additions to a new object.
_MISSING = object()


def validate_parallel_regions(graph):
    """Plan structured fork/join regions without executing user expressions."""
    nodes = {node['id']: node for node in graph['nodes']}
    outgoing = {identity: [] for identity in nodes}
    incoming = {identity: [] for identity in nodes}
    for edge in graph['edges']:
        outgoing[edge['sourceId']].append(edge['targetId'])
        incoming[edge['targetId']].append(edge['sourceId'])

    def descendants(start):
        found, pending = set(), [start]
        while pending:
            current = pending.pop()
            if current in found:
                continue
            found.add(current)
            pending.extend(outgoing[current])
        return found

    plans = {}
    for identity, node in nodes.items():
        if node['type'] == 'joinNode':
            policy = (node.get('content') or {}).get('mergePolicy', 'error')
            if policy not in ('error', 'first', 'last'):
                raise ValueError('Join mergePolicy must be error, first, or last')
        if node['type'] != 'forkNode':
            continue
        content = node.get('content') or {}
        workers = content.get('maxWorkers', 4)
        if type(workers) is not int or not 1 <= workers <= 8:
            raise ValueError('Fork maxWorkers must be an integer between 1 and 8')
        starts = outgoing[identity]
        if not starts or len(starts) != len(set(starts)):
            raise ValueError('Fork requires distinct outgoing branch targets')
        reachable = [descendants(start) for start in starts]
        common = set.intersection(*reachable)
        join = content.get('joinId')
        if join is not None:
            if not isinstance(join, str) or join not in common or nodes[join]['type'] != 'joinNode':
                raise ValueError('Fork joinId must identify a join reachable from every branch')
        else:
            candidates = [candidate for candidate in common if nodes[candidate]['type'] == 'joinNode']
            # A later common join is reachable from an earlier one. Prefer the
            # earliest common join, independent of node declaration order.
            candidates = [candidate for candidate in candidates if not any(
                candidate in descendants(other) for other in candidates if other != candidate)]
            if len(candidates) != 1:
                raise ValueError('Fork requires one unambiguous common join; set joinId')
            join = candidates[0]
        branches = []
        owned = set()
        for start in starts:
            region, pending = set(), [start]
            while pending:
                current = pending.pop()
                if current == join or current in region:
                    continue
                region.add(current)
                if nodes[current]['type'] in ('forkNode', 'joinNode', 'outputNode'):
                    raise ValueError('Parallel branches cannot contain nested forks/joins or output nodes')
                if not outgoing[current]:
                    raise ValueError('Every parallel branch path must terminate at its join')
                pending.extend(outgoing[current])
            if owned & region:
                raise ValueError('Parallel branches must not share nodes before their join')
            owned.update(region)
            branches.append(region)
        for region in branches:
            for member in region:
                if any(parent not in region and parent != identity for parent in incoming[member]):
                    raise ValueError('Parallel branches cannot have external incoming edges')
                if any(target not in region and target != join for target in outgoing[member]):
                    raise ValueError('Parallel branches cannot have external outgoing edges')
        if any(parent not in owned and parent != identity for parent in incoming[join]):
            raise ValueError('Parallel join cannot have external incoming edges')
        plans[identity] = {'joinId': join, 'branches': branches, 'owned': owned,
                           'maxWorkers': workers,
                           'mergePolicy': (nodes[join].get('content') or {}).get('mergePolicy', 'error')}
    assigned = set()
    for plan in plans.values():
        if plan['joinId'] in assigned:
            raise ValueError('Each parallel fork requires its own join')
        assigned.add(plan['joinId'])
    return plans


def _same_parallel_value(left, right):
    if left is _MISSING or right is _MISSING:
        return left is right
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def _parallel_changes(before, after, path=()):
    if isinstance(after, dict) and (isinstance(before, dict) or before is _MISSING) and (after or isinstance(before, dict)):
        previous = before if isinstance(before, dict) else {}
        changes = []
        for key in sorted(set(previous) | set(after)):
            changes.extend(_parallel_changes(previous.get(key, _MISSING), after.get(key, _MISSING), path + (key,)))
        return changes
    if _same_parallel_value(before, after):
        return []
    return [(path, after)]


def _merge_parallel_results(baseline, results, policy):
    patches = []
    for result in results:
        for path, value in _parallel_changes(baseline, result):
            conflicts = [(previous_path, previous_value) for previous_path, previous_value in patches
                         if path[:len(previous_path)] == previous_path or previous_path[:len(path)] == path]
            if conflicts:
                if len(conflicts) == 1 and conflicts[0][0] == path and _same_parallel_value(conflicts[0][1], value):
                    continue
                if policy == 'error':
                    raise ValueError('Parallel branch merge conflict at ' + '.'.join(path))
                if policy == 'first':
                    continue
                patches = [(previous_path, previous_value) for previous_path, previous_value in patches
                           if not (path[:len(previous_path)] == previous_path or previous_path[:len(path)] == path)]
            patches.append((path, value))
    merged = deepcopy(baseline)
    for path, value in patches:
        target = merged
        for key in path[:-1]:
            if not isinstance(target.get(key), dict):
                target[key] = {}
            target = target[key]
        if value is _MISSING:
            target.pop(path[-1], None)
        else:
            target[path[-1]] = deepcopy(value)
    return merged


def _delete_path(document, path):
    parts = path.split('.')
    for part in parts[:-1]:
        document = document.get(part) if isinstance(document, dict) else None
    if isinstance(document, dict):
        document.pop(parts[-1], None)


def _rule_targets(source, vocabulary):
    from .bal_engine import action_target, parse_bal_sections, split_statements
    bodies = parse_bal_sections(source)
    return [target for section in ('then', 'else') for statement in split_statements(bodies.get(section, ''))
            if (target := action_target(statement, vocabulary))]


def _output_schema_allows(schema):
    """The top-level fields an output object schema publishes, or None for all of them."""
    if schema.get('additionalProperties') is True or not isinstance(schema.get('properties'), dict):
        return None
    return set(schema['properties'])


class DecisionEngine:
    """
    Bounded declarative execution engine; not a complete GoRules implementation.
    """
    def __init__(self, decisions: Optional[Dict[str, Dict[str, Any]]] = None):
        self.decisions = decisions or {}

    def register_decision(self, key: str, graph_content: Dict[str, Any]):
        self.decisions[key] = graph_content

    def _declared_writes(self, graph, seen=None):
        """Fields this graph decides, including through registered sub-decisions."""
        from .bal_engine import action_target, split_statements
        seen = seen if seen is not None else set()
        writes = set()
        if isinstance(graph.get('graph'), dict):
            graph = graph['graph']
        for node in graph.get('nodes', []):
            content = node.get('content') or {}
            kind = node.get('type')
            vocabulary = content.get('vocabulary', graph.get('vocabulary'))
            if kind == 'decisionTableNode':
                writes.update(out.get('field', out.get('id')) for out in content.get('outputs', []))
            elif kind == 'expressionNode':
                writes.update(item.get('key') for item in content.get('expressions', []))
            elif kind in ('actionRuleNode', 'businessRuleNode', 'balRuleNode'):
                writes.update(_rule_targets(content.get('source') or content.get('rule') or '', vocabulary))
            elif kind in ('inferenceNode', 'ruleAgendaNode'):
                for rule in content.get('rules', []):
                    actions = rule.get('actions', [])
                    actions = split_statements(actions) if isinstance(actions, str) else actions
                    for action in actions:
                        target = action_target(action, vocabulary) if isinstance(action, str) else (
                            action.get('collection') if action.get('op') == 'insert' else None)
                        if target:
                            writes.add(target)
            elif kind == 'decisionNode':
                key = content.get('key') or content.get('decisionId')
                if key in self.decisions and key not in seen:
                    seen.add(key)
                    writes.update(self._declared_writes(self.decisions[key], seen))
        return {path for path in writes if isinstance(path, str)}

    def _without_caller_decisions(self, document, graph, input_data, assigned):
        """Remove values the graph owns but never computed, so callers cannot supply outcomes."""
        for path in self._declared_writes(graph):
            written = any(path == item or path.startswith(item + '.') for item in assigned)
            if not written and get_by_path(input_data, path) is not None and get_by_path(document, path) == get_by_path(input_data, path):
                _delete_path(document, path)
        return document

    def evaluate(self, key_or_graph: Union[str, Dict[str, Any]], input_data: Dict[str, Any], *, _budget=None, _parallel_depth=0, _assigned=None) -> Dict[str, Any]:
        start_time_ns = time.perf_counter_ns()
        assigned = _assigned if _assigned is not None else set()
        budget = _budget if _budget is not None else {'remaining': MAX_NODE_EVALUATIONS}
        budget.setdefault('_lock', Lock())

        if isinstance(key_or_graph, str):
            if key_or_graph not in self.decisions:
                raise KeyError(f"Decision '{key_or_graph}' not found in engine registry")
            graph = self.decisions[key_or_graph]
        else:
            graph = key_or_graph

        if "graph" in graph and isinstance(graph["graph"], dict):
            graph = graph["graph"]

        from .safe_expression import validate_graph
        graph = validate_graph(graph)
        from .vocabulary import validate_vocabulary_values
        validate_vocabulary_values(input_data, graph.get("vocabulary"))
        parallel_plans = validate_parallel_regions(graph)
        if _parallel_depth and parallel_plans:
            raise ValueError("Nested parallel execution is not supported")
        nodes = {n["id"]: n for n in graph.get("nodes", [])}
        edges = graph.get("edges", [])

        # Map edges by source node
        out_edges = {}
        in_degrees = {nid: 0 for nid in nodes}
        for edge in edges:
            src = edge.get("sourceId")
            tgt = edge.get("targetId")
            if src not in out_edges:
                out_edges[src] = []
            out_edges[src].append(edge)
            if tgt in in_degrees:
                in_degrees[tgt] += 1

        # Topological sorting
        queue = [nid for nid, deg in in_degrees.items() if deg == 0]
        exec_order = []
        while queue:
            curr = queue.pop(0)
            exec_order.append(curr)
            for edge in out_edges.get(curr, []):
                tgt = edge.get("targetId")
                if tgt in in_degrees:
                    in_degrees[tgt] -= 1
                    if in_degrees[tgt] == 0:
                        queue.append(tgt)

        context = deepcopy(input_data)
        node_traces = []
        final_result = {}
        has_output = any(item.get("type") == "outputNode" for item in graph.get("nodes", []))
        reached_output = False
        active_switch_edges = set()
        inactive_switch_edges = set()
        skipped_nodes = set()
        completed_parallel_nodes = set()

        for nid in exec_order:
            if nid in completed_parallel_nodes:
                continue
            with budget['_lock']:
                if budget['remaining'] <= 0:
                    raise ValueError('Decision evaluation node budget exceeded')
                budget['remaining'] -= 1
            branch_traces = []
            node = nodes[nid]
            node_type = node.get("type")
            node_name = node.get("name", nid)
            content = node.get("content") or {}
            n_start = time.perf_counter_ns()

            # Check if all incoming edges are from inactive switch branches or skipped nodes
            incoming = [e for e in edges if e.get("targetId") == nid]
            if incoming and all(e.get("id") in inactive_switch_edges or e.get("sourceId") in skipped_nodes for e in incoming):
                skipped_nodes.add(nid)
                node_traces.append({
                    "id": nid,
                    "name": node_name,
                    "type": node_type,
                    "status": "skipped",
                    "durationMicros": 0
                })
                continue

            node_trace = {
                "id": nid,
                "name": node_name,
                "type": node_type,
                "status": "success",
                "inputSnapshot": deepcopy(context),
                "outputSnapshot": None,
                "durationMicros": 0
            }

            try:
                if node_type == "inputNode":
                    schema = content.get("schema")
                    if isinstance(schema, dict) and ("type" in schema or "properties" in schema or "required" in schema):
                        schema_errors = validate_json_schema(input_data, schema, path="request")
                        if schema_errors:
                            raise ValueError(f"Input schema validation failed: {'; '.join(schema_errors)}")
                    node_trace["outputSnapshot"] = deepcopy(context)

                elif node_type == "decisionTableNode":
                    table_res, rule_trace = evaluate_decision_table(content, context)
                    node_trace["ruleTrace"] = rule_trace
                    node_trace["outputSnapshot"] = table_res
                    if isinstance(table_res, dict):
                        for k, v in table_res.items():
                            set_by_path(context, k, v)
                            assigned.add(k)
                    elif isinstance(table_res, list):
                        context[node_name or "results"] = table_res
                        context["results"] = table_res

                elif node_type == "expressionNode":
                    expressions = content.get("expressions", [])
                    out_vars = {}
                    for exp in expressions:
                        key = exp.get("key")
                        val_expr = exp.get("value")
                        computed = evaluate_expression(val_expr, context, bare_words='none')
                        out_vars[key] = computed
                        set_by_path(context, key, computed)
                        assigned.add(key)
                    node_trace["outputSnapshot"] = out_vars

                elif node_type == "functionNode":
                    fn_res = execute_function_node(content, context)
                    if isinstance(fn_res, dict):
                        for k, v in fn_res.items():
                            set_by_path(context, k, v)
                    node_trace["outputSnapshot"] = fn_res

                elif node_type == "switchNode":
                    statements = content.get("statements", [])
                    chosen_statement_id = None
                    for stmt in statements:
                        cond = stmt.get("condition", "").strip()
                        stmt_id = stmt.get("id")
                        condition = evaluate_expression(cond, context, bare_words='none') if cond else True
                        if type(condition) is not bool:
                            raise ValueError('Switch conditions must evaluate to a boolean')
                        if condition:
                            chosen_statement_id = stmt_id
                            break
                    
                    for edge in out_edges.get(nid, []):
                        if edge.get("sourceHandle") == chosen_statement_id:
                            active_switch_edges.add(edge.get("id"))
                        else:
                            inactive_switch_edges.add(edge.get("id"))
                    node_trace["outputSnapshot"] = {"activeStatementId": chosen_statement_id}

                elif node_type in ("watsonxAiNode", "aiInferenceNode"):
                    from .watsonx_inference import execute_watsonx_ai
                    ai_out = execute_watsonx_ai(content, context)
                    if isinstance(ai_out, dict):
                        for k, v in ai_out.items():
                            set_by_path(context, k, v)
                    node_trace["outputSnapshot"] = ai_out

                elif node_type in ("watsonxMlNode", "mlComponentNode"):
                    from .watsonx_inference import execute_watsonx_ml
                    ml_out = execute_watsonx_ml(content, context)
                    if isinstance(ml_out, dict):
                        for k, v in ml_out.items():
                            set_by_path(context, k, v)
                    node_trace["outputSnapshot"] = ml_out

                elif node_type == "decisionNode":
                    # Sub-Decision Node: loads and executes another decision model
                    sub_key = content.get("key") or content.get("decisionId")
                    if sub_key:
                        sub_res = self.evaluate(sub_key, context, _budget=budget, _parallel_depth=_parallel_depth, _assigned=assigned)
                        sub_out = sub_res.get("result", {})
                        if isinstance(sub_out, dict):
                            for k, v in sub_out.items():
                                set_by_path(context, k, v)
                        node_trace["outputSnapshot"] = sub_out
                    else:
                        node_trace["outputSnapshot"] = {"error": "Missing 'key' in decisionNode content"}

                elif node_type in ("actionRuleNode", "businessRuleNode", "balRuleNode"):
                    from .bal_engine import evaluate_bal_rule
                    rule_source = content.get("source") or content.get("rule") or ""
                    bal_res = evaluate_bal_rule(rule_source, context, content.get("vocabulary", graph.get("vocabulary")))
                    node_trace["outputSnapshot"] = bal_res
                    node_trace["balTrace"] = bal_res
                    assigned.update(action["target"] for action in bal_res["executedActions"])

                elif node_type in ("inferenceNode", "ruleAgendaNode"):
                    from .inference_engine import RuleAgenda
                    agenda_rules = content.get("rules", [])
                    max_cycles = content.get("maxCycles", 500)
                    agenda_res = RuleAgenda(agenda_rules, max_cycles=max_cycles,
                                            vocabulary=content.get("vocabulary", graph.get("vocabulary")),
                                            conflict_resolution=content.get("conflictResolution", "priority")).run(context)
                    node_trace["outputSnapshot"] = agenda_res
                    assigned.update(item["target"] for firing in agenda_res["firings"] for item in firing["actions"]
                                    if isinstance(item.get("target"), str) and item.get("action") in ("set", "add", "insert"))

                elif node_type == "forkNode":
                    plan = parallel_plans[nid]
                    baseline = deepcopy(context)

                    def run_branch(region):
                        if not region:
                            return {"result": deepcopy(baseline), "trace": []}
                        branch_graph = {**graph,
                                        "nodes": [item for item in graph['nodes'] if item['id'] in region],
                                        "edges": [edge for edge in edges if edge['sourceId'] in region and edge['targetId'] in region]}
                        return self.evaluate(branch_graph, baseline, _budget=budget,
                                             _parallel_depth=_parallel_depth + 1, _assigned=assigned)

                    with ThreadPoolExecutor(max_workers=min(plan['maxWorkers'], len(plan['branches'])),
                                            thread_name_prefix='decision-branch') as executor:
                        futures = [executor.submit(run_branch, region) for region in plan['branches']]
                        # Read in declaration order, not completion order, so merge
                        # policy and audit traces remain deterministic.
                        branch_results = [future.result() for future in futures]
                    context = _merge_parallel_results(baseline,
                                                      [result['result'] for result in branch_results],
                                                      plan['mergePolicy'])
                    completed_parallel_nodes.update(plan['owned'])
                    for index, result in enumerate(branch_results):
                        for trace in result['trace']:
                            trace['parallelForkId'] = nid
                            trace['parallelBranch'] = index
                            branch_traces.append(trace)
                    node_trace["outputSnapshot"] = deepcopy(baseline)
                    node_trace["parallelTrace"] = {"joinId": plan['joinId'],
                                                  "branchCount": len(plan['branches']),
                                                  "maxWorkers": plan['maxWorkers'],
                                                  "mergePolicy": plan['mergePolicy']}

                elif node_type == "joinNode":
                    # Concurrency Join: synchronizes convergent branches
                    node_trace["outputSnapshot"] = deepcopy(context)

                elif node_type == "outputNode":
                    reached_output = True
                    schema = content.get("schema")
                    published = self._without_caller_decisions(deepcopy(context), graph, input_data, assigned)
                    if schema and isinstance(schema, list):
                        final_result = {k: get_by_path(published, k) for k in schema}
                    elif schema and isinstance(schema, dict) and ("type" in schema or "properties" in schema or "required" in schema):
                        schema_errors = validate_json_schema(context, schema, path="response")
                        if schema_errors:
                            raise ValueError(f"Output schema validation failed: {'; '.join(schema_errors)}")
                        allowed = _output_schema_allows(schema)
                        final_result = {k: v for k, v in published.items() if allowed is None or k in allowed}
                    else:
                        final_result = published
                    node_trace["outputSnapshot"] = final_result

            except Exception as ex:
                raise ValueError(f"Decision node {nid} could not be evaluated: {ex}") from None

            n_end = time.perf_counter_ns()
            node_trace["durationMicros"] = round((n_end - n_start) / 1000, 2)
            node_traces.append(deepcopy(node_trace))
            node_traces.extend(branch_traces)

        validate_vocabulary_values(context, graph.get("vocabulary"), check_required=False)
        total_time_ns = time.perf_counter_ns() - start_time_ns
        total_time_micros = round(total_time_ns / 1000, 2)

        # A graph with an output node publishes only through it, even when no path reached it.
        if has_output:
            result = final_result
        elif _budget is None:
            result = self._without_caller_decisions(context, graph, input_data, assigned)
        else:
            result = context
        return {
            "result": deepcopy(result),
            "reachedOutput": reached_output or not has_output,
            "performance": {
                "durationMicros": total_time_micros,
                "durationMillis": round(total_time_micros / 1000, 4),
                "nodesExecuted": len(node_traces),
            },
            "trace": node_traces
        }
