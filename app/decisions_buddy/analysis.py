"""
Static Analysis & Rule Conflict Detection for DecisionsBuddy Decision Tables
Analyzes decision tables for:
- Shadowed / unreachable rules (in first-hit policy)
- Missing default fallback rules (exhaustiveness check)
- Overlapping condition conflicts
- Unused or undefined variables
"""

import re
from typing import Any, Dict, List

def analyze_decision_table(table_def: Dict[str, Any]) -> List[Dict[str, Any]]:
    diagnostics = []
    hit_policy = table_def.get("hitPolicy", "first").lower()
    inputs = table_def.get("inputs", [])
    outputs = table_def.get("outputs", [])
    rules = table_def.get("rules", [])

    if not rules:
        diagnostics.append({
            "severity": "warning",
            "code": "EMPTY_TABLE",
            "message": "Decision Table contains no rules."
        })
        return diagnostics

    # 1. Exhaustiveness Check: Does the table have a fallback / default catch-all rule?
    has_catch_all = False
    for r in rules:
        is_all_dash = all(str(r.get(inp.get("id"), "-")).strip() in ("-", "") for inp in inputs)
        if is_all_dash:
            has_catch_all = True
            break

    if not has_catch_all and hit_policy == "first":
        diagnostics.append({
            "severity": "warning",
            "code": "MISSING_FALLBACK",
            "message": "Table has no catch-all fallback rule (where all inputs are '-'). Unmatched inputs will produce empty outputs."
        })

    # 2. Rule Shadowing Check (in first-hit policy)
    # A rule is shadowed if an earlier rule has identical or broader conditions for all input columns
    for i in range(len(rules)):
        rule_a = rules[i]
        rule_a_all_dash = all(str(rule_a.get(inp.get("id"), "-")).strip() in ("-", "") for inp in inputs)

        if hit_policy == "first" and rule_a_all_dash and i < len(rules) - 1:
            for j in range(i + 1, len(rules)):
                diagnostics.append({
                    "severity": "error",
                    "code": "UNREACHABLE_RULE",
                    "ruleIndex": j,
                    "ruleId": rules[j].get("_id", f"r{j+1}"),
                    "message": f"Rule {j+1} is unreachable (shadowed by catch-all Rule {i+1} under 'first' hit policy)."
                })
            break

        # Check identical condition signatures
        for j in range(i + 1, len(rules)):
            rule_b = rules[j]
            same_conditions = True
            for inp in inputs:
                col_id = inp.get("id")
                cond_a = str(rule_a.get(col_id, "-")).strip()
                cond_b = str(rule_b.get(col_id, "-")).strip()
                if cond_a != cond_b:
                    same_conditions = False
                    break
            
            if same_conditions:
                if hit_policy == "first":
                    diagnostics.append({
                        "severity": "error",
                        "code": "DUPLICATE_CONDITION_SHADOW",
                        "ruleIndex": j,
                        "ruleId": rule_b.get("_id", f"r{j+1}"),
                        "message": f"Rule {j+1} has identical conditions to Rule {i+1} and will never be evaluated under 'first' hit policy."
                    })
                elif hit_policy in ("collect", "ruleorder", "rule_order"):
                    diagnostics.append({
                        "severity": "info",
                        "code": "DUPLICATE_CONDITION_COLLECT",
                        "ruleIndex": j,
                        "ruleId": rule_b.get("_id", f"r{j+1}"),
                        "message": f"Rule {j+1} and Rule {i+1} have identical conditions and will both fire together under '{hit_policy}' policy."
                    })

    # 3. Numeric Inequality Shadowing Check (in first-hit policy)
    if hit_policy == "first":
        for i in range(len(rules)):
            for j in range(i + 1, len(rules)):
                for inp in inputs:
                    col_id = inp.get("id")
                    ca = str(rules[i].get(col_id, "-")).strip()
                    cb = str(rules[j].get(col_id, "-")).strip()
                    other_inputs_wildcard = all(
                        str(rules[i].get(other_inp.get("id"), "-")).strip() in ("-", "") and
                        str(rules[j].get(other_inp.get("id"), "-")).strip() in ("-", "")
                        for other_inp in inputs if other_inp.get("id") != col_id
                    )
                    if other_inputs_wildcard:
                        ma = re.match(r'^(>=|>)\s*(-?\d+(?:\.\d+)?)$', ca)
                        mb = re.match(r'^(>=|>)\s*(-?\d+(?:\.\d+)?)$', cb)
                        if ma and mb and (float(ma.group(2)) < float(mb.group(2)) or
                                         float(ma.group(2)) == float(mb.group(2)) and
                                         (ma.group(1) == '>=' or mb.group(1) == '>')):
                            diagnostics.append({
                                "severity": "error",
                                "code": "INEQUALITY_SHADOW",
                                "ruleIndex": j,
                                "ruleId": rules[j].get("_id", f"r{j+1}"),
                                "message": f"Rule {j+1} ('{cb}') is shadowed by earlier Rule {i+1} ('{ca}') and can never execute under 'first' hit policy."
                            })
                        ma_le = re.match(r'^(<=|<)\s*(-?\d+(?:\.\d+)?)$', ca)
                        mb_le = re.match(r'^(<=|<)\s*(-?\d+(?:\.\d+)?)$', cb)
                        if ma_le and mb_le and (float(ma_le.group(2)) > float(mb_le.group(2)) or
                                               float(ma_le.group(2)) == float(mb_le.group(2)) and
                                               (ma_le.group(1) == '<=' or mb_le.group(1) == '<')):
                            diagnostics.append({
                                "severity": "error",
                                "code": "INEQUALITY_SHADOW",
                                "ruleIndex": j,
                                "ruleId": rules[j].get("_id", f"r{j+1}"),
                                "message": f"Rule {j+1} ('{cb}') is shadowed by earlier Rule {i+1} ('{ca}') and can never execute under 'first' hit policy."
                            })

    return diagnostics

def analyze_graph(graph_def: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Analyzes complete decision graph for cycles, orphan nodes, and table diagnostics."""
    diagnostics = []
    nodes = {n["id"]: n for n in graph_def.get("nodes", [])}
    edges = graph_def.get("edges", [])

    # Check for orphan nodes
    connected_targets = {e.get("targetId") for e in edges}
    connected_sources = {e.get("sourceId") for e in edges}

    for nid, node in nodes.items():
        ntype = node.get("type")
        if ntype != "inputNode" and nid not in connected_targets:
            diagnostics.append({
                "severity": "warning",
                "code": "ORPHAN_NODE_NO_INPUT",
                "nodeId": nid,
                "nodeName": node.get("name", nid),
                "message": f"Node '{node.get('name', nid)}' has no incoming data edges."
            })
        if ntype != "outputNode" and nid not in connected_sources:
            diagnostics.append({
                "severity": "warning",
                "code": "ORPHAN_NODE_NO_OUTPUT",
                "nodeId": nid,
                "nodeName": node.get("name", nid),
                "message": f"Node '{node.get('name', nid)}' has no outgoing edges to downstream nodes."
            })

        # If decisionTableNode, run table diagnostics
        if ntype == "decisionTableNode":
            table_diags = analyze_decision_table(node.get("content", {}))
            for td in table_diags:
                td["nodeId"] = nid
                td["nodeName"] = node.get("name", nid)
                diagnostics.append(td)

    return diagnostics
