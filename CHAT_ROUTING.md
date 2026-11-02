# Chat routing and correlation

Each turn has a `correlation_id`, a `user_message_id`, and an `assistant_message_id`. The server generates any omitted IDs. Clients can supply their own IDs using 1–128 characters: letters, digits, `_`, `.`, `:`, or `-`, starting with a letter or digit.

Send a turn to `POST /chat/stream` with the existing authentication cookie:

```json
{
  "workspace_id": "<conversation ID from /sessions>",
  "prompt": "Update this dashboard",
  "correlation_id": "<new UUID for this turn>",
  "user_message_id": "<new UUID for the user message>",
  "assistant_message_id": "<new UUID for the assistant response>"
}
```

`workspace_id` selects the conversation. The response exposes the same value as `chat_id`. `session_id` is the model's continuation context; use the conversation ID to route browser updates.

The response headers include `X-Correlation-Id`, `X-Chat-Id`, `X-User-Message-Id`, `X-Assistant-Message-Id`, and `X-Bob-Job-Id`. The request can also supply `X-Correlation-Id`; an explicit JSON `correlation_id` takes precedence.

Streamed events carry these fields as JSON alongside `type` and the event payload:

| Field | Use |
| --- | --- |
| `chat_id`, `workspace_id` | Destination conversation |
| `job_id` | Running job; use for cancel, guidance, event replay, and artifact subscription |
| `correlation_id` | Trace one request across messages, history, and transports |
| `user_message_id` | Original user message |
| `assistant_message_id` | Assistant response receiving streamed updates |
| `message_id` | Message represented by this event; user ID on request history, assistant ID on response events |
| `event_id` | Durable event cursor, when present; use to resume replay |

Subscribe to `/jobs/{job_id}/artifacts/ws` over `ws:` or `wss:` for dashboard snapshots. Reconnect with `?after_id={last_event_id}`. The server sends idle heartbeats; clients reconnect if the stream becomes unresponsive. `/jobs/{job_id}/events?after_id={last_event_id}` supplies HTTP event replay.

Match conversation, job, correlation, and assistant message IDs before applying an event. Existing history without these optional fields remains readable. IDs do not grant access: authentication and job ownership checks still apply. Correlation remains a routing identifier. Duplicate protection uses the durable idempotency key described below.


## Delivery and timeline

Messages show sending, accepted, queued, running, streaming, and a terminal state (completed, failed, or cancelled). Expand **Request timeline** on the assistant message to inspect milestones. Server events use `{"type":"delivery_state","state":"running","timestamp":"<ISO UTC timestamp>"}` plus routing metadata. Sending is observed in the browser and labeled “On this device.” Old history has no fabricated milestone times.

## Safe submission retries

Send the same `Idempotency-Key` header (or `idempotency_key` JSON field) for every retry of one submission. If both are supplied they must match. The browser uses its request correlation ID as the key and retries an uncertain initial transport failure once with the same body. An omitted explicit key defaults to the supplied/generated correlation ID; clients without stable retry IDs must retain and resend a key themselves.

Keys are scoped to the authenticated user and conversation. Matching retries return the original job and message IDs, including completed responses, with `X-Idempotency-Replayed: true`. Reusing a key with different request content returns HTTP 409. Concurrent matching retries create one job and one request-history record. This protects chat submission; it does not make external tool actions independently idempotent. A deliberate new request needs a new key.

## Artifact provenance

Expand **Artifact provenance** in the artifact editor or revision history to inspect the recorded conversation, job, correlation, message IDs, content hash, and timestamp. Generated provenance matches the authenticated conversation, exact file path, and SHA-256 in committed artifact events. Generated final revisions survive subsequent workspace saves. Manual edits and restores are marked explicitly, and unknown historical origins remain unknown. A tool-call ID is shown only when explicitly recorded.
