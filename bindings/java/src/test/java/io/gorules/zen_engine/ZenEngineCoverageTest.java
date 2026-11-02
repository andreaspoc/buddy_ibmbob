package io.gorules.zen_engine;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ZenEngineCoverageTest {
    private static final String GRAPH = """
        {"graph":{"nodes":[{"id":"in","type":"inputNode"},
        {"id":"out","type":"outputNode","content":{"schema":["name"]}}],
        "edges":[{"sourceId":"in","targetId":"out"}]}}
        """;

    @Test void cachesLoadedDecisionsAndSupportsSyncAndAsyncEvaluation() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        try (ZenEngine engine = new ZenEngine(key -> { calls.incrementAndGet(); return new JsonBuffer(GRAPH); }, null)) {
            ZenDecision first = engine.getDecision("greeting");
            assertSame(first, engine.getDecision("greeting"));
            assertEquals(1, calls.get());
            var response = engine.evaluate("greeting", null, new JsonBuffer("{\"name\":\"Ada\",\"secret\":1}"));
            assertEquals(Map.of("name", "Ada"), response.getResult());
            assertNotNull(response.getPerformance());
            assertNull(response.getTrace());
            var traced = first.evaluate(new JsonBuffer("{\"name\":\"Ada\"}"), Map.of("trace", true)).get();
            assertEquals(2, traced.getTrace().size());
            assertThrows(UnsupportedOperationException.class, () -> first.getGraph().put("bad", 1));
        }
        assertThrows(IllegalArgumentException.class, () -> new ZenEngine().getDecision("missing"));
        assertThrows(IllegalArgumentException.class, () -> new ZenEngine(key -> null, null).getDecision("missing"));
        assertThrows(IllegalArgumentException.class, () -> new ZenDecision("[]"));
    }

    @Test void evaluatesCollectionExpressionsAndRejectsInvalidSchemas() {
        var data = Map.<String,Object>of("items", List.of(Map.of("name", "A", "role", "admin"), Map.of("name", "B", "role", "user")), "values", List.of("a", "a", "b"), "name", "Alice");
        assertEquals(true, JdmEngine.evalExpression("startsWith(name, 'Al')", data));
        assertEquals(true, JdmEngine.evalExpression("endsWith(name, 'ce')", data));
        assertEquals(List.of("A", "B"), JdmEngine.evalExpression("map(items, 'name')", data));
        assertEquals(List.of(Map.of("name", "A", "role", "admin")), JdmEngine.evalExpression("filter(items, 'role', 'admin')", data));
        assertEquals(List.of("a", "b"), JdmEngine.evalExpression("unique(values)", data));
        assertEquals("a-a-b", JdmEngine.evalExpression("join(values, '-')", data));
        var decision = new ZenDecision("""
          {"nodes":[{"id":"in","type":"inputNode","content":{"schema":{"required":["age"],"properties":{"age":{"minimum":18}}}}},
          {"id":"out","type":"outputNode"}],"edges":[{"sourceId":"in","targetId":"out"}]}
          """);
        assertThrows(IllegalArgumentException.class, () -> decision.evaluateSync(Map.of(), false));
        assertThrows(IllegalArgumentException.class, () -> decision.evaluateSync(Map.of("age", 15), false));
        assertEquals(Map.of("age", 18), decision.evaluateSync(Map.of("age", 18), false).getResult());
    }
    @Test void evaluatesExpressionNodesAndRejectsCycles() {
        var decision = new ZenDecision("""
          {"nodes":[{"id":"in","type":"inputNode"},{"id":"calc","type":"expressionNode","content":{"expressions":[{"key":"result.greeting","value":"name"}]}},{"id":"out","type":"outputNode","content":{"schema":["result.greeting"]}}],"edges":[{"sourceId":"in","targetId":"calc"},{"sourceId":"calc","targetId":"out"}]}
          """);
        var result = decision.evaluateSync(Map.of("name", "Ada"), true);
        assertEquals(Map.of("result.greeting", "Ada"), result.result());
        assertEquals(3, result.trace().size());
        var cycle = new ZenDecision("""
          {"nodes":[{"id":"a","type":"inputNode"},{"id":"b","type":"outputNode"}],"edges":[{"sourceId":"a","targetId":"b"},{"sourceId":"b","targetId":"a"}]}
          """);
        assertThrows(IllegalStateException.class, () -> cycle.evaluateSync(Map.of(), false));
    }
}
