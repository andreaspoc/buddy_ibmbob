# Human-led classes and courses

Learning classes are course containers managed by a human teacher or an
administrator. Existing books, interactive lessons, practice activities, and
quizzes remain the teaching material; adding a class does not copy or replace
that content. No example classes, enrollments, assignments, or submissions are
seeded.

## Teacher workflow

1. Open an authorized Learning folder and create a class with a title and
   description. The folder remains the access boundary for its material.
2. Enroll provisioned users from the class's eligible-member picker. The picker
   includes only users who already have current access to this folder. Enrollment
   cannot grant a user access to private books or lessons.
3. Add or edit announcements and scheduled sessions. Session times include a
   timezone; the end must follow the start. Section labels can organize sessions
   and assignments into weeks or course units.
4. Create manual homework instructions, or attach an existing book, published
   lesson, or published quiz from the same folder. Set a deadline, late-submission
   policy, required flag, and optional minimum percentage for a required quiz.
5. Review individual homework submissions and provide feedback with an optional
   mark. This human homework review is separate from the existing automatic quiz
   marking workflow.
6. Use the course-completion view to review evidence, approve completion for a
   specific learner, and issue a personalized Buddy certificate. Eligibility
   calculations support the teacher's decision; they do not approve or issue
   certificates autonomously.

All classroom announcements, session descriptions, assignment instructions, and
feedback can be authored manually. AI is not needed for any classroom operation.
The existing lesson editor continues to support manually authored text, reveals,
questions, images, videos, and interactive concept boards/decision scenarios.

## Learner workflow and privacy

Learners see only classes where they are enrolled and still have folder access.
They can read announcements and schedules, open authorized assigned materials,
and submit their own written homework. A submission includes a snapshot of the
assignment instructions and revision that the learner answered. They can update
unreviewed work until its deadline unless late submissions are allowed. Reviewed
work cannot be overwritten by the learner.

Assignment lists include only the current learner's submission. Class rosters,
other learners' submissions, and teacher feedback controls are available only to
the class owner with an active teacher role, or to an administrator. Another
teacher does not gain management rights just by sharing the folder.

Archiving a class preserves its material and submission history while blocking
new announcements, sessions, enrollment changes, assignments, homework, and
feedback. The owner or an administrator can reopen it.

## Version and completion rules

Edits use revision checks to reject stale updates. Changing assignments or the
roster also increments the class revision so course approvals cannot accidentally
use an older requirement list. A linked lesson or quiz records its published
version when assigned. If a teacher publishes a replacement, they must explicitly
edit the assignment to select the current version.

Required lesson assignments use completion of the pinned lesson version.
Required quiz assignments use the pinned quiz version's saved, fully graded
attempt and configured minimum percentage. Book/manual homework requirements use
teacher-reviewed work for the current assignment revision. Existing automatic
quiz marking is preserved; class/course certificates still require an explicit
human decision. Certificates retain their issued recipient, course and teacher
names and reviewed evidence; later content edits do not rewrite them.

## Backend API

All endpoints are authenticated under `/api/learning`; writes enforce same-origin
requests. Identifiers are UUIDs.

- `GET/POST /folders/{folder_id}/classes`
- `GET/PUT /classes/{class_id}`
- `GET /classes/{class_id}/candidates`
- `GET/PUT /classes/{class_id}/members`
- `GET/POST /classes/{class_id}/announcements`
- `PUT /classes/{class_id}/announcements/{announcement_id}`
- `GET/POST /classes/{class_id}/sessions`
- `PUT /classes/{class_id}/sessions/{session_id}`
- `GET/POST /classes/{class_id}/assignments`
- `GET/PUT /classes/{class_id}/assignments/{assignment_id}`
- `POST /classes/{class_id}/assignments/{assignment_id}/submit`
- `GET /classes/{class_id}/assignments/{assignment_id}/submissions`
- `PUT /classes/{class_id}/assignments/{assignment_id}/submissions/{submission_id}/feedback`

The class, announcement, session, assignment, and feedback edit requests include
`expected_revision`. Homework submission uses the current assignment's revision,
not the submission's revision. The storage additions are new tables under the
existing `learning` schema, initialized under its existing startup advisory lock;
existing books, grants, quizzes, lessons, and results remain intact.

Verification: `PYTHONPATH=plugins/learning python3 -m unittest tests.test_learning_classrooms`.
The tests use synthetic database adapters and assert authorization, current folder
access, privacy, deadlines, optimistic revisions, manual creation, published-source
checks, human feedback, and cross-origin rejection. They do not use real learner
records, invoke AI, or issue operational certificates.
