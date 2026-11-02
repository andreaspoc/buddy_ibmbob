package io.gorules.zen_engine;

/**
 * Functional interface for dynamically resolving sub-decisions by key.
 */
@FunctionalInterface
public interface ZenLoader {
    JsonBuffer load(String key) throws Exception;
}
