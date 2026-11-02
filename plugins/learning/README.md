# Learning Buddy

Independent optional ASGI plugin for a private EPUB library and assessments. Uses
Buddy's verified Keycloak identities, PostgreSQL `learning` schema and private S3
objects under `learning/books/`. No demonstration content or real-user grants are
seeded. The responsive standalone workspace is `/learning/`, launched from Apps.

## Roles and access

- Administrators manage folders, EPUB uploads, user/group grants and results.
- Users with a verified **`/teacher`** Keycloak group can create quizzes in folders
  they can access, ask Buddy for drafts, edit their own quizzes, and approve their
  own publication. Administrators can also create quizzes.
- Draft quizzes are private to their creator. Only that creator can approve and
  publish them, including when another administrator requests publication.
- Participants read and submit only within assigned folders. Folder grants can
  target provisioned Keycloak users or exact full realm group paths. A grant to
  `/Team` does not implicitly grant `/Team/Subteam`. Local profile names, group labels
  flags, incoming group headers and similarly named groups cannot confer access.
- Administrators can inspect all submissions, statistics and CSV exports. Each participant
  can read only their own submitted attempt and personal study plan. Before submission,
  reference answers, rubrics, explanations and reading guidance stay server-side.

The user picker lists users already provisioned through verified login in the
configured `KEYCLOAK_ISSUER`, plus platform admins; it is not a live full-realm
user directory. Group choices are observed verified group paths, and admins can
enter an exact path for a group whose members have not yet signed in.

### Keycloak setup

Create a realm group named **teacher** (full path `/teacher`) and assign the quiz
creators. Configure the Buddy client's **Group Membership** mapper with claim name
`groups`, **Full group path** enabled, and **Add to ID token** enabled. Members must
sign out and back in so the signed claims are refreshed. The optional
`BUDDY_LEARNING_TEACHER_GROUP` setting selects a different exact full group path.
See [Keycloak's mapper documentation](https://www.keycloak.org/admin-api/protocol-mappers).

Membership snapshots are replaced on verified SSO login; missing or malformed
claims remove old group memberships. Keycloak-side changes become effective on the
next login, not immediately through a live realm sync. Removing a Learning folder
grant takes effect on subsequent requests immediately. Existing historical
submissions remain available to administrators after access is removed.

This release does not require realm-administration credentials. The existing
configured client does not permit creating Keycloak groups via client credentials;
a Keycloak administrator must create `/teacher` and configure the mapper.

## Books and assessments

Supports DRM-free EPUB with bounded ZIP extraction, reading-order navigation,
search, text size, personal page position and bookmarks. Use the arrows, keyboard or a horizontal swipe to turn pages within a chapter. The notes palette saves private, colored notes linked to a chapter and page; notes are visible only to their author and require current folder access.

Folders, books and quizzes have direct subpaths under `/learning/folders/{folder_id}`. Book links retain the chapter and page in their query parameters and support reload and browser history.

Chapters are rendered
through a server-side allowlist with scripts, external resources, forms, embedded
objects, SVG and original styles removed. The paged reader sanitizes the inert chapter markup again with DOMPurify before laying it out in CSS columns. Only
verified raster images are served as resources. XHTML is never served raw.
Limits: 50 MB upload, 100 MB expanded archive, 2,000 archive entries, 20 MB per entry.
Encrypted/obfuscated-font books and non-UTF-8 chapter markup are rejected.

Quiz fields support single-choice, multi-select, dropdown and written answers.
Choice grading is deterministic, exact-set, and occurs only on final submission.
Buddy automatically grades written answers against their reference answers and
rubrics after submission. Unavailable grading leaves marks pending. Administrators
can request fresh suggestions, review them and explicitly save adjustments; these
administrator-requested suggestions do not change marks until saved. All AI operations run without authorized tools in the isolated ACP
runtime. Quiz creation uses sanitized book excerpts (up to 35,000 characters), and
shows an excerpt-limit notice when the source is truncated. AI-created quizzes are
always unpublished drafts requiring creator approval.

Published questions are immutable snapshots. Close a quiz before editing it;
approving the new version opens one new attempt per user while retaining old
submissions and their exact questions. Duplicate retries return the original
confirmation; changed duplicate answers and stale-version submissions are rejected.

## Deployment

Build the shared runtime/core from this checkout when installing into a different
installation (the Keycloak group SDK and `/learning/` frontend are required).
Install the AppArmor profile as described in `docs/agent-runtime-isolation.md`.
Add `learning` to the installation's selected features, or for an existing local
installation retaining its other `.env` feature choices:

```sh
docker compose -f docker-compose.yml -f docker-compose.https.yml -f docker-compose.learning.yml --profile learning build learning-plugin
docker compose -f docker-compose.yml -f docker-compose.https.yml -f docker-compose.learning.yml --profile learning up -d --no-deps --wait learning-plugin bob-agent bob-worker bob-gateway
```

Core proxies `/api/learning` to `BUDDY_LEARNING_PLUGIN_URL`; original authentication
is checked on both sides. The feature flag is `BUDDY_LEARNING_ENABLED`. The API
manifest, health/readiness and deployment selection follow the other plugins.

Tests: `python3 -m unittest discover -s tests -p 'test_learning_*.py'`. The explicit
`tests/learning_integration.py` creates/removes disposable test accounts and checks
real PostgreSQL, S3 and HTTP. `tests/learning_ui_browser.py` uses synthetic intercepted
API data against a Vite dev server (set `LEARNING_UI_URL`). It checks admin, teacher
and participant flows, creator approval, reader state, grading suggestions and
responsive layouts without writing real application data.

## Interactive lessons

The **Lessons** tab supports human authors and optional Buddy assistance. Teachers
and administrators can create lessons in folders they can access. Write sections
in the portal or import a PDF, PPTX, DOCX, EPUB, text or another supported document
(up to 50 MB) into editable text sections. Import extracts content rather than
preserving slide/page layout; scanned PDFs need a text layer. Lessons support up
to 100 sections: explanations, click-to-reveal sections, single-choice practice
questions with immediate author-written feedback, images, and videos. Upload
PNG/JPEG/GIF/WebP images or MP4/WebM videos up to 50 MB each, or embed supported
HTTPS YouTube/Vimeo links. External videos require access to their provider and
may be unavailable if that provider disallows embedding. Media remains private
behind lesson/folder authorization; external links are never fetched by the server.

**Draft with Buddy** proposes text and practice activities from an author's brief
or imported source material. Authors review the proposal before applying it to
the editable draft, then save and explicitly approve publication. Buddy cannot
publish or upload files. Existing uploaded media sections are retained when a
proposal replaces the text/activity sections. Buddy uses at most 35,000 characters
of source context and flags truncation. Review facts, coverage and answers before
publishing. These are formative practice activities, separate from scored quizzes.
Reference answers stay on the server for learners; checking an answer returns its
correctness and the author's feedback.

Only the creator can edit/approve a lesson. Published lessons are immutable: close
one before editing, then publish a new version. Learner positions and completion
are private and version-scoped. Completion indicates the learner reached and
marked the final section; it is not a scored assessment or proof of video viewing.
New versions start with fresh progress. Existing folder and exact Keycloak group
access rules apply to every lesson, progress and media request.

Verification: `PYTHONPATH=plugins/learning python3 -m unittest tests.test_learning_lessons`.
The synthetic UI flow is `node tests/learning_lessons_browser.mjs` with Playwright
available and a Vite server at `LEARNING_UI_URL` (default `http://127.0.0.1:3045`).
Set `PLAYWRIGHT_PACKAGE` if the Playwright package is outside the normal module path.

Deploy the core frontend/performance changes and Learning plugin using the saved
installation choices:

```sh
python3 scripts/deploy_buddy.py --only core --build
python3 scripts/deploy_buddy.py --only learning --build
```

Lesson tables are created additively under the existing schema startup lock.
Existing books, quizzes, grants and assessment submissions are retained.

### Creative boards and rich lesson content

Buddy can propose **interactive concept boards** and **branching decision scenarios**,
using the supplied human material as its source. Authors can also add a board
manually, edit its cards/colors/connections, and test it in the learner preview.
Concept boards reveal one card at a time. Decision scenarios start at the first
card and offer connected choices, back navigation and restart. Board definitions
have bounded cards and validated connections; they contain no executable code.

Lesson explanations, reveals, introductions, feedback and board bodies render
Markdown and safe semantic HTML. Headings, lists, tables, code, links and
`details`/`summary` are supported. Scripts, event handlers, styles, arbitrary
embeds and images inside rich content are removed; use the dedicated image/video
sections for media. Buddy proposals render with the same components as the learner
view before the author applies them.


### Automatic assessment feedback and analytics

Choice answers use exact-set automatic scoring. After an attempt is saved, Buddy
marks written responses against the immutable reference answers and rubrics,
accepting equivalent wording and awarding partial credit. Model marks must cover
exactly the pending question IDs, stay within each question's points, and include
nonempty feedback. An unavailable or invalid grading response leaves the attempt
saved with a provisional score; learners can retry automatic grading, and admins
can adjust written marks. Automatic persistence uses a compare-and-swap against
the previous grades so a concurrent administrator's changes are preserved.

`GET /quizzes/{id}/my-result` releases solutions only after the authenticated user
has submitted that quiz version. `POST /quizzes/{id}/my-result/grade` retries only
that user's pending marks. Both retain folder access checks. Other users' results,
statistics, and CSV exports remain administrator-only. No database migration is
needed: grades and author explanation/study-topic/reading fields use existing JSON
snapshots. Published versions retain their own answer keys and reports.

The learner report presents one answer at a time, correct/incorrect choices,
rubric feedback, and a study plan prioritized by lost points. Authors can supply
source-based explanations, topic labels, and reading references. Source chapter
links are matched against actual authorized book chapter titles; references are
never invented. Quizzes without a source book still show explanations and study
prompts. Existing submissions gain exact-set feedback when reviewed.

Carbon Charts show personal answer outcomes, and administrator-only score
histograms, outcomes by question, and answer-option selection counts. Statistics
are scoped to one published version. Pending scores are excluded from the final
score distribution and average. Accessible data tables accompany every chart.

Verification with dependencies installed:

```sh
PYTHONPATH=plugins/learning python3 -m unittest tests.test_learning_quizzes tests.test_learning_results tests.test_learning_access
node tests/learning_results_render.mjs
```


Assessment charts use the shared Carbon chart renderer, including the common
entrance/update timings and easing, visibility replay and reduced-motion support.
Data changes update an existing chart instance instead of recreating it.

Submitting keeps the learner in the quiz dialog with an indeterminate grading
state. The submission response includes the persisted personal report after the
automatic grading attempt completes, and the screen displays it immediately.
There is no artificial delay or manual refresh requirement. A reopened attempt
loads the same owner-scoped report. An unavailable grader still returns the
saved attempt with an explicitly provisional score. Administrator results read
those same stored marks and refresh every five seconds while the dashboard is
visible; polling stops when it closes.


Reports and user lists use profile display names; internal Keycloak account keys
remain authorization/audit keys and are not rendered as person names. When a
profile name is unavailable for an internal account, the UI uses a neutral role
label. Administrator report queries resolve names in one batch.

Legend filtering shares the app's chart-update timing and easing. Hidden marks
fade out instead of disappearing immediately, surviving geometry transitions
natively, and restored marks animate back in. Pointer and keyboard legend actions
share the same behavior, and reduced-motion preferences disable both effects.

Reopening a submitted quiz includes its owner-scoped report in the quiz response.
A generic 404 on a results route indicates an unsupported route, which the UI
reports as a required Learning service update rather than a bare “Not Found”.
Frontend builds do not update the independently packaged Learning service. Release
the backend changes with `python3 scripts/deploy_buddy.py --only learning --build`
on a host with Docker access; existing attempts are retained.


The Learning workspace has a bottom-right Learning Coach launcher across library,
quiz and lesson tabs. Its responsive panel supports minimizing, Escape-to-close,
focus return and preserved conversation state within a folder. Quiz drafts keep
their contextual editor assistant. Chat placement no longer consumes a content
column, and lesson pages reserve scrolling space above the launcher.

Interactive lessons use a guided section outline, activity labels, animated
content panels, selected-answer cards, immediate practice feedback and a saved
completion screen. Learners check practice answers before continuing. Authors
can preview unsaved drafts locally, return to the editor without losing edits,
duplicate sections and add activity types from the toolbox. Unsaved previews do
not publish, save progress or issue completion records.

Learning Coach, lesson navigation and quiz reports share the Learning purple brand tokens. Statistical charts use a purple palette; correctness and warning states retain their semantic colors.

## Developer notes: learner next steps

`web/src/components/LearningNextSteps.tsx` derives a class's next steps from
its existing `/folders/{folder_id}/contents` response. It lists published,
started lessons that are not completed; published quizzes without a submission;
and submitted quizzes with grading pending. The response is scoped to the
current user by the existing folder access checks and username-specific progress
and submission queries. The panel makes no new requests and does not store
progress or schedule reminders. Lesson and quiz buttons use the workspace's
existing navigation and result flows. The panel is omitted when there is no
matching work.

Run the focused tests from `web/` with Node 24:

```sh
npx vitest run tests/coverage/learningNextSteps.test.tsx
```

Run `npm run test:coverage` from `web/` for the full UI suite. From the project
root, `bash scripts/run_sonar_scan.sh` regenerates the configured Python,
PostgreSQL integration, Go, Java, and UI coverage reports and submits a
SonarQube analysis. That workflow requires Docker and a configured SonarQube
token and server. The next-steps panel is one part of the planned learning
improvements; it does not implement spaced practice or reminders.
