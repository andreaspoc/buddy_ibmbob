package zen

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestLoaderCacheAndEvaluation(t *testing.T) {
	calls := 0
	graph := []byte(`{"graph":{"nodes":[{"id":"in","type":"inputNode"},{"id":"out","type":"outputNode","content":{"schema":["name"]}}],"edges":[{"sourceId":"in","targetId":"out"}]}}`)
	engine := NewEngine(WithLoader(func(key string) ([]byte, error) {
		calls++
		if key == "missing" {
			return nil, errors.New("unavailable")
		}
		return graph, nil
	}))
	for i := 0; i < 2; i++ {
		result, err := engine.Evaluate(context.Background(), "known", nil, map[string]any{"name": "Ada", "private": "x"})
		if err != nil || !reflect.DeepEqual(result.Result, map[string]any{"name": "Ada"}) {
			t.Fatalf("unexpected result: %#v, %v", result, err)
		}
	}
	if calls != 1 {
		t.Fatalf("expected cached graph, got %d loads", calls)
	}
	if _, err := engine.GetDecision("missing"); err == nil {
		t.Fatal("expected loader failure")
	}
	if _, err := NewEngine().GetDecision("unknown"); err == nil {
		t.Fatal("expected missing loader failure")
	}
	if _, err := engine.Evaluate(context.Background(), "", []byte("bad json"), nil); err == nil {
		t.Fatal("expected JSON error")
	}
}

func TestExpressionAndSchemaValidation(t *testing.T) {
	ctx := map[string]any{"items": []any{map[string]any{"name": "A", "role": "admin"}, map[string]any{"name": "B", "role": "user"}}, "values": []any{"a", "a", "b"}, "name": "Alice"}
	cases := []struct {
		expr string
		want any
	}{
		{"startsWith(name, 'Al')", true}, {"endsWith(name, 'ce')", true}, {"matches(name, '^A')", true},
		{"map(items, 'name')", []any{"A", "B"}}, {"filter(items, 'role', 'admin')", []any{map[string]any{"name": "A", "role": "admin"}}},
		{"unique(values)", []any{"a", "b"}}, {"join(values, '-')", "a-a-b"}, {"null", nil},
	}
	for _, tc := range cases {
		if got := evalExpression(tc.expr, ctx); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %#v want %#v", tc.expr, got, tc.want)
		}
	}
	graph := []byte(`{"nodes":[{"id":"in","type":"inputNode","content":{"schema":{"required":["age"],"properties":{"age":{"minimum":18}}}}},{"id":"out","type":"outputNode"}],"edges":[{"sourceId":"in","targetId":"out"}]}`)
	decision, err := NewDecision(graph)
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range []map[string]any{{}, {"age": 15}} {
		if _, err = decision.Evaluate(context.Background(), data); err == nil || !strings.Contains(err.Error(), "input schema") {
			t.Fatalf("expected schema error, got %v", err)
		}
	}
	if _, err = decision.Evaluate(context.Background(), map[string]any{"age": 18}); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = decision.Evaluate(cancelled, map[string]any{"age": 18}); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation: %v", err)
	}
}

func TestGraphExecutionAndCycleHandling(t *testing.T) {
	graph := []byte(`{"nodes":[{"id":"in","type":"inputNode"},{"id":"expr","type":"expressionNode","content":{"expressions":[{"key":"result.greeting","value":"name"},{"key":"result.active","value":"true"}]}},{"id":"out","type":"outputNode","content":{"schema":["result"]}}],"edges":[{"sourceId":"in","targetId":"expr"},{"sourceId":"expr","targetId":"out"}]}`)
	decision, err := NewDecision(graph)
	if err != nil {
		t.Fatal(err)
	}
	response, err := decision.EvaluateWithOpts(context.Background(), map[string]any{"name": "Ada"}, EvaluationOptions{Trace: true})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"result": map[string]any{"greeting": "Ada", "active": true}}
	if !reflect.DeepEqual(response.Result, want) || len(response.Trace) != 3 {
		t.Fatalf("unexpected graph response: %#v", response)
	}
	cyclic, err := NewDecision([]byte(`{"nodes":[{"id":"a","type":"inputNode"},{"id":"b","type":"outputNode"}],"edges":[{"sourceId":"a","targetId":"b"},{"sourceId":"b","targetId":"a"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = cyclic.Evaluate(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cycle error: %v", err)
	}
}

func TestUnaryBoundariesAndMembership(t *testing.T) {
	cases := []struct {
		expr  string
		value any
		want  bool
	}{
		{"-", 7, true}, {"in [1, 2]", 2, true}, {"in [1, 2]", 3, false},
		{"not in [1, 2]", 2, false}, {"not in [1, 2]", 3, true},
		{"(1..3]", 1, false}, {"(1..3]", 3, true}, {"[1..3)", 3, false},
		{"[1..3]", "not a number", false}, {"> 5", 6, true}, {"< 5", 6, false},
		{"<= 5", 5, true}, {"!= 5", 6, true}, {"= 5", 5, true},
		{"== 'active'", "active", true}, {"!= 'active'", "active", false},
		{"red, blue", "blue", true}, {"red, blue", "green", false},
	}
	for _, tc := range cases {
		if got := evaluateUnary(tc.expr, tc.value, nil); got != tc.want {
			t.Errorf("%s with %v: got %v, want %v", tc.expr, tc.value, got, tc.want)
		}
	}
}
