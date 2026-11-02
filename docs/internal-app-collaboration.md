# Internal app collaboration

Office Buddy, Project Buddy and Notes Buddy are internal specialists. They are not registered in the external A2A catalog. Main Buddy coordinates relevant work automatically through the existing authenticated `buddy-app` MCP server:

- `app_agents_list` returns specialists the current owner may use.
- `app_agents_delegate` accepts the specialist, task, relevant handoff context and typed app source references. The server fixes the owner; there are no identity, credential or endpoint overrides.

For example, Main Buddy can delegate a recorded portfolio assessment to Project Buddy and pass its findings to Office Buddy for a spreadsheet or presentation proposal. Existing Office tools create or import authorized deliverables. Native document changes retain the review-and-apply flow. Project Buddy uses the same worker tools. Office's editing planner can request bounded Project/Notes consultations before producing its final native editing plan; these consultations never become document bridge actions.

Each specialist runs a fresh tool-free ACP session in a temporary work/home directory. It receives the task and bounded authorized snapshots, not the coordinator's session ID, full chat, unrelated documents or other specialists' private history. There is no recursive delegation. Up to six handoffs are allowed per worker turn; Office plans may request at most two consultations in one round. Timeouts and cancellation clean up the child process. Results are findings/proposals, never evidence that an app was modified.

Saved Office snapshots omit unsaved editor changes. A handoff without file IDs can discover authorized filenames but cannot analyze file contents. Notes and portfolio snapshots are bounded and may be partial. Provider token/cost usage from specialist processes is currently unknown and is not included in the coordinator ACP totals.

## Access and deployment

Office reads reuse its owner-bound, signed app-action transport. Notes reuse existing owner-scoped note reads. Projects reuse the exact administrator/verified Keycloak read-access rule used by the Projects UI. The internal `/api/projects/agent-context` endpoint requires a short-lived JWT bound to the request body, intended audience and owner, then checks the live user and Projects permission again. File/note access is rechecked after inference before findings return.

Set `BUDDY_APP_AGENT_SECRET` to a shared random secret of at least 32 characters across core, worker and plugins. For compatibility, existing deployments may use `OFFICE_JWT_SECRET`; the Project capability uses a separate purpose/audience. The Compose shared environment passes the optional dedicated secret. Restart core/worker after changing their Python modules and rebuild/recreate feature images for plugin changes.

Disabled apps do not appear in internal discovery. Denied/unavailable sources fail the handoff; the coordinator must explain the limitation, never invent findings. No internal specialist is added to personal/global A2A configuration or catalogs.

## UI-independent progress contract

Every real handoff emits the following versioned semantic envelope through the caller's event sink. The surrounding `tool` fields preserve compatibility with existing activity timelines; consumers should use `collaboration` for app-specific presentation.

```json
{
  "type": "tool",
  "id": "app-agent-<unique-id>",
  "name": "Project Buddy",
  "status": "started",
  "input": null,
  "output": null,
  "collaboration": {
    "version": 1,
    "call_id": "app-agent-<same-unique-id>",
    "agent_id": "projects",
    "agent_name": "Project Buddy",
    "stage": "started",
    "message": "Project Buddy is reviewing the task",
    "task": "The actual delegated task, capped at 200 characters"
  }
}
```

Stages are `started`, `completed`, `failed`, `cancelled`. Tool status is respectively `started`, `completed`, `error`, `error`. Update the row by `call_id`; do not infer success from a connection or elapsed time. No findings, secrets or document text are included automatically in progress. A task label may contain the relevant task text supplied by the coordinator.

Worker events are durably recorded by the existing job recorder and survive history replay. Office emits the same envelope on its NDJSON draft stream. `AppCollaborationActivity` renders that contract in Main Buddy, Project Buddy and Office Buddy, showing the task and outcome. Other clients can consume the envelope without React, app-specific animation logic or external A2A setup. Office conversation activity currently lasts for the open editor component's lifetime, matching its existing chat history behavior.

## Verification

- `tests/test_app_agents.py`: owner binding, source grants, post-inference revocation, handoff bounds, capability body/purpose/lifetime, success/failure/cancellation events and MCP dispatch.
- `tests/test_office_collaboration.py`: specialist consultation precedes a single reviewed plan; unavailable specialists do not produce invented findings.
- `tests/office_collaboration_browser.mjs`: shared progress envelope renders named tasks and completed/failed states, deduplicates call IDs and preserves review without automatic edits.
- Live disposable Notes specialist check verifies an actual ACP session reads its owner's synthetic note and returns the synthetic label. Live Project service checks reject unsigned/unauthorized calls and accept an authorized signed portfolio read. No synthetic data is presented as real project data.
