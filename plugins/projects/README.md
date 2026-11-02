# Buddy Projects plugin

Independent ASGI package built on `bob-acp-runtime:1.1.0`. Portfolio data is persisted in the PostgreSQL `projects` schema. No demonstration portfolio is seeded.

## Access and identity

The directory contains users provisioned through verified platform login for the configured `KEYCLOAK_ISSUER`, plus platform administrators. It is not a full external Keycloak realm directory. Assignment, ownership, reviewer and approver references must pass server-side directory validation.

Administrators manage the portfolio. Verified members read projects where they are responsibility owners, contributors, backups, or work item owners. Owning a work item grants project read access and permission to edit that item's status/resolution only. It does not grant management rights. Reviewer and approver attribution do not themselves grant project access. Dependencies require both endpoints to be visible. People, work items, stage approvals and historical impact evidence are scoped to visible projects; audit events are admin-only. Reads use `Cache-Control: no-store`. Cross-origin writes bearing a foreign Origin are rejected.

Availability changes are portfolio metadata; they do not disable accounts or change Keycloak.

## API

All routes below are prefixed `/api/projects` and use platform cookie/Bearer authentication.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `''` or `/portfolio` | Return `{projects,people,assignments,dependencies,work_items,stage_approvals,events,impact,recent_change_impacts,can_manage}`. |
| POST | `/projects` | Create a project. |
| PATCH | `/projects/{id}` | Edit project fields with `expected_revision`. Return saved project and immediate `impact`. |
| PATCH | `/people/{username}` | Set `{status,departure_date?}` portfolio availability. |
| POST | `/assignments` | Record responsibility, role, backup and allocation. |
| DELETE | `/assignments/{id}` | Remove a responsibility assignment. |
| POST | `/dependencies` | Record `{source_project_id,target_project_id,description?}`: target depends on source. |
| DELETE | `/dependencies/{id}` | Remove a project dependency. |
| POST | `/work-items` | Create a work item, relationship links and optional acceptance fields. |
| PATCH | `/work-items/{id}` | Edit an item with `expected_revision`; project and kind are immutable. |
| DELETE | `/work-items/{id}` | Remove an item and retain its previous values in the audit log. |
| POST | `/projects/{id}/stage-approvals` | Record a stage decision against the current project revision. |
| POST | `/impact/preview` | Analyze an unsaved availability or project scenario. |
| POST | `/impact/apply` | Apply a scenario and store evidence in the same transaction. |
| GET | `/context?project_id=optional` | Return `{portfolio,instructions}` using caller-scoped facts for Project Buddy. |

Operational endpoints are `/ready`, `/health`, and `/plugins/manifest` (outside the API prefix).

### Projects and governance

Create requires `name`; optional fields are `description`, `business_case`, `product_description`, `status`, `priority`, `start_date`, `due_date`, `milestone`, `stage`, `tolerance_days`, `exception_status`, and `tailoring_level`. PATCH accepts the same fields plus required `expected_revision`.

- Status: `planned`, `active`, `paused`, `completed`.
- Priority: `low`, `medium`, `high`.
- Stage: `initiation`, `planning`, `delivery`, `closing`, `operational`.
- Time tolerance: integer `0..365` days; default zero means no allowed days beyond the target.
- Exception status: `within_tolerance`, `threatened`, `breached` (recorded management assessment).
- Tailoring level: `simple`, `standard`, `corporate`.

`milestone` is the existing free-text next-stage-gate note. Use a work item of kind `milestone` for an independently dated milestone. The labels and fields support a tailored governance workflow; they do not constitute PRINCE2 certification.

Stage decision body: `{expected_revision,stage,approver_id,decision:'approved'|'rejected',evidence}`. The stage must match the project's current stage. The immutable record retains the project revision, attributed approver, recording actor, evidence and timestamp. An administrator records the decision; this is not an authenticated electronic signature by the attributed approver. Recording a decision does not advance the stage. Later project edits leave the old decision attached to its original revision.

### Responsibilities and availability

Assignment body: `{project_id,person_id,responsibility,role,backup_person_id?,allocation?}`. Allocation is `0..100` per assignment, not a measured workload. Roles: `executive`, `senior_user`, `senior_supplier`, `project_manager`, `team_manager`, `project_assurance`, `owner`, `contributor`, `approver`. A person cannot be their own backup.

People expose `{id:username,name,email,status,departure_date}`. Availability status is `active`, `leaving`, or `departed`.

### Work items, hierarchy and dependencies

Create requires `project_id`, `kind`, `title`. Optional fields: `description`, `owner_id`, `start_date`, `due_date`, `priority`, `status`, `resolution`, `parent_id`, `predecessor_ids`, `acceptance_criteria`, `reviewer_id`, `acceptance_evidence`. The first status below is the creation default.

| Kind | Allowed statuses |
| --- | --- |
| `task` | `todo`, `in_progress`, `blocked`, `done` |
| `milestone` | `todo`, `in_progress`, `blocked`, `done` |
| `risk` | `open`, `mitigating`, `resolved` |
| `issue` | `open`, `in_progress`, `resolved` |
| `decision` | `proposed`, `approved`, `declined` |
| `deliverable` | `draft`, `in_development`, `quality_review`, `accepted` |
| `lesson` | `identified`, `logged`, `applied` |

`parent_id` groups work into a hierarchy, including deliverable work packages. `predecessor_ids` records the items that this item depends on. Links must stay within the same project, cannot point to the item itself, and cannot form cycles across hierarchy and predecessor links. An empty predecessor list clears those links. Links do not automatically reschedule work or imply a critical path or computed progress.

Milestones require a due date and render as a point in the timeline. Ordinary work items can remain undated. `owner_id:null`, `reviewer_id:null`, `parent_id:null`, and date nulls clear those fields. A known start must be on or before a known due date; partial updates validate against persisted dates.

Deliverables use separate acceptance criteria, reviewer and acceptance evidence. Saving an accepted deliverable requires all three. Existing records retain their values during migration; historical accepted records are not given invented acceptance evidence. Work owners can still edit only status/resolution; acceptance safeguards also apply to those status changes.

### Edit conflicts

Projects and work items expose integer `revision`, initially 1. PATCH requires the `expected_revision` read by the editor. An effective edit increments revision; a no-op does not. Stale saves return HTTP 409 and do not overwrite newer values. Missing expected revisions are rejected. The UI preserves the unsaved draft and provides an explicit reload action to discard it and load the current record. Copy any draft text you want to retain before reloading.

Project scenarios accept `expected_revision` at preview and require it at apply. A stale scenario must be reviewed again. Availability scenarios retain their existing contract. All clients that PATCH these APIs must send revisions after upgrading the plugin.

## Impact and history

Impact shape: `{items:[{project_id,level:'confirmed'|'risk',reason,evidence,path:[project_ids]}],summary:{confirmed,risks,affected_projects},limitations}`.

Analysis follows recorded relationships only. A departed person's uncovered responsibility is a confirmed gap; an active backup still needs a verified handover and generates a risk. Blocked tasks/milestones, unresolved issues and overdue unfinished work are recorded conditions, not proof of a delivery delay. Open risks, proposed decisions and deliverables awaiting quality review prompt review. Closed items (`done`, `resolved`, `approved`, `declined`, `accepted`, `applied`) do not become overdue. Completed projects do not receive work/departure alerts or propagate downstream effects.

An unfinished project past its due date is flagged even with zero time tolerance. Positive tolerance distinguishes a past-target risk within tolerance from a recorded schedule exception beyond tolerance. The calculation uses the current UTC date, injectable in tests. Manual exception assessments remain separate recorded evidence.

Project dependency effects remain review risks. Traversal terminates safely with cyclic project dependencies. Missing progress, skills, workload, handover completion and precise delay estimates are never invented. Preview does not mutate data; apply recalculates evidence against a consistent transaction snapshot.

Effective project edits save `{project_id,changes,impact}` atomically. No-op project PATCH saves do not create duplicate history. `recent_change_impacts` returns the latest saved change per visible project with `{event_id,created_at,project_id,change,impact}`. These timestamped analyses are historical, separate from current unresolved alerts. Nonadmin evidence paths containing inaccessible projects are removed and counters recalculated.

## Storage and upgrades

Schema upgrades add nullable planning/acceptance fields and default revisions without synthesizing dates, progress or evidence for existing records. Portfolio reads restrict records in SQL to caller-visible projects. History and relationship indexes support those queries. Runtime transactions use a consistent PostgreSQL snapshot; project/work row locking and revisions protect edits without locking all portfolio tables. Concurrent transaction conflicts return 409 for review and retry. Deleting linked work clears affected relationships, increments dependent revisions, and audits those removals along with the deleted item’s predecessor links.

## Verification

Pure impact tests:

```sh
PYTHONPATH=plugins/projects python3 -m unittest discover -s plugins/projects/tests -v
```

`plugins/projects/tests/http_integration.py` exercises API persistence, identities, permissions, dates, relationships, governance and conflicts with synthetic fixtures in a rolled-back transaction. Run it inside a Buddy runtime with `PYTHONPATH` including this plugin and a prepared PostgreSQL database (`users`, `bob_user_profiles`, and the platform auth schema). Additional database/concurrency tests are kept alongside it when applicable.

Browser regressions use Vite fixtures and explicitly synthetic intercepted responses; they do not contact live project or identity services. Start Vite, then run the project browser scripts with `CARBON_PREVIEW_URL`, `CARBON_PLAYWRIGHT_MODULE`, and `CARBON_AXE_MODULE` configured as described in `web/docs/carbon-review.md`. UI guidance and audits for this change use the Carbon MCP server.
