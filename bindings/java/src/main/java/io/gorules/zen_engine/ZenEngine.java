package io.gorules.zen_engine;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * GoRules ZenEngine Java implementation matching official io.gorules:zen-engine.
 */
public final class ZenEngine implements AutoCloseable {
    private final ZenLoader loader;
    private final Map<String, ZenDecision> cache = new ConcurrentHashMap<>();

    public ZenEngine() {
        this(null, null);
    }

    public ZenEngine(ZenLoader loader, Object customNode) {
        this.loader = loader;
    }

    public ZenDecision createDecision(JsonBuffer content) {
        return new ZenDecision(content);
    }

    public ZenDecision createDecision(String jsonString) {
        return new ZenDecision(new JsonBuffer(jsonString));
    }

    public ZenDecision createDecision(byte[] bytes) {
        return new ZenDecision(new JsonBuffer(bytes));
    }

    public ZenDecision getDecision(String key) throws Exception {
        ZenDecision cached = cache.get(key);
        if (cached != null) {
            return cached;
        }
        if (loader == null) {
            throw new IllegalArgumentException("Decision '" + key + "' not found and no loader configured");
        }
        JsonBuffer buf = loader.load(key);
        if (buf == null) {
            throw new IllegalArgumentException("Loader returned null for decision '" + key + "'");
        }
        ZenDecision dec = createDecision(buf);
        cache.put(key, dec);
        return dec;
    }

    public ZenResponse evaluate(String key, JsonBuffer content, JsonBuffer context) throws Exception {
        ZenDecision dec = (content != null && content.getBytes().length > 0)
            ? createDecision(content)
            : getDecision(key);
        return dec.evaluateSync(context, null);
    }

    @Override
    public void close() {
        cache.clear();
    }
}
