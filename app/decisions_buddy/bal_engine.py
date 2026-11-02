"""
DecisionsBuddy bounded prose action rules (a subset inspired by IBM BAL).
Enables authoring and executing natural language business rules without code:

Example:
    definitions
        set discount_threshold to 100;
    if
        the age of customer is at least 18
        and cart.total is greater than discount_threshold
    then
        set order.discount to 0.15;
        set order.approved to true;
        add "Qualified for standard discount" to order.messages;
    else
        set order.discount to 0.0;
        set order.approved to false;
"""

import re
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple
from .safe_expression import evaluate as safe_evaluate
from .vocabulary import replace_terms, validate_vocabulary_values
from .decision_engine import BUILTINS, get_by_path, set_by_path, parse_literal


# Quoted values are opaque: language keywords and semicolons inside them are data.
_QUOTED = r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')'''


def _action_parts(line, *, strict=False):
    """Split action syntax without retrying expressions at every whitespace."""
    command = re.match(r'(set|add)\s+', line, re.IGNORECASE)
    if not command:
        return None
    operation = command[1].lower()
    body = line[command.end():]
    if operation == 'set':
        pieces = body.split(None, 2)
        if len(pieces) != 3 or pieces[1].lower() != 'to':
            return None
        target, _, expression = pieces
    else:
        pieces = body.rsplit(None, 2)
        if len(pieces) != 3 or pieces[1].lower() != 'to':
            return None
        expression, _, target = pieces
    path = r'[A-Za-z]\w*(?:\.[A-Za-z]\w*)*' if strict else r'[\w.]+'
    if '\n' in expression or not re.fullmatch(path, target):
        return None
    return operation, target, expression


def split_statements(text: str) -> List[str]:
    parts = []
    start = 0
    for match in re.finditer(_QUOTED + r"|;", text):
        if match.group() == ";":
            if text[start:match.start()].strip():
                parts.append(text[start:match.start()].strip())
            start = match.end()
    if text[start:].strip():
        parts.append(text[start:].strip())
    return parts


def verbalize_to_expression(text: str, vocabulary=None) -> str:
    return ''.join(part if index % 2 else _verbalize_unquoted(replace_terms(part, vocabulary))
                   for index, part in enumerate(re.split('(' + _QUOTED + ')', text)))


def _verbalize_unquoted(text: str) -> str:
    """
    Translates IBM ODM Business Action Language (BAL) phrases into declarative AST expressions.
    """
    s = text

    # Verbalized attribute access: "the <attr> of [the] <obj>" -> "<obj>.<attr>"
    # Example: "the age of customer" -> "customer.age", "the credit score of the applicant" -> "applicant.creditScore"
    s = re.sub(
        r"\bthe\s+([a-zA-Z_]\w*)\s+of\s+(?:the\s+)?([a-zA-Z_]\w*)\b",
        r"\2.\1",
        s,
        flags=re.IGNORECASE
    )

    # Membership must be replaced before the generic "is" comparison.
    s = re.sub(r"\bis\s+not\s+(?:one\s+of|in)\b", "not in", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+(?:one\s+of|in)\b", "in", s, flags=re.IGNORECASE)

    # Comparison verbalizations
    s = re.sub(r"\bis\s+greater\s+than\s+or\s+equal\s+to\b", ">=", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+less\s+than\s+or\s+equal\s+to\b", "<=", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+at\s+least\b", ">=", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+at\s+most\b", "<=", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+greater\s+than\b", ">", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+less\s+than\b", "<", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+equal\s+to\b", "==", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+not\s+equal\s+to\b", "!=", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+not\b", "!=", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\b", "==", s, flags=re.IGNORECASE)

    # In / membership verbalizations
    s = re.sub(r"\bis\s+one\s+of\b", "in", s, flags=re.IGNORECASE)
    s = re.sub(r"\bis\s+in\b", "in", s, flags=re.IGNORECASE)

    return s


def parse_action_statement(action_line: str, context: Dict[str, Any], vocabulary=None) -> Tuple[str, str, Any]:
    """
    Parses a single BAL action statement:
    - 'set <path> to <expr>'
    - 'add <expr> to <path>'
    """
    line = ''.join(part if index % 2 else replace_terms(part, vocabulary)
                   for index, part in enumerate(re.split('(' + _QUOTED + ')', action_line))).strip().rstrip(";")
    if not line:
        return ("noop", "", None)

    action = _action_parts(line)
    if action:
        operation, target_path, expression = action
        expr_str = verbalize_to_expression(expression.strip())
        val = safe_evaluate(expr_str, context, BUILTINS)
        return (operation, target_path, val)

    raise ValueError(f"Unrecognized BAL action statement: '{line}'")


def action_target(statement, vocabulary=None):
    """The field a set or add statement writes, without evaluating it."""
    line = ''.join(part if index % 2 else replace_terms(part, vocabulary)
                   for index, part in enumerate(re.split('(' + _QUOTED + ')', statement))).strip().rstrip(";")
    action = _action_parts(line) if line else None
    return action[1] if action else None


def parse_bal_sections(rule_text):
    if not isinstance(rule_text, str) or not rule_text.strip() or len(rule_text) > 16384:
        raise ValueError("Provide action-rule text of at most 16384 characters")
    lines = [line.strip() for line in rule_text.strip().splitlines() if line.strip() and not line.strip().startswith(("#", "//"))]
    full_text = " ".join(lines)

    # Sections: definitions (optional), if, then, else (optional)
    definitions_part = ""
    if_part = ""
    then_part = ""
    else_part = ""

    # Recognize section keywords outside quoted strings only.
    sections = []
    for match in re.finditer(_QUOTED + r"|\b(?:definitions|if|then|else)\b", full_text, re.IGNORECASE):
        if match.group()[0] not in ("'", '"'):
            sections.append((match.group().lower(), match.start(), match.end()))
    names = [item[0] for item in sections]
    if names not in (['if', 'then'], ['if', 'then', 'else'],
                     ['definitions', 'if', 'then'], ['definitions', 'if', 'then', 'else'], ['then']):
        raise ValueError("Invalid action rule: expected [definitions] if ... then ... [else ...]")
    if full_text[:sections[0][1]].strip():
        raise ValueError("Unexpected text before action rule")
    bodies = {}
    for index, (name, _, body_start) in enumerate(sections):
        body_end = sections[index + 1][1] if index + 1 < len(sections) else len(full_text)
        bodies[name] = full_text[body_start:body_end].strip()
        if not bodies[name]:
            raise ValueError(f"Empty action rule section: {name}")
    return bodies



def validate_bal_rule(rule_text, vocabulary=None):
    """Compile the supported grammar without running business actions."""
    import ast
    from .vocabulary import validate_vocabulary
    validate_vocabulary(vocabulary)
    bodies = parse_bal_sections(rule_text)
    expressions = [verbalize_to_expression(bodies.get('if', 'true'), vocabulary)]
    count = 0
    for section in ('definitions', 'then', 'else'):
        for statement in split_statements(bodies.get(section, '')):
            count += 1
            line = ''.join(part if index % 2 else replace_terms(part, vocabulary)
                           for index, part in enumerate(re.split('(' + _QUOTED + ')', statement)))
            action = _action_parts(line, strict=True)
            if not action or action[0] == 'add' and section == 'definitions':
                raise ValueError('Use set actions in definitions and set/add actions in then/else')
            expressions.append(verbalize_to_expression(action[2], vocabulary))
    if count > 100:
        raise ValueError('Use at most 100 action statements per business rule')
    allowed = (ast.Expression, ast.Constant, ast.Name, ast.Load, ast.Attribute, ast.Subscript,
               ast.List, ast.Tuple, ast.Dict, ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div,
               ast.FloorDiv, ast.Mod, ast.UnaryOp, ast.Not, ast.USub, ast.UAdd,
               ast.BoolOp, ast.And, ast.Or, ast.Compare, ast.Eq, ast.NotEq, ast.Lt,
               ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Is, ast.IsNot, ast.IfExp, ast.Call)
    for expression in expressions:
        if len(expression) > 2048:
            raise ValueError('Business-rule expression length limit exceeded')
        try:
            tree = ast.parse(expression, mode='eval')
        except SyntaxError as error:
            raise ValueError('Invalid business-rule expression') from error
        nodes = list(ast.walk(tree))
        if len(nodes) > 256 or any(not isinstance(node, allowed) for node in nodes):
            raise ValueError('Only bounded declarative business-rule expressions are supported')
        for node in nodes:
            if isinstance(node, ast.Name) and node.id.startswith('_') or isinstance(node, ast.Attribute) and node.attr.startswith('_'):
                raise ValueError('Private identifiers are not allowed')
            if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in BUILTINS or node.keywords or len(node.args) > 16):
                raise ValueError('Only approved expression functions are allowed')
    return bodies


def evaluate_bal_rule(rule_text: str, context: Dict[str, Any], vocabulary=None) -> Dict[str, Any]:
    """
    Parses and evaluates the supported prose action-rule subset.
    Returns trace dict with matched status and executed actions.
    """
    if not isinstance(context, dict):
        raise ValueError("Action-rule context must be an object")
    if not isinstance(rule_text, str) or len(rule_text) > 16384:
        raise ValueError("Action-rule text must be at most 16384 characters")
    validate_vocabulary_values(context, vocabulary)
    bodies = validate_bal_rule(rule_text, vocabulary)
    definitions_part = bodies.get('definitions', '')
    if_part = bodies.get('if', 'true')
    then_part = bodies['then']
    else_part = bodies.get('else', '')

    # 1. Execute definitions
    working_ctx = deepcopy(context)
    action_ctx = deepcopy(context)
    if definitions_part:
        def_statements = split_statements(definitions_part)
        for stmt in def_statements:
            op, path, val = parse_action_statement(stmt, working_ctx, vocabulary)
            if op == "set":
                set_by_path(working_ctx, path, val)

    # 2. Evaluate 'if' condition
    cond_expr = verbalize_to_expression(if_part, vocabulary)
    cond_passed = bool(safe_evaluate(cond_expr, working_ctx, BUILTINS))

    executed_actions = []
    # 3. Execute 'then' or 'else'
    target_part = then_part if cond_passed else else_part
    if target_part:
        statements = split_statements(target_part)
        for stmt in statements:
            op, path, val = parse_action_statement(stmt, working_ctx, vocabulary)
            if op == "set":
                set_by_path(action_ctx, path, deepcopy(val))
                set_by_path(working_ctx, path, val)
                executed_actions.append({"action": "set", "target": path, "value": val})
            elif op == "add":
                existing = get_by_path(action_ctx, path)
                if not isinstance(existing, list):
                    existing = [existing] if existing is not None else []
                existing.append(val)
                set_by_path(action_ctx, path, existing)
                set_by_path(working_ctx, path, existing)
                executed_actions.append({"action": "add", "target": path, "value": val})

    validate_vocabulary_values(action_ctx, vocabulary, check_required=False)
    context.clear()
    context.update(action_ctx)
    return {
        "passed": cond_passed,
        "condition": cond_expr,
        "executedActions": deepcopy(executed_actions)
    }
