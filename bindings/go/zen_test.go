package zen

import (
	"context"
	"testing"
)

func TestZenEngineGoBinding(t *testing.T) {
	ctx := context.Background()

	// 1. Unary expressions
	if !evaluateUnary("endsWith(?, '@gorules.io')", "admin@gorules.io", nil) {
		t.Fatalf("endsWith with ? failed")
	}
	if evaluateUnary("endsWith(?, '@gorules.io')", "admin@gmail.com", nil) {
		t.Fatalf("endsWith with ? falsely matched")
	}
	if !evaluateUnary("matches(?, '^[A-Z]{3}-\\d{3}$')", "ABC-123", nil) {
		t.Fatalf("matches regex failed")
	}
	if evaluateUnary("matches(?, '^[A-Z]{3}-\\d{3}$')", "abc-123", nil) {
		t.Fatalf("matches regex falsely matched")
	}
	if !evaluateUnary("not(in ['FRAUD', 'BLOCKED'])", "ACTIVE", nil) {
		t.Fatalf("not(in [...]) failed")
	}
	if evaluateUnary("not(in ['FRAUD', 'BLOCKED'])", "FRAUD", nil) {
		t.Fatalf("not(in [...]) falsely matched")
	}
	if !evaluateUnary("10, 20, 30", 20, nil) {
		t.Fatalf("comma-separated list matching failed")
	}

	// 2. Complete Decision Table graph with ruleOrder
	graphJSON := []byte(`{
		"nodes": [
			{"id": "inp", "type": "inputNode", "content": {}},
			{
				"id": "tbl",
				"type": "decisionTableNode",
				"content": {
					"hitPolicy": "ruleOrder",
					"inputs": [{"id": "score", "field": "score"}],
					"outputs": [{"id": "tier", "field": "tier"}],
					"rules": [
						{"_id": "r1", "score": ">= 50", "tier": "BRONZE"},
						{"_id": "r2", "score": ">= 80", "tier": "SILVER"},
						{"_id": "r3", "score": ">= 95", "tier": "GOLD"}
					]
				}
			},
			{"id": "out", "type": "outputNode", "content": {}}
		],
		"edges": [
			{"id": "e1", "sourceId": "inp", "targetId": "tbl"},
			{"id": "e2", "sourceId": "tbl", "targetId": "out"}
		]
	}`)

	engine := NewEngine()
	decision, err := engine.CreateDecision(graphJSON)
	if err != nil {
		t.Fatalf("Failed to create decision: %v", err)
	}

	res, err := decision.EvaluateWithOpts(ctx, map[string]any{"score": 85}, EvaluationOptions{Trace: true})
	if err != nil {
		t.Fatalf("Evaluation failed: %v", err)
	}

	if res.Performance == "" {
		t.Fatalf("Expected non-empty performance string")
	}

	resMap, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("Expected result map, got %T", res.Result)
	}

	tblRows, ok := resMap["tbl"].([]any)
	if !ok || len(tblRows) != 2 {
		t.Fatalf("Expected 2 matched rows for ruleOrder, got %+v", resMap["tbl"])
	}

	row1 := tblRows[0].(map[string]any)
	row2 := tblRows[1].(map[string]any)
	if row1["tier"] != "BRONZE" || row2["tier"] != "SILVER" {
		t.Fatalf("Unexpected tiers: %v, %v", row1["tier"], row2["tier"])
	}
}
