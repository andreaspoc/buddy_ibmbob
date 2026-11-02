package io.gorules.zen_engine;

import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Compiled executable decision instance matching GoRules ZenDecision.
 */
public final class ZenDecision {
    private final Map<String, Object> graph;

    @SuppressWarnings("unchecked")
    public ZenDecision(JsonBuffer content) {
        Object parsed = JdmEngine.SimpleJson.parse(content.toString());
        if (parsed instanceof Map<?, ?> map) {
            Object g = map.get("graph");
            if (g instanceof Map<?, ?> gm) {
                this.graph = (Map<String, Object>) gm;
            } else {
                this.graph = (Map<String, Object>) map;
            }
        } else {
            throw new IllegalArgumentException("Invalid decision content; JSON object expected");
        }
    }

    public ZenDecision(String jsonString) {
        this(new JsonBuffer(jsonString));
    }

    public Map<String, Object> getGraph() {
        return Collections.unmodifiableMap(graph);
    }

    public CompletableFuture<ZenResponse> evaluate(JsonBuffer context, Map<String, Object> options) {
        return CompletableFuture.supplyAsync(() -> evaluateSync(context, options));
    }

    public ZenResponse evaluateSync(JsonBuffer context, Map<String, Object> options) {
        @SuppressWarnings("unchecked")
        Map<String, Object> inputData = (Map<String, Object>) JdmEngine.SimpleJson.parse(context.toString());
        boolean trace = options != null && Boolean.TRUE.equals(options.get("trace"));
        return JdmEngine.evaluateGraph(graph, inputData != null ? inputData : Collections.emptyMap(), trace);
    }

    public ZenResponse evaluateSync(Map<String, Object> context, boolean trace) {
        return JdmEngine.evaluateGraph(graph, context != null ? context : Collections.emptyMap(), trace);
    }
}
