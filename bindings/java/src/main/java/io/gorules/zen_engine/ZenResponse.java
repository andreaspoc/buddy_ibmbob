package io.gorules.zen_engine;

import java.util.List;
import java.util.Map;

/**
 * Zen Engine evaluation response containing the computed result,
 * performance execution duration, and optional trace items.
 */
public record ZenResponse(
    Object result,
    String performance,
    List<Map<String, Object>> trace
) {
    public Object getResult() {
        return result;
    }

    public String getPerformance() {
        return performance;
    }

    public List<Map<String, Object>> getTrace() {
        return trace;
    }
}
