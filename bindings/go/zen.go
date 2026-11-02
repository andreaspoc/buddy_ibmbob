package zen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Response matches GoRules Zen response structure.
type Response struct {
	Result      any         `json:"result"`
	Performance string      `json:"performance"`
	Trace       []NodeTrace `json:"trace,omitempty"`
}

type NodeTrace struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Type           string          `json:"type"`
	OutputSnapshot any             `json:"outputSnapshot,omitempty"`
	RuleTrace      []RuleTraceItem `json:"ruleTrace,omitempty"`
}

type RuleTraceItem struct {
	RuleID string `json:"ruleId"`
	Passed bool   `json:"passed"`
}

type EvaluationOptions struct {
	Trace    bool `json:"trace"`
	MaxDepth int  `json:"maxDepth"`
}

type EngineOption func(*Engine)

func WithLoader(loader func(key string) ([]byte, error)) EngineOption {
	return func(e *Engine) {
		e.loader = loader
	}
}

type Engine struct {
	mu        sync.RWMutex
	loader    func(key string) ([]byte, error)
	decisions map[string]*Decision
}

func NewEngine(opts ...EngineOption) *Engine {
	e := &Engine{
		decisions: make(map[string]*Decision),
	}
	for _, opt := range opts {
		opt(e)
	}
	return e
}

func (e *Engine) CreateDecision(content []byte) (*Decision, error) {
	return NewDecision(content)
}

func (e *Engine) GetDecision(key string) (*Decision, error) {
	e.mu.RLock()
	dec, ok := e.decisions[key]
	e.mu.RUnlock()
	if ok {
		return dec, nil
	}
	if e.loader == nil {
		return nil, fmt.Errorf("decision '%s' not found and no loader configured", key)
	}
	content, err := e.loader(key)
	if err != nil {
		return nil, fmt.Errorf("failed to load decision '%s': %w", key, err)
	}
	dec, err = e.CreateDecision(content)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	e.decisions[key] = dec
	e.mu.Unlock()
	return dec, nil
}

func (e *Engine) Evaluate(ctx context.Context, key string, content []byte, data map[string]any) (*Response, error) {
	if len(content) > 0 {
		dec, err := e.CreateDecision(content)
		if err != nil {
			return nil, err
		}
		return dec.Evaluate(ctx, data)
	}
	dec, err := e.GetDecision(key)
	if err != nil {
		return nil, err
	}
	return dec.Evaluate(ctx, data)
}

// Decision represents a compiled decision graph.
type Decision struct {
	graph Graph
}

type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

type Node struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Type    string         `json:"type"`
	Content map[string]any `json:"content"`
}

type Edge struct {
	ID       string `json:"id"`
	SourceID string `json:"sourceId"`
	TargetID string `json:"targetId"`
}

func NewDecision(content []byte) (*Decision, error) {
	var raw map[string]any
	if err := json.Unmarshal(content, &raw); err != nil {
		return nil, fmt.Errorf("invalid decision JSON: %w", err)
	}

	graphBytes := content
	if g, ok := raw["graph"]; ok && g != nil {
		gb, err := json.Marshal(g)
		if err != nil {
			return nil, err
		}
		graphBytes = gb
	}

	var graph Graph
	if err := json.Unmarshal(graphBytes, &graph); err != nil {
		return nil, fmt.Errorf("failed to parse decision graph: %w", err)
	}

	return &Decision{graph: graph}, nil
}

func (d *Decision) Evaluate(ctx context.Context, data map[string]any) (*Response, error) {
	return d.EvaluateWithOpts(ctx, data, EvaluationOptions{})
}

func (d *Decision) EvaluateWithOpts(ctx context.Context, data map[string]any, opts EvaluationOptions) (*Response, error) {
	start := time.Now()

	// Clone context map
	dataBytes, _ := json.Marshal(data)
	workingCtx := make(map[string]any)
	_ = json.Unmarshal(dataBytes, &workingCtx)

	nodeMap := make(map[string]Node)
	inDegrees := make(map[string]int)
	outEdges := make(map[string][]Edge)

	for _, n := range d.graph.Nodes {
		nodeMap[n.ID] = n
		inDegrees[n.ID] = 0
	}
	for _, e := range d.graph.Edges {
		inDegrees[e.TargetID]++
		outEdges[e.SourceID] = append(outEdges[e.SourceID], e)
	}

	var queue []string
	for id, deg := range inDegrees {
		if deg == 0 {
			queue = append(queue, id)
		}
	}

	var execOrder []string
	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		execOrder = append(execOrder, curr)
		for _, e := range outEdges[curr] {
			inDegrees[e.TargetID]--
			if inDegrees[e.TargetID] == 0 {
				queue = append(queue, e.TargetID)
			}
		}
	}

	if len(execOrder) < len(nodeMap) {
		return nil, errors.New("graph cycle detected in decision model")
	}

	var traces []NodeTrace
	var finalResult any = workingCtx

	for _, nid := range execOrder {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		node := nodeMap[nid]
		trace := NodeTrace{
			ID:   node.ID,
			Name: node.Name,
			Type: node.Type,
		}

		switch node.Type {
		case "inputNode":
			if schema, ok := node.Content["schema"].(map[string]any); ok {
				if err := validateSchema(workingCtx, schema, "request"); err != nil {
					return nil, fmt.Errorf("input schema validation failed: %w", err)
				}
			}

		case "decisionTableNode":
			res, rTraces, err := evaluateDecisionTable(node.Content, workingCtx)
			if err != nil {
				return nil, err
			}
			trace.RuleTrace = rTraces
			trace.OutputSnapshot = res
			if list, ok := res.([]any); ok {
				name := node.Name
				if name == "" {
					name = node.ID
				}
				workingCtx[name] = list
				workingCtx["results"] = list
			} else if m, ok := res.(map[string]any); ok {
				for k, v := range m {
					setByPath(workingCtx, k, v)
				}
			}

		case "expressionNode":
			if exprs, ok := node.Content["expressions"].([]any); ok {
				outMap := make(map[string]any)
				for _, raw := range exprs {
					if m, ok := raw.(map[string]any); ok {
						k, _ := m["key"].(string)
						valExpr, _ := m["value"].(string)
						v := evalExpression(valExpr, workingCtx)
						outMap[k] = v
						setByPath(workingCtx, k, v)
					}
				}
				trace.OutputSnapshot = outMap
			}

		case "outputNode":
			if schemaList, ok := node.Content["schema"].([]any); ok {
				projected := make(map[string]any)
				for _, k := range schemaList {
					if ks, ok := k.(string); ok {
						projected[ks] = getByPath(workingCtx, ks)
					}
				}
				finalResult = projected
			} else if schemaMap, ok := node.Content["schema"].(map[string]any); ok {
				if err := validateSchema(workingCtx, schemaMap, "response"); err != nil {
					return nil, fmt.Errorf("output schema validation failed: %w", err)
				}
				finalResult = workingCtx
			} else {
				finalResult = workingCtx
			}
			trace.OutputSnapshot = finalResult
		}

		traces = append(traces, trace)
	}

	elapsed := time.Since(start)
	perfStr := fmt.Sprintf("%.1fµs", float64(elapsed.Nanoseconds())/1000.0)

	resp := &Response{
		Result:      finalResult,
		Performance: perfStr,
	}
	if opts.Trace {
		resp.Trace = traces
	}
	return resp, nil
}

func evaluateDecisionTable(content map[string]any, ctx map[string]any) (any, []RuleTraceItem, error) {
	hitPolicy := "first"
	if hp, ok := content["hitPolicy"].(string); ok && hp != "" {
		hitPolicy = strings.ToLower(hp)
	}

	inputs, _ := content["inputs"].([]any)
	outputs, _ := content["outputs"].([]any)
	rules, _ := content["rules"].([]any)

	var matchedOutputs []any
	var ruleTraces []RuleTraceItem

	for _, rawRule := range rules {
		rule, ok := rawRule.(map[string]any)
		if !ok {
			continue
		}
		ruleID, _ := rule["_id"].(string)

		rulePassed := true
		for _, rawIn := range inputs {
			inMap, ok := rawIn.(map[string]any)
			if !ok {
				continue
			}
			colID, _ := inMap["id"].(string)
			fieldPath, _ := inMap["field"].(string)
			if fieldPath == "" {
				fieldPath = colID
			}

			cellVal := rule[colID]
			cellStr := strings.TrimSpace(fmt.Sprintf("%v", cellVal))
			if cellVal == nil || cellStr == "" || cellStr == "-" {
				continue
			}

			contextVal := getByPath(ctx, fieldPath)
			if !evaluateUnary(cellStr, contextVal, ctx) {
				rulePassed = false
				break
			}
		}

		ruleTraces = append(ruleTraces, RuleTraceItem{RuleID: ruleID, Passed: rulePassed})

		if rulePassed {
			rowOut := make(map[string]any)
			for _, rawOut := range outputs {
				outMap, ok := rawOut.(map[string]any)
				if !ok {
					continue
				}
				colID, _ := outMap["id"].(string)
				fieldPath, _ := outMap["field"].(string)
				if fieldPath == "" {
					fieldPath = colID
				}

				rawVal := rule[colID]
				var outVal any
				if rawStr, ok := rawVal.(string); ok {
					s := strings.TrimSpace(rawStr)
					if strings.HasPrefix(s, "=") {
						outVal = evalExpression(strings.TrimPrefix(s, "="), ctx)
					} else {
						outVal = parseLiteral(s)
					}
				} else {
					outVal = rawVal
				}
				setByPath(rowOut, fieldPath, outVal)
			}

			if hitPolicy == "first" {
				return rowOut, ruleTraces, nil
			}
			matchedOutputs = append(matchedOutputs, rowOut)
		}
	}

	if hitPolicy == "first" {
		return map[string]any{}, ruleTraces, nil
	}

	return matchedOutputs, ruleTraces, nil
}

func evaluateUnary(testStr string, val any, ctx map[string]any) bool {
	s := strings.TrimSpace(testStr)
	if s == "" || s == "-" {
		return true
	}

	// Dynamic placeholder ? or $
	if hasPlaceholder(s) {
		subbed := substitutePlaceholder(s, val)
		res := evalExpression(subbed, ctx)
		if b, ok := res.(bool); ok {
			return b
		}
		return res != nil && res != 0 && res != ""
	}

	// Negation wrapper: not(...)
	if strings.HasPrefix(strings.ToLower(s), "not(") && strings.HasSuffix(s, ")") {
		inner := strings.TrimSpace(s[4 : len(s)-1])
		return !evaluateUnary(inner, val, ctx)
	}

	// in [...]
	if strings.HasPrefix(strings.ToLower(s), "in [") && strings.HasSuffix(s, "]") {
		inner := s[4 : len(s)-1]
		items := splitCSV(inner)
		for _, item := range items {
			if looseEqual(val, parseLiteral(item)) {
				return true
			}
		}
		return false
	}

	// not in [...]
	if strings.HasPrefix(strings.ToLower(s), "not in [") && strings.HasSuffix(s, "]") {
		inner := s[8 : len(s)-1]
		items := splitCSV(inner)
		for _, item := range items {
			if looseEqual(val, parseLiteral(item)) {
				return false
			}
		}
		return true
	}

	// Comma-separated list shorthand
	if strings.Contains(s, ",") && !strings.HasPrefix(s, "[") && !strings.HasPrefix(s, "(") {
		parts := splitCSV(s)
		if len(parts) > 1 {
			for _, part := range parts {
				if evaluateUnary(strings.TrimSpace(part), val, ctx) {
					return true
				}
			}
			return false
		}
	}

	// Range: [min..max]
	rangeRe := regexp.MustCompile(`^([\[\(])\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*([\]\)])$`)
	if matches := rangeRe.FindStringSubmatch(s); len(matches) == 5 {
		lBr := matches[1]
		minV, _ := strconv.ParseFloat(matches[2], 64)
		maxV, _ := strconv.ParseFloat(matches[3], 64)
		rBr := matches[4]
		num, ok := toFloat(val)
		if !ok {
			return false
		}
		minPass := num >= minV
		if lBr == "(" {
			minPass = num > minV
		}
		maxPass := num <= maxV
		if rBr == ")" {
			maxPass = num < maxV
		}
		return minPass && maxPass
	}

	// Comparisons
	compRe := regexp.MustCompile(`^(>=|<=|!=|==|=|>|<)\s*(.*)$`)
	if matches := compRe.FindStringSubmatch(s); len(matches) == 3 {
		op := matches[1]
		if op == "=" {
			op = "=="
		}
		target := parseLiteral(matches[2])
		vNum, vOk := toFloat(val)
		tNum, tOk := toFloat(target)
		if vOk && tOk {
			switch op {
			case ">=":
				return vNum >= tNum
			case "<=":
				return vNum <= tNum
			case ">":
				return vNum > tNum
			case "<":
				return vNum < tNum
			case "==":
				return vNum == tNum
			case "!=":
				return vNum != tNum
			}
		}
		switch op {
		case "==":
			return looseEqual(val, target)
		case "!=":
			return !looseEqual(val, target)
		}
	}

	return looseEqual(val, parseLiteral(s))
}

func hasPlaceholder(s string) bool {
	inSingle := false
	inDouble := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' && !inDouble && (i == 0 || s[i-1] != '\\') {
			inSingle = !inSingle
		} else if ch == '"' && !inSingle && (i == 0 || s[i-1] != '\\') {
			inDouble = !inDouble
		} else if !inSingle && !inDouble && (ch == '?' || ch == '$') {
			return true
		}
	}
	return false
}

func substitutePlaceholder(s string, val any) string {
	inSingle := false
	inDouble := false
	var sb strings.Builder
	valStr := fmt.Sprintf("%v", val)
	if str, ok := val.(string); ok {
		valStr = fmt.Sprintf("'%s'", strings.ReplaceAll(str, "'", "\\'"))
	}
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' && !inDouble && (i == 0 || s[i-1] != '\\') {
			inSingle = !inSingle
			sb.WriteByte(ch)
		} else if ch == '"' && !inSingle && (i == 0 || s[i-1] != '\\') {
			inDouble = !inDouble
			sb.WriteByte(ch)
		} else if !inSingle && !inDouble && (ch == '?' || ch == '$') {
			sb.WriteString(valStr)
		} else {
			sb.WriteByte(ch)
		}
	}
	return sb.String()
}

func evalExpression(expr string, ctx map[string]any) any {
	s := strings.TrimSpace(expr)
	if s == "" {
		return nil
	}
	if s == "true" || s == "True" {
		return true
	}
	if s == "false" || s == "False" {
		return false
	}
	if s == "null" || s == "nil" {
		return nil
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		if math.Floor(f) == f && !strings.Contains(s, ".") {
			return int(f)
		}
		return f
	}

	// Function calls: startsWith, endsWith, matches, map, filter, unique, join
	callRe := regexp.MustCompile(`^(\w+)\((.*)\)$`)
	if matches := callRe.FindStringSubmatch(s); len(matches) == 3 {
		fnName := matches[1]
		args := splitCSV(matches[2])

		switch fnName {
		case "startsWith", "starts_with":
			if len(args) == 2 {
				val := fmt.Sprintf("%v", evalExpression(args[0], ctx))
				prefix := fmt.Sprintf("%v", parseLiteral(args[1]))
				return strings.HasPrefix(val, prefix)
			}
		case "endsWith", "ends_with":
			if len(args) == 2 {
				val := fmt.Sprintf("%v", evalExpression(args[0], ctx))
				suffix := fmt.Sprintf("%v", parseLiteral(args[1]))
				return strings.HasSuffix(val, suffix)
			}
		case "matches":
			if len(args) == 2 {
				val := fmt.Sprintf("%v", evalExpression(args[0], ctx))
				reStr := fmt.Sprintf("%v", parseLiteral(args[1]))
				matched, err := regexp.MatchString(reStr, val)
				return err == nil && matched
			}
		case "map":
			if len(args) == 2 {
				target := evalExpression(args[0], ctx)
				field := fmt.Sprintf("%v", parseLiteral(args[1]))
				var res []any
				if list, ok := target.([]any); ok {
					for _, item := range list {
						if m, ok := item.(map[string]any); ok {
							res = append(res, m[field])
						}
					}
				}
				return res
			}
		case "filter":
			if len(args) >= 2 {
				target := evalExpression(args[0], ctx)
				field := fmt.Sprintf("%v", parseLiteral(args[1]))
				expected := parseLiteral(args[len(args)-1])
				var res []any
				if list, ok := target.([]any); ok {
					for _, item := range list {
						if m, ok := item.(map[string]any); ok {
							if looseEqual(m[field], expected) {
								res = append(res, m)
							}
						}
					}
				}
				return res
			}
		case "unique":
			if len(args) == 1 {
				target := evalExpression(args[0], ctx)
				seen := make(map[string]bool)
				var res []any
				if list, ok := target.([]any); ok {
					for _, item := range list {
						key := fmt.Sprintf("%v", item)
						if !seen[key] {
							seen[key] = true
							res = append(res, item)
						}
					}
				}
				return res
			}
		case "join":
			if len(args) == 2 {
				target := evalExpression(args[0], ctx)
				sep := fmt.Sprintf("%v", parseLiteral(args[1]))
				var strList []string
				if list, ok := target.([]any); ok {
					for _, item := range list {
						strList = append(strList, fmt.Sprintf("%v", item))
					}
				}
				return strings.Join(strList, sep)
			}
		}
	}

	// Context variable path
	if val := getByPath(ctx, s); val != nil {
		return val
	}

	return parseLiteral(s)
}

func getByPath(obj any, path string) any {
	if path == "" || path == "$" || obj == nil {
		return obj
	}
	parts := strings.Split(path, ".")
	curr := obj
	for _, part := range parts {
		if curr == nil {
			return nil
		}
		if m, ok := curr.(map[string]any); ok {
			curr = m[part]
		} else {
			return nil
		}
	}
	return curr
}

func setByPath(obj map[string]any, path string, val any) {
	if path == "" || path == "$" {
		if m, ok := val.(map[string]any); ok {
			for k, v := range m {
				obj[k] = v
			}
		}
		return
	}
	parts := strings.Split(path, ".")
	curr := obj
	for i := 0; i < len(parts)-1; i++ {
		p := parts[i]
		if next, ok := curr[p].(map[string]any); ok {
			curr = next
		} else {
			newMap := make(map[string]any)
			curr[p] = newMap
			curr = newMap
		}
	}
	curr[parts[len(parts)-1]] = val
}

func parseLiteral(s string) any {
	str := strings.TrimSpace(s)
	if str == "true" {
		return true
	}
	if str == "false" {
		return false
	}
	if str == "null" || str == "nil" {
		return nil
	}
	if (strings.HasPrefix(str, "'") && strings.HasSuffix(str, "'")) ||
		(strings.HasPrefix(str, "\"") && strings.HasSuffix(str, "\"")) {
		return str[1 : len(str)-1]
	}
	if f, err := strconv.ParseFloat(str, 64); err == nil {
		if math.Floor(f) == f && !strings.Contains(str, ".") {
			return int(f)
		}
		return f
	}
	return str
}

func toFloat(val any) (float64, bool) {
	switch v := val.(type) {
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}

func looseEqual(a, b any) bool {
	if a == b {
		return true
	}
	aNum, aOk := toFloat(a)
	bNum, bOk := toFloat(b)
	if aOk && bOk {
		return aNum == bNum
	}
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
}

func splitCSV(s string) []string {
	var parts []string
	var current strings.Builder
	inSingle := false
	inDouble := false
	depth := 0

	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' && !inDouble && (i == 0 || s[i-1] != '\\') {
			inSingle = !inSingle
			current.WriteByte(ch)
		} else if ch == '"' && !inSingle && (i == 0 || s[i-1] != '\\') {
			inDouble = !inDouble
			current.WriteByte(ch)
		} else if (ch == '[' || ch == '(') && !inSingle && !inDouble {
			depth++
			current.WriteByte(ch)
		} else if (ch == ']' || ch == ')') && !inSingle && !inDouble {
			depth--
			current.WriteByte(ch)
		} else if ch == ',' && !inSingle && !inDouble && depth == 0 {
			parts = append(parts, strings.TrimSpace(current.String()))
			current.Reset()
		} else {
			current.WriteByte(ch)
		}
	}
	if current.Len() > 0 {
		parts = append(parts, strings.TrimSpace(current.String()))
	}
	return parts
}

func validateSchema(data map[string]any, schema map[string]any, path string) error {
	if req, ok := schema["required"].([]any); ok {
		for _, r := range req {
			if rs, ok := r.(string); ok {
				if _, present := data[rs]; !present {
					return fmt.Errorf("%s.%s is required", path, rs)
				}
			}
		}
	}
	if props, ok := schema["properties"].(map[string]any); ok {
		for k, rawProp := range props {
			prop, ok := rawProp.(map[string]any)
			if !ok {
				continue
			}
			val, present := data[k]
			if !present {
				continue
			}
			if minVal, ok := prop["minimum"].(float64); ok {
				if f, ok := toFloat(val); ok && f < minVal {
					return fmt.Errorf("%s.%s: value %v is less than minimum %v", path, k, val, minVal)
				}
			}
		}
	}
	return nil
}
