"""
IBM Operational Decision Manager (ODM) Decision Validation Services (DVS).
Batch scenario testing suite with KPI pass/fail scorecards and expected-vs-actual variance reporting.
"""

import time
from typing import Any, Dict, List, Optional
from .decision_engine import DecisionEngine, get_by_path, loose_equals


def evaluate_dvs_suite(graph_or_decision: Any, scenarios: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Executes a DVS batch test suite across multiple scenario cases.
    Returns scorecard metrics and granular variance reports.
    """
    engine = DecisionEngine()
    start_total_ns = time.perf_counter_ns()

    total_count = len(scenarios)
    passed_count = 0
    scenario_reports = []

    for sc in scenarios:
        sc_id = sc.get("id") or f"scenario_{len(scenario_reports) + 1}"
        desc = sc.get("description") or f"Test scenario {sc_id}"
        input_data = sc.get("input") or {}
        expected_outputs = sc.get("expected") or {}

        t0 = time.perf_counter_ns()
        try:
            eval_res = engine.evaluate(graph_or_decision, input_data)
            duration_us = (time.perf_counter_ns() - t0) / 1000.0
            actual_result = eval_res.get("result", {})
            eval_error = None
        except Exception as ex:
            duration_us = (time.perf_counter_ns() - t0) / 1000.0
            actual_result = {}
            eval_error = str(ex)

        # Check expectations
        diffs = []
        is_passed = (eval_error is None)

        if is_passed:
            for exp_path, exp_val in expected_outputs.items():
                act_val = get_by_path(actual_result, exp_path)
                if not loose_equals(act_val, exp_val):
                    is_passed = False
                    diffs.append({
                        "field": exp_path,
                        "expected": exp_val,
                        "actual": act_val
                    })
        else:
            diffs.append({"field": "execution", "expected": "Success", "actual": f"Error: {eval_error}"})

        if is_passed:
            passed_count += 1

        scenario_reports.append({
            "id": sc_id,
            "description": desc,
            "passed": is_passed,
            "durationMicros": round(duration_us, 1),
            "diffs": diffs,
            "actualResult": actual_result,
            "expectedOutputs": expected_outputs
        })

    total_duration_ms = (time.perf_counter_ns() - start_total_ns) / 1_000_000.0
    pass_rate = round((passed_count / total_count * 100.0) if total_count > 0 else 100.0, 1)

    return {
        "summary": {
            "totalScenarios": total_count,
            "passedScenarios": passed_count,
            "failedScenarios": total_count - passed_count,
            "passRatePercentage": pass_rate,
            "totalDurationMs": round(total_duration_ms, 2)
        },
        "scenarios": scenario_reports
    }
