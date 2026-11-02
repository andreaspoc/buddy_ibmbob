package io.gorules.zen_engine;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * Encapsulates raw JSON payload data for input context and decision models.
 */
public final class JsonBuffer {
    private final byte[] bytes;

    public JsonBuffer(byte[] bytes) {
        this.bytes = Objects.requireNonNull(bytes, "bytes must not be null");
    }

    public JsonBuffer(String json) {
        this(Objects.requireNonNull(json, "json must not be null").getBytes(StandardCharsets.UTF_8));
    }

    public byte[] getBytes() {
        return bytes;
    }

    @Override
    public String toString() {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
