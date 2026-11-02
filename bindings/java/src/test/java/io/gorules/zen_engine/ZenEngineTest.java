package io.gorules.zen_engine;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

public class ZenEngineTest {
    @Test
    void engineBindingRegression() throws Exception {
        System.out.println("Running Java Zen-Engine Binding Tests...");

        // 1. Unary expressions
        assertCondition(JdmEngine.evaluateUnary("endsWith(?, '@gorules.io')", "admin@gorules.io", null), "endsWith ? match");
        assertCondition(!JdmEngine.evaluateUnary("endsWith(?, '@gorules.io')", "admin@gmail.com", null), "endsWith ? mismatch");
        assertCondition(JdmEngine.evaluateUnary("matches(?, '^[A-Z]{3}-\\d{3}$')", "ABC-123", null), "regex match");
        assertCondition(!JdmEngine.evaluateUnary("matches(?, '^[A-Z]{3}-\\d{3}$')", "abc-123", null), "regex mismatch");
        assertCondition(JdmEngine.evaluateUnary("not(in ['FRAUD', 'BLOCKED'])", "ACTIVE", null), "not in");
        assertCondition(!JdmEngine.evaluateUnary("not(in ['FRAUD', 'BLOCKED'])", "FRAUD", null), "not in match");
        assertCondition(JdmEngine.evaluateUnary("10, 20, 30", 20, null), "comma separated list");
        assertCondition(JdmEngine.evaluateUnary(">= \t\n 10", 12, null), "comparison leading whitespace");
        assertCondition(!JdmEngine.evaluateUnary(">= 10\nextra", 12, null), "comparison rejects multiline operand");
        assertCondition(JdmEngine.evaluateUnary(">= " + " ".repeat(100000) + "10", 12, null), "long comparison whitespace");

        // 2. Full Decision Table with ruleOrder Hit Policy
        String graphJson = """
        {
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
            {"sourceId": "inp", "targetId": "tbl"},
            {"sourceId": "tbl", "targetId": "out"}
          ]
        }
        """;

        try (ZenEngine engine = new ZenEngine()) {
            ZenDecision decision = engine.createDecision(new JsonBuffer(graphJson));
            JsonBuffer ctx = new JsonBuffer("""
            {
              "score": 85
            }
            """);

            ZenResponse response = decision.evaluate(ctx, Map.of("trace", true)).join();

            System.out.println("Performance: " + response.performance());
            assertCondition(response.performance() != null && !response.performance().isEmpty(), "performance populated");

            @SuppressWarnings("unchecked")
            Map<String, Object> resMap = (Map<String, Object>) response.result();
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> rows = (List<Map<String, Object>>) resMap.get("tbl");

            assertCondition(rows != null && rows.size() == 2, "2 rows matched for ruleOrder");
            assertCondition("BRONZE".equals(rows.get(0).get("tier")), "Row 1 is BRONZE");
            assertCondition("SILVER".equals(rows.get(1).get("tier")), "Row 2 is SILVER");
        }

        // 3. Dynamic loader
        try (ZenEngine engine = new ZenEngine(key -> new JsonBuffer(graphJson), null)) {
            ZenDecision decision = engine.getDecision("scoring_policy");
            ZenResponse res = decision.evaluateSync(new JsonBuffer("{\"score\": 98}"), null);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> rows = (List<Map<String, Object>>) ((Map<String, Object>) res.result()).get("tbl");
            assertCondition(rows.size() == 3, "All 3 tiers matched for score 98");
        }

        System.out.println("All Java Zen-Engine Binding Tests Passed Successfully!");
    }

    private static void assertCondition(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError("Assertion Failed: " + message);
        }
    }
}
