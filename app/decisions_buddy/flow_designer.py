"""
Bob AI Flow Designer for DecisionsBuddy.
Synthesizes intelligent JDM decision graphs, incorporating watsonx.ai foundation models,
watsonx ML predictive deployments, decision tables, switch routers, and expressions based on natural language requirements.
"""

import json
import re
from bisect import bisect_left, bisect_right
from typing import Any, Dict, List, Optional


def _skip_space(source, position):
    while position < len(source) and source[position].isspace():
        position += 1
    return position


def _word_separator(source, *, then_only=False):
    # Comparison signs such as >= belong to the condition; only arrows and colons separate.
    pattern = r'then' if then_only else r'then|gives?|gets?|yields?|receives?|appl(?:y|ies)|->|=>|:|\s-\s'
    for match in re.finditer(pattern, source, re.IGNORECASE):
        start, end = match.span()
        if not then_only and match.group().strip() in {':', '->', '=>', '-'}:
            yield start, end
        elif start and end < len(source) and source[start - 1].isspace() and source[end].isspace():
            while start and source[start - 1].isspace():
                start -= 1
            yield start, _skip_space(source, end)


def _implicit_rule(source, *, discount=False):
    # Inspect each whitespace boundary once. Anchored action patterns only scan
    # the following numeric token, rather than retrying the whole condition.
    patterns = (r'discount\s+\d+', r'\d+\s*%') if discount else (
        r'\d+(?:\.\d+)?\s*%', r'\d+\s*(?:euro|eur|mbps|discount|pts)')
    patterns = [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    for boundary in re.finditer(r'\s+', source):
        if boundary.start() and any(pattern.match(source, boundary.end()) for pattern in patterns):
            return source[:boundary.start()].strip(), source[boundary.end():].strip()
    return None


def _fallback_rules(source):
    # Pre-index delimiters so many unfinished "if" clauses cannot repeatedly
    # scan the same suffix while looking for a "then" clause.
    openings = list(re.finditer(r'(?:if|when)\s+', source, re.IGNORECASE))
    separators = list(_word_separator(source, then_only=True))
    starts = [start for start, _ in separators]
    endings = sorted([opening.start() for opening in openings]
                     + [match.start() for match in re.finditer(r'[.;\n,]', source)]
                     + [len(source)])
    newlines = [match.start() for match in re.finditer('\n', source)]
    rules, consumed = [], 0
    for opening in openings:
        if opening.start() < consumed:
            continue
        index = bisect_right(starts, opening.end())
        if index == len(separators):
            break
        start, end = separators[index]
        newline = bisect_left(newlines, opening.end())
        if newline < len(newlines) and newlines[newline] < start:
            continue
        ending = bisect_right(endings, end)
        if ending == len(endings):
            continue
        stop = endings[ending]
        rules.append((source[opening.end():start], source[end:stop]))
        consumed = stop
    return rules


def _explicit_input_name(source):
    phrase = re.compile(r'is|are|should\s+be|field\s+is|parameter\s+is', re.IGNORECASE)
    field = re.compile(r'[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?\b')
    for opening in re.finditer(r'\binput', source, re.IGNORECASE):
        start = opening.end()
        starts = [start + 1, start] if source[start:start + 1].lower() == 's' else [start]
        for start in starts:
            position = _skip_space(source, start)
            prefix = phrase.match(source, position)
            positions = [_skip_space(source, prefix.end()), position] if prefix else [position]
            for position in positions:
                if position < len(source) and source[position] in ':=':
                    position = _skip_space(source, position + 1)
                value = field.match(source, position)
                if value:
                    return value[0]
    return None


def _trim_action(source):
    source = source.strip()
    for match in re.finditer(r'it\s+created|it\s+should|and\s+create|to\s+create|is\s+unacceptable', source, re.IGNORECASE):
        start = match.start()
        if start and source[start - 1].isspace():
            while start and source[start - 1].isspace():
                start -= 1
            return source[:start].rstrip(',.;')
    return source.rstrip(',.;')


def generate_decision_flow(prompt: str, current_graph: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Generates an intelligent JDM decision graph based on user requirements.
    Understands the JSON Decision Model (JDM) specification:
      - inputNode, decisionTableNode, watsonxAiNode, watsonxMlNode, expressionNode, switchNode, outputNode
      - Unary test expressions (>= 10, [10..20], in ['VIP'], -)
      - Hit policies (first, collect)
      - Dynamic natural language rule extraction and condition mapping
      - Branching / routing with switchNode and statement handles
      - Expression pipelines for calculations, taxes, fees, and payments
      - Multi-stage sequential decision tables
    """
    p_str = prompt.strip()
    p_lower = p_str.lower()

    # 1. Flow Topology & Capability Intent Detection
    wants_routing = any(k in p_lower for k in [
        'switch', 'route', 'routing', 'branch', 'branching', 'split', 'diverge',
        'vip', 'tier routing', 'segment', 'path', 'either', 'bifurcat', 'divergent',
        'route to', 'routes to', 'standard members route'
    ])
    wants_calc = any(k in p_lower for k in [
        'calculate', 'calculation', 'compute', 'formula', 'tax', 'fee', 'shipping',
        'payment', 'apr', 'interest', 'discount amount', 'total', 'sum', 'math',
        'expression', 'expressions', 'monthly payment'
    ])
    wants_multistage = any(k in p_lower for k in [
        'multi-stage', 'multistage', 'multi-step', 'pipeline', 'screening', 'two-step',
        'stage 1', 'stage 2', 'then evaluate in table', 'second table', 'filter then'
    ])
    wants_watsonx_ai = any(k in p_lower for k in ['watsonx.ai', 'foundation model', 'generative ai', 'llm', 'granite', 'llama'])
    wants_watsonx_ml = any(k in p_lower for k in ['watsonx ml', 'predictive', 'ml model', 'scoring deployment', 'churn risk', 'fraud score'])
    wants_watsonx = wants_watsonx_ai or wants_watsonx_ml or any(k in p_lower for k in ['watsonx', 'ai reasoning', 'ai score'])

    # 2. Extract explicit conditional rules:
    rule_patterns = []
    if_parts = re.split(r'\b(?:if|when)\s+', p_str, flags=re.IGNORECASE)
    if len(if_parts) > 1:
        for part in if_parts[1:]:
            part = part.strip()
            part = re.split(r'\.(?!\d)|[;\n]|(?:\bit\s+created|\bit\s+should|\bto\s+create|\bis\s+unacceptable)', part, flags=re.IGNORECASE)[0].strip()
            if not part:
                continue
            separator = next(_word_separator(part), None)
            if separator:
                cond_str = part[:separator[0]].strip()
                act_str = part[separator[1]:].strip()
                if cond_str and act_str:
                    rule_patterns.append((cond_str, act_str))
                    continue
            implicit = _implicit_rule(part)
            if implicit:
                rule_patterns.append(implicit)
                continue
            discount = _implicit_rule(part, discount=True)
            if discount:
                rule_patterns.append(discount)
                continue

    if not rule_patterns:
        rule_patterns = _fallback_rules(p_str)

    # 3. Check for curated presets if no explicit if-then rules are specified
    if not rule_patterns:
        if 'retention' in p_lower or ('churn' in p_lower and 'watsonx' in p_lower):
            return _preset_churn_retention()
        if 'fraud' in p_lower and ('triage' in p_lower or 'anomaly' in p_lower):
            return _preset_fraud_triage()
        if 'underwriting' in p_lower and 'loan' in p_lower:
            return _preset_loan_underwriting()
        if wants_routing and ('loyalty' in p_lower or 'tier' in p_lower or 'vip' in p_lower):
            return _preset_vip_routing()
        if wants_calc and ('order' in p_lower or 'cart' in p_lower or 'ecommerce' in p_lower or 'tax' in p_lower):
            return _preset_ecommerce_pricing()

    # 4. Domain & Entity Detection
    is_topup = any(k in p_lower for k in ['topup', 'top-up', 'topups', 'recharge', 'credit load'])
    is_discount = any(k in p_lower for k in ['discount', 'bonus', 'promo', 'rebate', '%', 'percent', 'voucher'])
    has_customer = any(k in p_lower for k in ['customer', 'user', 'client', 'subscriber', 'member', 'account'])
    is_new_customer = any(k in p_lower for k in ['new customer', 'new user', 'new subscriber', 'new client', 'onboarding'])

    explicit_name = _explicit_input_name(p_str)
    if explicit_name and explicit_name.lower() in ['a', 'the', 'decision', 'for', 'that', 'message', 'payload', 'json', 'data']:
        explicit_name = None

    if explicit_name:
        cond_field = explicit_name
        cond_name = explicit_name.replace('_', ' ').title()
        test_val = 30
        flow_title = f'{cond_name} Decision Policy'
    elif is_topup:
        cond_field = 'topupAmount'
        cond_name = 'Topup Amount (€)'
        test_val = 20
        flow_title = 'Customer Topup Promotional Discount'
    elif re.search(r'\b(?:credit|score|fico|loan|mortgage|underwriting)\b', p_lower):
        cond_field = 'creditScore'
        cond_name = 'Credit Score'
        test_val = 720
        flow_title = 'Credit Assessment & Eligibility'
    elif re.search(r'\b(?:spend|cart|order|purchase|bill|euro|euros|€|\$|amount|price)\b', p_lower):
        cond_field = 'amount'
        cond_name = 'Amount (€)'
        test_val = 50
        flow_title = 'Promotional Discount Policy' if is_discount else 'Pricing & Discount Policy'
    elif re.search(r'\b(?:age|years\s+old)\b', p_lower):
        cond_field = 'age'
        cond_name = 'Customer Age'
        test_val = 28
        flow_title = 'Age-Based Policy Gate'
    elif re.search(r'\b(?:tier|loyalty|level|vip)\b', p_lower):
        cond_field = 'customer.tier'
        cond_name = 'Customer Tier'
        test_val = 'VIP'
        flow_title = 'Loyalty Tier Benefits'
    else:
        cond_field = 'value'
        cond_name = 'Input Value'
        test_val = 25
        flow_title = 'Business Decision Flow'

    # Determine primary output field
    if is_discount or wants_calc:
        out_field = 'discountPercent'
        out_name = 'Discount (%)'
        out_type = 'number'
    elif any(k in p_lower for k in ['speed', 'mbps', 'bandwidth']):
        out_field = 'speedMbps'
        out_name = 'Speed (Mbps)'
        out_type = 'number'
    elif any(k in p_lower for k in ['apr', 'rate', 'interest']):
        out_field = 'interestRate'
        out_name = 'Interest Rate (%)'
        out_type = 'number'
    elif any(k in p_lower for k in ['approved', 'rejected', 'decision', 'verdict', 'status']):
        out_field = 'decision'
        out_name = 'Decision'
        out_type = 'string'
    else:
        out_field = 'result'
        out_name = 'Decision Result'
        out_type = 'string'

    inputs = [{'id': 'in_1', 'field': cond_field, 'name': cond_name}]
    if is_new_customer:
        inputs.append({'id': 'in_cust', 'field': 'customer.isNew', 'name': 'Is New Customer'})
    elif has_customer and cond_field != 'customer.tier':
        inputs.append({'id': 'in_cust', 'field': 'customer.tier', 'name': 'Customer Tier'})

    outputs = [
        {'id': 'out_1', 'field': out_field, 'name': out_name},
        {'id': 'out_status', 'field': 'status', 'name': 'Status'}
    ]

    # 5. Parse Rules or Synthesize from Patterns
    rules = []
    if rule_patterns:
        extracted = []
        for idx, (cond_str, act_str) in enumerate(rule_patterns):
            cond_str = cond_str.strip()
            act_clean = _trim_action(act_str)

            c_nums = re.findall(r'(\d+(?:\.\d+)?)', cond_str)
            comp_match = re.search(r'(>=|<=|>|<|!=|==|=)', cond_str)

            if comp_match and c_nums:
                op = comp_match.group(1)
                val_s = c_nums[0]
                unary = f'{op} {val_s}'
                sort_val = float(val_s)
            elif c_nums:
                val_s = c_nums[0]
                unary = f'>= {val_s}'
                sort_val = float(val_s)
            else:
                is_match = re.search(r'(?:is|=)\s+([A-Za-z0-9_]+)', cond_str, re.IGNORECASE)
                val_s = is_match.group(1) if is_match else cond_str
                unary = f'"{val_s}"'
                sort_val = 0.0

            a_nums = re.findall(r'(\d+(?:\.\d+)?)', act_clean)
            if a_nums and out_type == 'number':
                act_val = int(a_nums[0]) if a_nums[0].isdigit() else float(a_nums[0])
                status_val = 'PROMO_APPLIED' if is_discount else 'APPROVED'
            elif any(k in act_clean.lower() for k in ['approve', 'grant', 'allow', 'eligible']):
                act_val = 'APPROVED'
                status_val = 'ELIGIBLE'
            elif any(k in act_clean.lower() for k in ['reject', 'decline', 'deny']):
                act_val = 'DECLINED'
                status_val = 'INELIGIBLE'
            else:
                # Free text must be a quoted literal in a decision table cell.
                act_val = a_nums[0] if a_nums else json.dumps(act_clean)
                status_val = 'APPLIED'

            r_obj = {
                '_id': f'r{idx + 1}',
                '_description': f'{cond_str} -> {act_clean}'[:65],
                'in_1': unary,
                'out_1': act_val,
                'out_status': status_val
            }
            if is_new_customer:
                r_obj['in_cust'] = 'true'
            elif has_customer and cond_field != 'customer.tier':
                r_obj['in_cust'] = '-'

            extracted.append((sort_val, r_obj))

        extracted.sort(key=lambda x: x[0], reverse=True)
        rules = []
        for r_i, (_, item) in enumerate(extracted):
            item['_id'] = f'r{r_i + 1}'
            rules.append(item)
        if extracted and extracted[0][0] > 0:
            test_val = int(extracted[min(1, len(extracted) - 1)][0])

        fb = {
            '_id': f'r{len(rules) + 1}',
            '_description': 'Default / Fallback rule',
            'in_1': '-',
            'out_1': 0 if out_type == 'number' else 'STANDARD',
            'out_status': 'STANDARD'
        }
        if is_new_customer or (has_customer and cond_field != 'customer.tier'):
            fb['in_cust'] = '-'
        rules.append(fb)
    else:
        rules = [
            {'_id': 'r1', '_description': 'High Tier Threshold', 'in_1': '>= 50', 'out_1': 20 if out_type == 'number' else 'APPROVED', 'out_status': 'TIER_1'},
            {'_id': 'r2', '_description': 'Standard Base', 'in_1': '< 50', 'out_1': 5 if out_type == 'number' else 'STANDARD', 'out_status': 'STANDARD'}
        ]

    # 6. Build JDM Graph Layout according to Flow Topology
    if wants_routing:
        return _build_routing_decision_flow(
            title=f"{flow_title} with Switch Router",
            prompt=prompt,
            cond_field=cond_field,
            cond_name=cond_name,
            test_val=test_val,
            out_field=out_field,
            out_name=out_name,
            out_type=out_type,
            has_customer=has_customer,
            wants_watsonx=wants_watsonx,
            wants_watsonx_ml=wants_watsonx_ml,
            requested_rules=rules if rule_patterns else None
        )

    if wants_multistage:
        return _build_multistage_decision_flow(
            title=f"Multi-Stage {flow_title}",
            cond_field=cond_field,
            cond_name=cond_name,
            test_val=test_val,
            out_field=out_field,
            out_name=out_name,
            requested_rules=rules if rule_patterns else None
        )

    # Standard linear or calculation-augmented pipeline
    nodes = []
    edges = []
    x_pos = 100

    nodes.append({
        'id': 'node_input',
        'name': 'Customer Request Input' if has_customer else 'Request Input',
        'type': 'inputNode',
        'position': {'x': x_pos, 'y': 160},
        'content': {}
    })
    prev_node_id = 'node_input'
    x_pos += 260

    if wants_watsonx:
        wx_type = 'watsonxMlNode' if wants_watsonx_ml else 'watsonxAiNode'
        wx_id = 'node_watsonx'
        wx_name = 'watsonx ML Predictive Scorer' if wants_watsonx_ml else 'watsonx.ai Foundation Reasoning'

        wx_content = {
            'endpoint': 'https://us-south.ml.cloud.ibm.com',
            'outputField': 'mlScore' if wants_watsonx_ml else 'aiRecommendation'
        }
        if wants_watsonx_ml:
            wx_content.update({
                'deploymentId': 'deployment-scoring-v1',
                'scoringType': 'classification',
                'inputMapping': {cond_field: cond_field}
            })
        else:
            wx_content.update({
                'modelId': 'ibm/granite-13b-instruct-v2',
                'promptTemplate': f'Analyze {cond_name} with value {{{cond_field}}}. Return recommendation.'
            })

        nodes.append({
            'id': wx_id,
            'name': wx_name,
            'type': wx_type,
            'position': {'x': x_pos, 'y': 160},
            'content': wx_content
        })
        edges.append({'id': f'e_{prev_node_id}_{wx_id}', 'sourceId': prev_node_id, 'targetId': wx_id})
        prev_node_id = wx_id
        x_pos += 260

        wx_field = 'mlScore.prediction' if wants_watsonx_ml else 'aiRecommendation.recommendation'
        inputs.append({'id': 'in_wx', 'field': wx_field, 'name': 'AI/ML Output'})
        for r in rules:
            r['in_wx'] = '-'

    # Decision Table Node
    table_id = 'node_decision_table'
    nodes.append({
        'id': table_id,
        'name': 'Discount Policy Rules' if is_discount else 'Decision Policy Rules',
        'type': 'decisionTableNode',
        'position': {'x': x_pos, 'y': 160},
        'content': {
            'hitPolicy': 'first',
            'inputs': inputs,
            'outputs': outputs,
            'rules': rules
        }
    })
    edges.append({'id': f'e_{prev_node_id}_{table_id}', 'sourceId': prev_node_id, 'targetId': table_id})
    prev_node_id = table_id
    x_pos += 280

    # Optional Expression Calculation Node
    out_schema = [o['field'] for o in outputs]
    if wants_calc:
        expr_id = 'node_calc_expr'
        calc_expressions = [
            {'key': 'discountAmount', 'value': f'round({cond_field} * (coalesce({out_field}, 0) / 100), 2)'},
            {'key': 'finalTotal', 'value': f'round({cond_field} - ({cond_field} * (coalesce({out_field}, 0) / 100)), 2)'}
        ]
        nodes.append({
            'id': expr_id,
            'name': 'Pricing & Tax Calculator',
            'type': 'expressionNode',
            'position': {'x': x_pos, 'y': 160},
            'content': {'expressions': calc_expressions}
        })
        edges.append({'id': f'e_{prev_node_id}_{expr_id}', 'sourceId': prev_node_id, 'targetId': expr_id})
        prev_node_id = expr_id
        x_pos += 280
        out_schema.extend(['discountAmount', 'finalTotal'])

    # Output Node
    out_id = 'node_output'
    nodes.append({
        'id': out_id,
        'name': 'Decision Response',
        'type': 'outputNode',
        'position': {'x': x_pos, 'y': 160},
        'content': {'schema': out_schema}
    })
    edges.append({'id': f'e_{prev_node_id}_{out_id}', 'sourceId': prev_node_id, 'targetId': out_id})

    # Default Input Context
    default_input = {cond_field: test_val}
    if is_new_customer:
        default_input['customer'] = {'id': 'CUST-1001', 'isNew': True}
    elif has_customer and cond_field != 'customer.tier':
        default_input['customer'] = {'id': 'CUST-1001', 'tier': 'VIP'}

    rule_descriptions = [f"{r['_description']}" for r in rules if r['_id'] != f"r{len(rules)}"]
    rules_text = "; ".join(rule_descriptions) if rule_descriptions else f"{len(rules)} decision rules"

    return {
        'name': flow_title,
        'description': f'Evaluates {cond_name} to output {out_name}. Configured rules: {rules_text}.',
        'explanation': (
            f"Bob synthesized a JDM decision flow based on your requirements. "
            f"It extracted {len(rules)} business rule(s) into a Decision Table (hit policy: FIRST)"
            f"{', added an Expression Calculator node' if wants_calc else ''}, "
            f"configured inputs for '{cond_name}', and wired the output response."
        ),
        'defaultInput': default_input,
        'graph': {
            'nodes': nodes,
            'edges': edges
        }
    }


def _routing_rows(requested_rules):
    """The prompt's own rules, expressed in a routing branch's table columns."""
    return [{'_id': rule['_id'], '_description': rule['_description'], 'in_amt': rule['in_1'],
             'out_val': rule['out_1'], 'out_tier': rule['out_status']} for rule in requested_rules or []]


def _stage_rows(requested_rules):
    """Screening passes anything a requested rule matches; allocation applies those rules."""
    if not requested_rules:
        return None, None
    specific = [rule for rule in requested_rules if rule['in_1'] != '-']
    screening = [{'_id': f's1_r{index + 1}', '_description': rule['_description'], 'in_val': rule['in_1'],
                  'out_elig': 'YES', 'out_stage': 'PASSED_SCREENING'} for index, rule in enumerate(specific)]
    screening.append({'_id': f's1_r{len(specific) + 1}', '_description': 'No requested rule matched',
                      'in_val': '-', 'out_elig': 'NO', 'out_stage': 'REJECTED_SCREENING'})
    allocation = [{'_id': f's2_r{index + 1}', '_description': rule['_description'], 'in_elig': '"YES"',
                   'in_val2': rule['in_1'], 'out_offer': rule['out_1'], 'out_status': rule['out_status']}
                  for index, rule in enumerate(specific)]
    allocation.append({'_id': f's2_r{len(specific) + 1}', '_description': 'Default decline for ineligible',
                       'in_elig': '-', 'in_val2': '-', 'out_offer': 0, 'out_status': 'DECLINED'})
    return screening, allocation


def _build_routing_decision_flow(
    title: str,
    prompt: str,
    cond_field: str,
    cond_name: str,
    test_val: Any,
    out_field: str,
    out_name: str,
    out_type: str,
    has_customer: bool,
    wants_watsonx: bool,
    wants_watsonx_ml: bool,
    requested_rules: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """Generates a diamond/branching graph using switchNode, parallel branch nodes, and convergence into outputNode."""
    nodes = []
    edges = []

    # 1. Input Node
    nodes.append({
        'id': 'node_input',
        'name': 'Customer Request Input' if has_customer else 'Request Input',
        'type': 'inputNode',
        'position': {'x': 100, 'y': 200},
        'content': {}
    })
    prev_id = 'node_input'
    switch_x = 380

    # 2. Optional watsonx Node
    if wants_watsonx:
        wx_type = 'watsonxMlNode' if wants_watsonx_ml else 'watsonxAiNode'
        wx_id = 'node_watsonx'
        nodes.append({
            'id': wx_id,
            'name': 'watsonx ML Risk Scorer' if wants_watsonx_ml else 'watsonx.ai Foundation Reasoning',
            'type': wx_type,
            'position': {'x': 360, 'y': 200},
            'content': {
                'endpoint': 'https://us-south.ml.cloud.ibm.com',
                'outputField': 'riskScore' if wants_watsonx_ml else 'aiRecommendation'
            }
        })
        edges.append({'id': f'e_{prev_id}_{wx_id}', 'sourceId': prev_id, 'targetId': wx_id})
        prev_id = wx_id
        switch_x = 640

    # 3. Switch Router Node
    switch_condition = f"customer.tier == 'VIP'" if has_customer else f"{cond_field} >= {test_val}"
    nodes.append({
        'id': 'node_switch',
        'name': 'Branch Router Gate',
        'type': 'switchNode',
        'position': {'x': switch_x, 'y': 200},
        'content': {
            'hitPolicy': 'first',
            'statements': [
                {'id': 's_priority', 'condition': switch_condition},
                {'id': 's_standard', 'condition': ''}
            ]
        }
    })
    edges.append({'id': f'e_{prev_id}_node_switch', 'sourceId': prev_id, 'targetId': 'node_switch'})

    branch_x = switch_x + 280

    # 4. Upper Branch: Priority / VIP Path (y: 80)
    high_branch_id = 'node_table_priority'
    nodes.append({
        'id': high_branch_id,
        'name': 'Premier / High-Tier Matrix',
        'type': 'decisionTableNode',
        'position': {'x': branch_x, 'y': 80},
        'content': {
            'hitPolicy': 'first',
            'inputs': [{'id': 'in_amt', 'field': cond_field, 'name': cond_name}],
            'outputs': [
                {'id': 'out_val', 'field': out_field, 'name': out_name},
                {'id': 'out_tier', 'field': 'serviceTier', 'name': 'Tier'}
            ],
            'rules': _routing_rows(requested_rules) or [
                {'_id': 'r_high_1', '_description': 'Premier tier maximum benefit', 'in_amt': f'>= {test_val}', 'out_val': 25 if out_type == 'number' else 'EXECUTIVE_APPROVE', 'out_tier': 'VIP_GOLD'},
                {'_id': 'r_high_2', '_description': 'Premier base benefit', 'in_amt': '-', 'out_val': 15 if out_type == 'number' else 'VIP_APPROVE', 'out_tier': 'VIP_SILVER'}
            ]
        }
    })
    edges.append({
        'id': 'e_sw_high',
        'sourceId': 'node_switch',
        'targetId': high_branch_id,
        'sourceHandle': 's_priority'
    })

    # 5. Lower Branch: Standard / Fallback Path (y: 320)
    low_branch_id = 'node_table_standard'
    nodes.append({
        'id': low_branch_id,
        'name': 'Standard Base Policy',
        'type': 'decisionTableNode',
        'position': {'x': branch_x, 'y': 320},
        'content': {
            'hitPolicy': 'first',
            'inputs': [{'id': 'in_amt', 'field': cond_field, 'name': cond_name}],
            'outputs': [
                {'id': 'out_val', 'field': out_field, 'name': out_name},
                {'id': 'out_tier', 'field': 'serviceTier', 'name': 'Tier'}
            ],
            'rules': _routing_rows(requested_rules) or [
                {'_id': 'r_std_1', '_description': 'Standard threshold reward', 'in_amt': f'>= {test_val}', 'out_val': 10 if out_type == 'number' else 'STANDARD_APPROVE', 'out_tier': 'STANDARD_PLUS'},
                {'_id': 'r_std_2', '_description': 'Standard baseline', 'in_amt': '-', 'out_val': 0 if out_type == 'number' else 'BASE_SERVICE', 'out_tier': 'STANDARD'}
            ]
        }
    })
    edges.append({
        'id': 'e_sw_low',
        'sourceId': 'node_switch',
        'targetId': low_branch_id,
        'sourceHandle': 's_standard'
    })

    # 6. Output Node (Converges high and low branches at y: 200)
    output_x = branch_x + 280
    out_id = 'node_output'
    nodes.append({
        'id': out_id,
        'name': 'Routing Decision Verdict',
        'type': 'outputNode',
        'position': {'x': output_x, 'y': 200},
        'content': {'schema': [out_field, 'serviceTier']}
    })
    edges.append({'id': f'e_{high_branch_id}_out', 'sourceId': high_branch_id, 'targetId': out_id})
    edges.append({'id': f'e_{low_branch_id}_out', 'sourceId': low_branch_id, 'targetId': out_id})

    default_input = {
        cond_field: test_val,
        'customer': {'id': 'CUST-1001', 'tier': 'VIP', 'name': 'Valued Client'}
    }

    return {
        'name': title,
        'description': f'Branching flow using a switch router node to separate VIP/priority paths from standard flows.',
        'explanation': (
            f"Bob constructed a branching decision topology. Incoming requests pass through a Switch Router Node "
            f"evaluating '{switch_condition}'. Qualifying requests diverge to the Premier Matrix, while fallback cases "
            f"route to the Standard Base Policy, both converging back into the Output response."
        ),
        'defaultInput': default_input,
        'graph': {'nodes': nodes, 'edges': edges}
    }


def _build_multistage_decision_flow(
    title: str,
    cond_field: str,
    cond_name: str,
    test_val: Any,
    out_field: str,
    out_name: str,
    requested_rules: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """Generates a sequential multi-stage pipeline: Screening Gate Table -> Offer Matrix Table -> Output."""
    screening_rows, allocation_rows = _stage_rows(requested_rules)
    nodes = [
        {'id': 'node_input', 'name': 'Applicant Intake', 'type': 'inputNode', 'position': {'x': 100, 'y': 160}, 'content': {}},
        {'id': 'node_stage1', 'name': 'Stage 1: Eligibility Screening', 'type': 'decisionTableNode', 'position': {'x': 380, 'y': 160}, 'content': {
            'hitPolicy': 'first',
            'inputs': [{'id': 'in_val', 'field': cond_field, 'name': cond_name}],
            'outputs': [
                {'id': 'out_elig', 'field': 'isEligible', 'name': 'Eligible'},
                {'id': 'out_stage', 'field': 'evaluationStage', 'name': 'Stage Status'}
            ],
            'rules': screening_rows or [
                {'_id': 's1_r1', '_description': 'Passes high-tier screening', 'in_val': f'>= {test_val}', 'out_elig': 'YES', 'out_stage': 'PASSED_SCREENING'},
                {'_id': 's1_r2', '_description': 'Fails minimum requirements', 'in_val': '-', 'out_elig': 'NO', 'out_stage': 'REJECTED_SCREENING'}
            ]
        }},
        {'id': 'node_stage2', 'name': 'Stage 2: Tier & Offer Allocation', 'type': 'decisionTableNode', 'position': {'x': 680, 'y': 160}, 'content': {
            'hitPolicy': 'first',
            'inputs': [
                {'id': 'in_elig', 'field': 'isEligible', 'name': 'Eligible'},
                {'id': 'in_val2', 'field': cond_field, 'name': cond_name}
            ],
            'outputs': [
                {'id': 'out_offer', 'field': out_field, 'name': out_name},
                {'id': 'out_status', 'field': 'finalVerdict', 'name': 'Final Verdict'}
            ],
            'rules': allocation_rows or [
                {'_id': 's2_r1', '_description': 'Gold allocation for eligible high spend', 'in_elig': '"YES"', 'in_val2': f'>= {test_val}', 'out_offer': 25, 'out_status': 'APPROVED_GOLD'},
                {'_id': 's2_r2', '_description': 'Silver allocation for standard eligible', 'in_elig': '"YES"', 'in_val2': '-', 'out_offer': 10, 'out_status': 'APPROVED_SILVER'},
                {'_id': 's2_r3', '_description': 'Default decline for ineligible', 'in_elig': '-', 'in_val2': '-', 'out_offer': 0, 'out_status': 'DECLINED'}
            ]
        }},
        {'id': 'node_output', 'name': 'Stage Pipeline Verdict', 'type': 'outputNode', 'position': {'x': 980, 'y': 160}, 'content': {
            'schema': ['isEligible', 'evaluationStage', out_field, 'finalVerdict']
        }}
    ]
    edges = [
        {'id': 'e1', 'sourceId': 'node_input', 'targetId': 'node_stage1'},
        {'id': 'e2', 'sourceId': 'node_stage1', 'targetId': 'node_stage2'},
        {'id': 'e3', 'sourceId': 'node_stage2', 'targetId': 'node_output'}
    ]

    return {
        'name': title,
        'description': 'Multi-stage decision pipeline chaining a screening gate into an offer matrix.',
        'explanation': (
            'Bob built a multi-stage decision pipeline. Stage 1 filters and screens input eligibility, '
            'passing the output flag into Stage 2 to calculate the final offer allocation.'
        ),
        'defaultInput': {cond_field: test_val, 'applicant': {'id': 'APP-5001', 'name': 'Enterprise Client'}},
        'graph': {'nodes': nodes, 'edges': edges}
    }


def _preset_churn_retention() -> Dict[str, Any]:
    return {
        "name": "Customer Retention & watsonx ML Offer Flow",
        "description": "Predicts customer churn probability with watsonx ML and maps to tiered retention offers.",
        "defaultInput": {
            "customer": {
                "customerId": "CUST-9481",
                "accountAgeMonths": 18,
                "monthlySpend": 85.00,
                "openTickets": 2,
                "dataUsageGb": 45.5,
                "contractType": "month-to-month"
            }
        },
        "explanation": "Bob generated a customer retention pipeline that feeds customer metrics into a watsonx ML churn deployment, evaluates retention offer rules in a decision table, and formats the response.",
        "graph": {
            "nodes": [
                {"id": "node_input", "name": "Customer Account Data", "type": "inputNode", "position": {"x": 100, "y": 160}, "content": {}},
                {"id": "node_watsonx_ml", "name": "watsonx ML Churn Scorer", "type": "watsonxMlNode", "position": {"x": 360, "y": 160}, "content": {
                    "deploymentId": "deployment-churn-risk-v2",
                    "scoringType": "classification",
                    "inputMapping": {"account_age": "customer.accountAgeMonths", "monthly_spend": "customer.monthlySpend", "open_tickets": "customer.openTickets"},
                    "outputField": "mlScore"
                }},
                {"id": "node_decision_table", "name": "Retention Strategy Table", "type": "decisionTableNode", "position": {"x": 640, "y": 160}, "content": {
                    "hitPolicy": "first",
                    "inputs": [
                        {"id": "in_prob", "field": "mlScore.probability", "name": "Churn Probability"},
                        {"id": "in_spend", "field": "customer.monthlySpend", "name": "Monthly Spend"}
                    ],
                    "outputs": [
                        {"id": "out_action", "field": "strategy", "name": "Retention Strategy"},
                        {"id": "out_discount", "field": "discountPercent", "name": "Discount %"},
                        {"id": "out_perk", "field": "perk", "name": "Free Addon Perk"}
                    ],
                    "rules": [
                        {"_id": "r1", "_description": "High value at extreme risk", "in_prob": ">= 0.70", "in_spend": ">= 80", "out_action": "EXECUTIVE_OUTREACH", "out_discount": 25, "out_perk": "FREE_SPEED_BOOST"},
                        {"_id": "r2", "_description": "High risk standard tier", "in_prob": ">= 0.60", "in_spend": "-", "out_action": "DISCOUNT_OFFER", "out_discount": 20, "out_perk": "STREAMING_PASS"},
                        {"_id": "r3", "_description": "Moderate risk loyalty promo", "in_prob": "[0.35..0.59]", "in_spend": "-", "out_action": "PROACTIVE_PROMO", "out_discount": 10, "out_perk": "BONUS_DATA_10GB"},
                        {"_id": "r4", "_description": "Low risk standard retention", "in_prob": "< 0.35", "in_spend": "-", "out_action": "STANDARD_SERVICE", "out_discount": 0, "out_perk": "NONE"}
                    ]
                }},
                {"id": "node_output", "name": "Retention Decision", "type": "outputNode", "position": {"x": 920, "y": 160}, "content": {"schema": ["strategy", "discountPercent", "perk", "mlScore"]}}
            ],
            "edges": [
                {"id": "e1", "sourceId": "node_input", "targetId": "node_watsonx_ml"},
                {"id": "e2", "sourceId": "node_watsonx_ml", "targetId": "node_decision_table"},
                {"id": "e3", "sourceId": "node_decision_table", "targetId": "node_output"}
            ]
        }
    }


def _preset_fraud_triage() -> Dict[str, Any]:
    return {
        "name": "Real-time Fraud & Anomaly Triage with watsonx.ai",
        "description": "Combines watsonx.ai foundation model reasoning with a strict policy decision table.",
        "defaultInput": {
            "transaction": {
                "id": "TX-10928", "amount": 3400.00, "currency": "EUR",
                "isForeignCountry": True, "channel": "MOBILE_APP", "deviceTrustScore": 0.32
            }
        },
        "explanation": "Bob configured a watsonx.ai foundation model to assess transaction context, combined with rule tables for high-assurance fraud escalation.",
        "graph": {
            "nodes": [
                {"id": "node_input", "name": "Transaction Event", "type": "inputNode", "position": {"x": 100, "y": 160}, "content": {}},
                {"id": "node_watsonx_ai", "name": "watsonx.ai Reasoning", "type": "watsonxAiNode", "position": {"x": 360, "y": 160}, "content": {
                    "modelId": "ibm/granite-13b-instruct-v2",
                    "promptTemplate": "Analyze transaction {transaction.id} for amount {transaction.amount} EUR with foreign flag {transaction.isForeignCountry}. Provide fraudRiskScore (0 to 1).",
                    "outputField": "aiRisk"
                }},
                {"id": "node_decision_table", "name": "Fraud Gate Matrix", "type": "decisionTableNode", "position": {"x": 640, "y": 160}, "content": {
                    "hitPolicy": "first",
                    "inputs": [
                        {"id": "in_score", "field": "aiRisk.score", "name": "AI Risk Score"},
                        {"id": "in_amt", "field": "transaction.amount", "name": "Amount"}
                    ],
                    "outputs": [
                        {"id": "out_verdict", "field": "verdict", "name": "Verdict"},
                        {"id": "out_mfa", "field": "requireStepUpMfa", "name": "Require MFA"}
                    ],
                    "rules": [
                        {"_id": "r1", "_description": "Critical risk block", "in_score": ">= 0.85", "in_amt": "-", "out_verdict": "BLOCK_TRANSACTION", "out_mfa": True},
                        {"_id": "r2", "_description": "Elevated risk step-up", "in_score": ">= 0.60", "in_amt": "-", "out_verdict": "STEP_UP_CHALLENGE", "out_mfa": True},
                        {"_id": "r3", "_description": "Large amount check", "in_score": "-", "in_amt": ">= 2500", "out_verdict": "STEP_UP_CHALLENGE", "out_mfa": True},
                        {"_id": "r4", "_description": "Normal authorization", "in_score": "< 0.60", "in_amt": "< 2500", "out_verdict": "AUTO_APPROVE", "out_mfa": False}
                    ]
                }},
                {"id": "node_output", "name": "Fraud Decision Result", "type": "outputNode", "position": {"x": 920, "y": 160}, "content": {"schema": ["verdict", "requireStepUpMfa", "aiRisk"]}}
            ],
            "edges": [
                {"id": "e1", "sourceId": "node_input", "targetId": "node_watsonx_ai"},
                {"id": "e2", "sourceId": "node_watsonx_ai", "targetId": "node_decision_table"},
                {"id": "e3", "sourceId": "node_decision_table", "targetId": "node_output"}
            ]
        }
    }


def _preset_loan_underwriting() -> Dict[str, Any]:
    return {
        "name": "Underwriting Matrix with watsonx AI & ML",
        "description": "Evaluates applicant creditworthiness using watsonx ML predictive scoring and watsonx.ai qualitative checks.",
        "defaultInput": {
            "applicant": {
                "creditScore": 730, "annualIncome": 72000, "requestedLoan": 20000,
                "employmentYears": 5, "debtToIncomeRatio": 0.28
            }
        },
        "explanation": "Bob created a multi-stage decision pipeline combining watsonx ML scoring with automated underwriting matrix rules.",
        "graph": {
            "nodes": [
                {"id": "node_input", "name": "Loan Application", "type": "inputNode", "position": {"x": 100, "y": 160}, "content": {}},
                {"id": "node_watsonx_ml", "name": "watsonx ML Risk Predictor", "type": "watsonxMlNode", "position": {"x": 360, "y": 160}, "content": {
                    "deploymentId": "deployment-underwriting-ml-v1",
                    "scoringType": "classification",
                    "inputMapping": {"credit_score": "applicant.creditScore", "dti": "applicant.debtToIncomeRatio", "income": "applicant.annualIncome"},
                    "outputField": "mlRisk"
                }},
                {"id": "node_decision_table", "name": "Underwriting Tier Table", "type": "decisionTableNode", "position": {"x": 640, "y": 160}, "content": {
                    "hitPolicy": "first",
                    "inputs": [
                        {"id": "in_cs", "field": "applicant.creditScore", "name": "Credit Score"},
                        {"id": "in_dti", "field": "applicant.debtToIncomeRatio", "name": "DTI"}
                    ],
                    "outputs": [
                        {"id": "out_decision", "field": "decision", "name": "Underwriting Decision"},
                        {"id": "out_rate", "field": "interestRate", "name": "Interest Rate %"},
                        {"id": "out_tier", "field": "riskTier", "name": "Tier"}
                    ],
                    "rules": [
                        {"_id": "r1", "_description": "Prime Tier Approval", "in_cs": ">= 740", "in_dti": "<= 0.35", "out_decision": "APPROVED", "out_rate": 5.75, "out_tier": "PRIME"},
                        {"_id": "r2", "_description": "Near Prime Approval", "in_cs": ">= 680", "in_dti": "<= 0.42", "out_decision": "APPROVED", "out_rate": 7.45, "out_tier": "NEAR_PRIME"},
                        {"_id": "r3", "_description": "Manual Review Tier", "in_cs": ">= 620", "in_dti": "<= 0.48", "out_decision": "MANUAL_REVIEW", "out_rate": 10.25, "out_tier": "SUBPRIME"},
                        {"_id": "r4", "_description": "Decline High Risk", "in_cs": "< 620", "in_dti": "-", "out_decision": "DECLINED", "out_rate": 0, "out_tier": "DECLINED"}
                    ]
                }},
                {"id": "node_output", "name": "Underwriting Response", "type": "outputNode", "position": {"x": 920, "y": 160}, "content": {"schema": ["decision", "riskTier", "interestRate", "mlRisk"]}}
            ],
            "edges": [
                {"id": "e1", "sourceId": "node_input", "targetId": "node_watsonx_ml"},
                {"id": "e2", "sourceId": "node_watsonx_ml", "targetId": "node_decision_table"},
                {"id": "e3", "sourceId": "node_decision_table", "targetId": "node_output"}
            ]
        }
    }


def _preset_vip_routing() -> Dict[str, Any]:
    return {
        "name": "Customer Tier VIP Switch Router Flow",
        "description": "Routes incoming customer transactions via a switch router into dedicated VIP perks and standard policy branches.",
        "defaultInput": {
            "customer": {
                "id": "CUST-9012",
                "tier": "VIP",
                "totalSpend": 1250.00,
                "membershipYears": 3
            }
        },
        "explanation": "Bob created a branching decision architecture. A switch node routes VIP members to a dedicated VIP benefits table and standard members to a baseline policy.",
        "graph": {
            "nodes": [
                {"id": "node_input", "name": "Customer Intake", "type": "inputNode", "position": {"x": 100, "y": 200}, "content": {}},
                {"id": "node_switch", "name": "Loyalty Switch Router", "type": "switchNode", "position": {"x": 380, "y": 200}, "content": {
                    "hitPolicy": "first",
                    "statements": [
                        {"id": "s_vip", "condition": "customer.tier == 'VIP'"},
                        {"id": "s_standard", "condition": ""}
                    ]
                }},
                {"id": "node_vip_table", "name": "VIP Premier Benefits", "type": "decisionTableNode", "position": {"x": 660, "y": 80}, "content": {
                    "hitPolicy": "first",
                    "inputs": [{"id": "in_spend", "field": "customer.totalSpend", "name": "Total Spend"}],
                    "outputs": [
                        {"id": "out_disc", "field": "discountPercent", "name": "Discount %"},
                        {"id": "out_perk", "field": "loyaltyPerk", "name": "Perk"}
                    ],
                    "rules": [
                        {"_id": "r_v1", "_description": "Diamond VIP (>= 1000 EUR)", "in_spend": ">= 1000", "out_disc": 25, "out_perk": "CONCIERGE_ACCESS"},
                        {"_id": "r_v2", "_description": "Standard VIP (< 1000 EUR)", "in_spend": "-", "out_disc": 15, "out_perk": "PRIORITY_SUPPORT"}
                    ]
                }},
                {"id": "node_std_table", "name": "Standard Customer Policy", "type": "decisionTableNode", "position": {"x": 660, "y": 320}, "content": {
                    "hitPolicy": "first",
                    "inputs": [{"id": "in_spend", "field": "customer.totalSpend", "name": "Total Spend"}],
                    "outputs": [
                        {"id": "out_disc", "field": "discountPercent", "name": "Discount %"},
                        {"id": "out_perk", "field": "loyaltyPerk", "name": "Perk"}
                    ],
                    "rules": [
                        {"_id": "r_s1", "_description": "Standard frequent shopper (>= 500 EUR)", "in_spend": ">= 500", "out_disc": 5, "out_perk": "FREE_SHIPPING"},
                        {"_id": "r_s2", "_description": "Standard base (< 500 EUR)", "in_spend": "-", "out_disc": 0, "out_perk": "NONE"}
                    ]
                }},
                {"id": "node_output", "name": "Loyalty Benefits Response", "type": "outputNode", "position": {"x": 960, "y": 200}, "content": {
                    "schema": ["discountPercent", "loyaltyPerk"]
                }}
            ],
            "edges": [
                {"id": "e_in_sw", "sourceId": "node_input", "targetId": "node_switch"},
                {"id": "e_sw_vip", "sourceId": "node_switch", "targetId": "node_vip_table", "sourceHandle": "s_vip"},
                {"id": "e_sw_std", "sourceId": "node_switch", "targetId": "node_std_table", "sourceHandle": "s_standard"},
                {"id": "e_vip_out", "sourceId": "node_vip_table", "targetId": "node_output"},
                {"id": "e_std_out", "sourceId": "node_std_table", "targetId": "node_output"}
            ]
        }
    }


def _preset_ecommerce_pricing() -> Dict[str, Any]:
    return {
        "name": "E-Commerce Pricing & Tax Expression Pipeline",
        "description": "Calculates promotional discounts with a decision table, chained to an expression node that computes sales tax, delivery charges, and final order total.",
        "defaultInput": {
            "cart": {
                "total": 120.00,
                "itemCount": 4,
                "couponCode": "PROMO20"
            }
        },
        "explanation": "Bob synthesized an e-commerce pricing flow. First, a decision table evaluates cart rules to determine discount percent. Next, an Expression Calculation node computes exact tax and final total before returning the response.",
        "graph": {
            "nodes": [
                {"id": "node_input", "name": "Cart Order Intake", "type": "inputNode", "position": {"x": 100, "y": 160}, "content": {}},
                {"id": "node_table_promo", "name": "Promotional Discount Table", "type": "decisionTableNode", "position": {"x": 380, "y": 160}, "content": {
                    "hitPolicy": "first",
                    "inputs": [
                        {"id": "in_code", "field": "cart.couponCode", "name": "Coupon Code"},
                        {"id": "in_tot", "field": "cart.total", "name": "Cart Total"}
                    ],
                    "outputs": [
                        {"id": "out_disc", "field": "discountPercent", "name": "Discount %"},
                        {"id": "out_free_ship", "field": "freeShipping", "name": "Free Shipping"}
                    ],
                    "rules": [
                        {"_id": "r1", "_description": "PROMO20 coupon code", "in_code": '"PROMO20"', "in_tot": "-", "out_disc": 20, "out_free_ship": True},
                        {"_id": "r2", "_description": "High value cart (>= 100 EUR)", "in_code": "-", "in_tot": ">= 100", "out_disc": 10, "out_free_ship": True},
                        {"_id": "r3", "_description": "Base cart under 100 EUR", "in_code": "-", "in_tot": "< 100", "out_disc": 0, "out_free_ship": False}
                    ]
                }},
                {"id": "node_expr_calc", "name": "Financial Calculations", "type": "expressionNode", "position": {"x": 660, "y": 160}, "content": {
                    "expressions": [
                        {"key": "discountAmount", "value": "round(cart.total * (discountPercent / 100), 2)"},
                        {"key": "shippingFee", "value": "freeShipping ? 0.0 : 4.95"},
                        {"key": "taxAmount", "value": "round((cart.total - (cart.total * (discountPercent / 100))) * 0.19, 2)"},
                        {"key": "finalTotal", "value": "round((cart.total - (cart.total * (discountPercent / 100))) + taxAmount + shippingFee, 2)"}
                    ]
                }},
                {"id": "node_output", "name": "Order Pricing Summary", "type": "outputNode", "position": {"x": 940, "y": 160}, "content": {
                    "schema": ["discountPercent", "freeShipping", "discountAmount", "taxAmount", "shippingFee", "finalTotal"]
                }}
            ],
            "edges": [
                {"id": "e1", "sourceId": "node_input", "targetId": "node_table_promo"},
                {"id": "e2", "sourceId": "node_table_promo", "targetId": "node_expr_calc"},
                {"id": "e3", "sourceId": "node_expr_calc", "targetId": "node_output"}
            ]
        }
    }
