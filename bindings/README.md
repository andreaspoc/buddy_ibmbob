# Zen-Engine Language Bindings for DecisionsBuddy

High-performance, in-process language bindings for evaluating JSON Decision Models (JDM). These bindings provide native parity with GoRules Zen across **Python**, **Node.js / TypeScript**, and **Go (Golang)**.

---

## 1. Python Binding (`zen-engine`)

- **Location:** `bindings/python/zen_engine/`, `zen_engine.py`, and `app/decisions_buddy/zen_engine.py`
- **Specification:** Matches official PyPI package `zen-engine`.

### Usage

```python
import json
from zen_engine import ZenEngine

# 1. Initialize engine (optional custom loader for multi-graph resolution)
engine = ZenEngine(options={
    "loader": lambda key: json.load(open(f"./rules/{key}.json"))
})

# 2. Create decision from dict, JSON string, or bytes
with open("pricing.json", "rb") as f:
    decision = engine.create_decision(f.read())

# 3. Evaluate context
result = decision.evaluate(
    context={"cart": {"total": 150}, "customer": {"tier": "gold"}},
    options={"trace": True}
)

print("Result:", result["result"])
print("Performance:", result["performance"])
```

---

## 2. Node.js & TypeScript Binding (`@gorules/zen-engine`)

- **Location:** `bindings/nodejs/`
- **Specification:** Matches official npm package `@gorules/zen-engine`.
- **TypeScript Definitions:** Included in `bindings/nodejs/index.d.ts`.

### Usage

```javascript
const { ZenEngine } = require('@gorules/zen-engine');
// or in TypeScript / ESM:
// import { ZenEngine } from '@gorules/zen-engine';
const fs = require('fs');

async function main() {
  const engine = new ZenEngine();

  // Load decision model
  const decisionJson = fs.readFileSync('./rules/pricing.json', 'utf-8');
  const decision = engine.createDecision(decisionJson);

  // Evaluate in-process with microsecond performance
  const res = await decision.evaluate({
    cart: { total: 150 },
    customer: { tier: 'gold' }
  }, { trace: true });

  console.log('Result:', res.result);
  console.log('Performance:', res.performance);
}

main();
```

---

## 3. Go (Golang) Binding (`zen-go`)

- **Location:** `bindings/go/`
- **Module:** `github.com/gorules/zen-go/v2`
- **Specification:** Matches official Go package `github.com/gorules/zen-go/v2`.

### Usage

```go
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/gorules/zen-go/v2"
)

func main() {
	ctx := context.Background()
	engine := zen.NewEngine()

	// Read decision JSON
	content, err := os.ReadFile("pricing.json")
	if err != nil {
		panic(err)
	}

	decision, err := engine.CreateDecision(content)
	if err != nil {
		panic(err)
	}

	// Evaluate context
	evalContext := map[string]any{
		"cart": map[string]any{"total": 150},
		"customer": map[string]any{"tier": "gold"},
	}

	res, err := decision.EvaluateWithOpts(ctx, evalContext, zen.EvaluationOptions{Trace: true})
	if err != nil {
		panic(err)
	}

	fmt.Printf("Result: %+v\n", res.Result)
	fmt.Printf("Performance: %s\n", res.Performance)
}
```

---

## 4. Java Binding (`io.gorules:zen-engine`)

- **Location:** `bindings/java/`
- **Maven Artifact:** `io.gorules:zen-engine`
- **Package:** `io.gorules.zen_engine`
- **Specification:** Matches official GoRules Zen Java SDK.

### Usage

```java
import io.gorules.zen_engine.JsonBuffer;
import io.gorules.zen_engine.ZenDecision;
import io.gorules.zen_engine.ZenEngine;
import io.gorules.zen_engine.ZenResponse;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public class RulesApp {
    public static void main(String[] args) throws Exception {
        // 1. Initialize engine
        try (ZenEngine engine = new ZenEngine()) {
            
            // 2. Load decision model
            String content = Files.readString(Path.of("./rules/pricing.json"));
            ZenDecision decision = engine.createDecision(new JsonBuffer(content));

            // 3. Evaluate context
            JsonBuffer context = new JsonBuffer("""
            {
              "cart": { "total": 150 },
              "customer": { "tier": "gold" }
            }
            """);

            ZenResponse response = decision.evaluate(context, Map.of("trace", true)).join();

            System.out.println("Result: " + response.result());
            System.out.println("Performance: " + response.performance());
        }
    }
}
```

---

## Feature Parity Across All 4 Bindings

| Feature | Python | Node.js / TS | Go | Java |
| :--- | :---: | :---: | :---: | :---: |
| **Topological DAG execution** | ✅ | ✅ | ✅ | ✅ |
| **Decision Table `first` Hit Policy** | ✅ | ✅ | ✅ | ✅ |
| **Decision Table `collect` Hit Policy** | ✅ | ✅ | ✅ | ✅ |
| **Decision Table `ruleOrder` Hit Policy** | ✅ | ✅ | ✅ | ✅ |
| **Dynamic `?` / `$` unary placeholder** | ✅ | ✅ | ✅ | ✅ |
| **Unary Regex Matching (`matches`)** | ✅ | ✅ | ✅ | ✅ |
| **Unary String Prefix/Suffix (`startsWith`, `endsWith`)** | ✅ | ✅ | ✅ | ✅ |
| **Unary Negation (`not(...)`)** | ✅ | ✅ | ✅ | ✅ |
| **Multi-Value List Matching (`10, 20, 30`)** | ✅ | ✅ | ✅ | ✅ |
| **Range Matching (`[min..max]`, `(min..max)`)** | ✅ | ✅ | ✅ | ✅ |
| **Higher-order transformations (`map`, `filter`, `unique`, etc.)** | ✅ | ✅ | ✅ | ✅ |
| **JSON Schema contract validation (`inputNode`, `outputNode`)** | ✅ | ✅ | ✅ | ✅ |
| **Microsecond performance telemetry & trace** | ✅ | ✅ | ✅ | ✅ |
