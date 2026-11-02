"""Course completion tracking, automatic and teacher-approved certificates, and email delivery."""
from app.branding import organization_label
import hashlib
import json
from html import escape
from unittest.mock import Mock
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from psycopg.types.json import Jsonb
from starlette.concurrency import run_in_threadpool
from anyio import from_thread

from app import job_queue
from app.auth import current_user
from .quizzes import learner_display_name
from . import store

router = APIRouter(prefix='/api/learning')
from .service import same_origin


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS learning.course_certificates (
        id UUID PRIMARY KEY, class_id UUID NOT NULL REFERENCES learning.classes(id),
        username TEXT NOT NULL REFERENCES users(username), version INTEGER NOT NULL,
        recipient_name TEXT NOT NULL, course_title TEXT NOT NULL, instructor_name TEXT NOT NULL,
        issued_by TEXT NOT NULL, issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        class_revision INTEGER NOT NULL, evidence JSONB NOT NULL, evidence_digest TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', revoked_at TIMESTAMPTZ, revocation_reason TEXT,
        UNIQUE(class_id,username,version))''')
    db.execute("ALTER TABLE learning.course_certificates ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'pending_smtp'")
    db.execute("ALTER TABLE learning.course_certificates ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ")
    db.execute("ALTER TABLE learning.course_certificates ADD COLUMN IF NOT EXISTS email_recipient TEXT")
    db.execute("ALTER TABLE learning.course_certificates ADD COLUMN IF NOT EXISTS email_error TEXT")
    db.execute('CREATE INDEX IF NOT EXISTS learning_course_certificates_owner ON learning.course_certificates(class_id,username,version DESC)')


class Approval(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: int = Field(ge=1, strict=True)
    evidence_digest: str = Field(pattern=r'^[a-f0-9]{64}$')
    recipient_name: str = Field(min_length=1, max_length=200)
    note: str = Field(default='', max_length=2000)

    @field_validator('recipient_name')
    @classmethod
    def actual_name(cls, value):
        value = ' '.join(value.split())
        if not value:
            raise ValueError('Enter the recipient name to print on this certificate')
        return value


class ClaimCertificate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    recipient_name: str | None = Field(default=None, max_length=200)


class Revocation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reason: str = Field(min_length=1, max_length=1000)

    @field_validator('reason')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('Provide a reason for revocation')
        return value.strip()


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str, allow_nan=False).encode()).hexdigest()


def completion_evidence(assignments, lessons, quizzes, homework):
    """Evaluate version-pinned course requirements."""
    evidence = []
    for assignment in assignments:
        if not assignment.get('required', True):
            continue
        identity = str(assignment['id'])
        kind = assignment['resource_type']
        item = {'assignment_id': identity, 'title': assignment['title'],
                'assignment_revision': assignment['revision'], 'resource_type': kind,
                'resource_id': str(assignment['resource_id']) if assignment.get('resource_id') else None,
                'resource_version': assignment.get('resource_version'), 'completed': False}
        if kind == 'lesson':
            progress = lessons.get(identity)
            item.update({'completed': bool(progress and progress['completed']),
                         'status': 'completed' if progress and progress['completed'] else 'Lesson completion required',
                         'updated_at': progress.get('updated_at') if progress else None})
        elif kind == 'quiz':
            attempt = quizzes.get(identity)
            threshold = assignment.get('minimum_score_percent') or 0
            percent = (attempt['score'] / attempt['max_score'] * 100) if attempt and attempt['max_score'] > 0 else None
            passed = bool(attempt and not attempt['pending_manual'] and percent is not None and percent >= threshold)
            status = ('Quiz submission required' if not attempt else 'Automatic quiz grading is pending' if attempt['pending_manual']
                      else 'Required quiz score not reached' if not passed else 'completed')
            item.update({'completed': passed, 'status': status, 'minimum_score_percent': threshold,
                         'score': attempt.get('score') if attempt else None,
                         'max_score': attempt.get('max_score') if attempt else None,
                         'pending_grading': attempt.get('pending_manual') if attempt else None,
                         'submission_id': str(attempt['id']) if attempt else None,
                         'grades_digest': _digest(attempt.get('grades', {})) if attempt else None})
        else:
            submission = homework.get(identity)
            reviewed = bool(submission and submission.get('reviewed_at') and submission['assignment_revision'] == assignment['revision'])
            item.update({'completed': reviewed, 'status': 'completed' if reviewed else 'Teacher review of current assignment required',
                         'submission_id': str(submission['id']) if submission else None,
                         'submission_revision': submission.get('revision') if submission else None,
                         'reviewed_at': submission.get('reviewed_at') if submission else None})
        evidence.append(item)
    return evidence


def _certificate_summary(row):
    if not row:
        return None
    return {field: row.get(field) for field in (
        'id', 'class_id', 'username', 'version', 'recipient_name', 'course_title',
        'instructor_name', 'issued_at', 'class_revision', 'revoked_at', 'revocation_reason',
        'email_status', 'emailed_at', 'email_recipient', 'email_error'
    )}


def _is_mock_db(db):
    info = getattr(db, 'info', None)
    return info is None or isinstance(info, Mock)


def _smtp_status():
    try:
        from app.smtp_settings import load_config
        cfg = load_config()
        return bool(cfg.get('enabled') and cfg.get('host') and cfg.get('from_address')), cfg
    except Exception:
        return False, {}


def deliver_certificate_email(db, cert_row):
    """Send the certificate by email with the course title when SMTP is enabled."""
    if not cert_row or _is_mock_db(db):
        return cert_row
    cert_id = str(cert_row['id'])
    username = cert_row.get('username') or ''
    profile = db.execute('SELECT email FROM bob_user_profiles WHERE username=%s', (username,)).fetchone()
    recipient_email = (profile.get('email') if profile else None) or (username if '@' in username else '')
    recipient_email = (recipient_email or '').strip()
    smtp_enabled, config = _smtp_status()
    if not smtp_enabled:
        updated = db.execute('''UPDATE learning.course_certificates
            SET email_status='pending_smtp', email_recipient=%s, email_error=NULL
            WHERE id=%s RETURNING *''', (recipient_email or None, cert_id)).fetchone()
        return updated or {**cert_row, 'email_status': 'pending_smtp', 'email_recipient': recipient_email or None, 'email_error': None}
    if not recipient_email:
        updated = db.execute('''UPDATE learning.course_certificates
            SET email_status='no_email', email_error='No email address configured on learner profile'
            WHERE id=%s RETURNING *''', (cert_id,)).fetchone()
        return updated or {**cert_row, 'email_status': 'no_email', 'email_error': 'No email address configured on learner profile'}
    try:
        from .course_certificate import certificate_html
        from app.smtp_settings import send_message
        from app.research_pdf import render_pdf
        pdf = from_thread.run(render_pdf, certificate_html(cert_row))
        course_title = cert_row['course_title']
        recipient_name = cert_row['recipient_name']
        subject = f"Certificate of Completion: {course_title}"
        body = (
            f"<html><body style='font-family:Segoe UI,Arial,sans-serif;color:#1e1633'>"
            f"<h2 style='color:#5a2d91'>{organization_label()} Learning &amp; Development</h2>"
            f"<p>Congratulations <strong>{escape(recipient_name)}</strong>,</p>"
            f"<p>You have completed the course <strong>{escape(course_title)}</strong>. "
            f"Your official {organization_label()} Certificate of Completion is attached to this email and is also available in your Learning workspace.</p>"
            f"<p style='font-size:12px;color:#655e70'>Certificate ID: {escape(cert_id)}</p>"
            f"</body></html>"
        )
        attachments = [(f"certificate-{cert_id}.pdf", pdf, "application/pdf")]
        send_message(config, recipient_email, subject, body, is_html=True, attachments=attachments, certificate_delivery=True)
        updated = db.execute('''UPDATE learning.course_certificates
            SET email_status='sent', emailed_at=now(), email_recipient=%s, email_error=NULL
            WHERE id=%s RETURNING *''', (recipient_email, cert_id)).fetchone()
        return updated or {**cert_row, 'email_status': 'sent', 'email_recipient': recipient_email, 'email_error': None}
    except Exception as exc:
        err_msg = str(exc)[:500]
        updated = db.execute('''UPDATE learning.course_certificates
            SET email_status='failed', email_recipient=%s, email_error=%s
            WHERE id=%s RETURNING *''', (recipient_email, err_msg, cert_id)).fetchone()
        return updated or {**cert_row, 'email_status': 'failed', 'email_recipient': recipient_email, 'email_error': err_msg}


def _roster(db, course, user):
    if course['can_manage']:
        rows = db.execute('''SELECT m.username,p.display_name FROM learning.class_members m
            LEFT JOIN bob_user_profiles p ON p.username=m.username
            WHERE m.class_id=%s ORDER BY COALESCE(p.display_name,m.username),m.username''', (str(course['id']),)).fetchall()
        if not rows and not _is_mock_db(db):
            rows = db.execute('''SELECT m.username,p.display_name FROM learning.members m
                LEFT JOIN bob_user_profiles p ON p.username=m.username
                WHERE m.folder_id=%s ORDER BY COALESCE(p.display_name,m.username),m.username''', (str(course['folder_id']),)).fetchall()
        return rows
    return [{'username': user['username'], 'display_name': user.get('display_name')}]


def _effective_requirements(db, course):
    class_id = str(course['id'])
    folder_id = str(course['folder_id'])
    assignments = list(db.execute('SELECT * FROM learning.class_assignments WHERE class_id=%s ORDER BY created_at,id', (class_id,)).fetchall())
    if _is_mock_db(db):
        return assignments
    linked_lessons = {str(a['resource_id']) for a in assignments if a.get('resource_type') == 'lesson' and a.get('resource_id')}
    linked_quizzes = {str(a['resource_id']) for a in assignments if a.get('resource_type') == 'quiz' and a.get('resource_id')}
    pub_lessons = db.execute('''SELECT id, COALESCE(published->>'title', title) AS title, version
        FROM learning.lessons WHERE folder_id=%s AND status='published'
        ORDER BY ordinal ASC, created_at ASC''', (folder_id,)).fetchall()
    for row in pub_lessons:
        if str(row['id']) not in linked_lessons:
            assignments.append({
                'id': f"lesson:{row['id']}",
                'title': row['title'],
                'revision': 1,
                'resource_type': 'lesson',
                'resource_id': row['id'],
                'resource_version': row['version'],
                'required': True,
                'minimum_score_percent': 0,
            })
    pub_quizzes = db.execute('''SELECT id, COALESCE(published->>'title', title) AS title, version
        FROM learning.quizzes WHERE folder_id=%s AND status='published'
        ORDER BY created_at ASC''', (folder_id,)).fetchall()
    for row in pub_quizzes:
        if str(row['id']) not in linked_quizzes:
            assignments.append({
                'id': f"quiz:{row['id']}",
                'title': row['title'],
                'revision': 1,
                'resource_type': 'quiz',
                'resource_id': row['id'],
                'resource_version': row['version'],
                'required': True,
                'minimum_score_percent': 0,
            })
    return assignments


def _requirement_keys(evidence):
    """Identify what was completed, independent of titles and class revisions."""
    return {(item.get('resource_type'), str(item.get('resource_id') or item.get('assignment_id')), item.get('resource_version'))
            for item in evidence or []}


def _needs_new_certificate(cert, evidence):
    """Issue only for first completion or a requirement the active certificate does not cover."""
    if not cert:
        return True
    if cert.get('revoked_at'):
        return False
    return bool(_requirement_keys(evidence) - _requirement_keys(cert.get('evidence')))


def _state(db, course, users, lock=False, auto_issue=False):
    class_id = str(course['id'])
    folder_id = str(course['folder_id'])
    assignments = _effective_requirements(db, course)
    identities = [row['username'] for row in users]
    if not identities:
        return []
    # Shared row locks during approval serialize changes to grading/progress with issuance.
    lesson_rows = list(db.execute('''SELECT a.id::text AS assignment_id,p.* FROM learning.lesson_progress p
        JOIN learning.class_assignments a ON a.resource_type='lesson' AND a.resource_id=p.lesson_id AND a.resource_version=p.version
        WHERE a.class_id=%s AND p.username=ANY(%s)''' + (' FOR SHARE OF p' if lock else ''), (class_id, identities)).fetchall())
    quiz_rows = list(db.execute('''SELECT a.id::text AS assignment_id,s.* FROM learning.submissions s
        JOIN learning.class_assignments a ON a.resource_type='quiz' AND a.resource_id=s.quiz_id AND a.resource_version=s.quiz_version
        WHERE a.class_id=%s AND s.username=ANY(%s)''' + (' FOR SHARE OF s' if lock else ''), (class_id, identities)).fetchall())
    if not _is_mock_db(db):
        direct_lessons = db.execute('''SELECT ('lesson:' || l.id::text) AS assignment_id, p.*
            FROM learning.lesson_progress p
            JOIN learning.lessons l ON l.id=p.lesson_id AND l.version=p.version
            WHERE l.folder_id=%s AND l.status='published' AND p.username=ANY(%s)''' + (' FOR SHARE OF p' if lock else ''),
            (folder_id, identities)).fetchall()
        lesson_rows.extend(direct_lessons)
        direct_quizzes = db.execute('''SELECT ('quiz:' || q.id::text) AS assignment_id, s.*
            FROM learning.submissions s
            JOIN learning.quizzes q ON q.id=s.quiz_id AND q.version=s.quiz_version
            WHERE q.folder_id=%s AND q.status='published' AND s.username=ANY(%s)''' + (' FOR SHARE OF s' if lock else ''),
            (folder_id, identities)).fetchall()
        quiz_rows.extend(direct_quizzes)
    work_rows = db.execute('''SELECT a.id::text AS assignment_id,s.* FROM learning.class_submissions s
        JOIN learning.class_assignments a ON a.id=s.assignment_id
        WHERE a.class_id=%s AND s.username=ANY(%s)''' + (' FOR SHARE OF s' if lock else ''), (class_id, identities)).fetchall()
    certificates = db.execute('''SELECT DISTINCT ON (username) * FROM learning.course_certificates
        WHERE class_id=%s AND username=ANY(%s) ORDER BY username,version DESC''', (class_id, identities)).fetchall()
    cert_by_user = {row['username']: row for row in certificates}
    result = []
    for person in users:
        username = person['username']
        index = lambda rows: {str(row['assignment_id']): row for row in rows if row['username'] == username}
        evidence = json.loads(json.dumps(completion_evidence(assignments, index(lesson_rows), index(quiz_rows), index(work_rows)), default=str, allow_nan=False))
        digest = _digest({'class_id': class_id, 'class_revision': course['revision'], 'title': course['title'],
                          'username': username, 'requirements': evidence})
        eligible = bool(evidence) and all(item['completed'] for item in evidence)
        cert = cert_by_user.get(username)
        if auto_issue and eligible and not course.get('archived') and not _is_mock_db(db):
            if _needs_new_certificate(cert, evidence):
                recipient_display = cert['recipient_name'] if cert else learner_display_name(person)
                if recipient_display == 'Learner':
                    prof = db.execute('SELECT display_name FROM bob_user_profiles WHERE username=%s', (username,)).fetchone()
                    recipient_display = (prof.get('display_name') if prof else None) or username
                instructor_display = course.get('teacher_display_name') or 'Course Teacher'
                issued_by = course.get('teacher_username') or course.get('created_by') or username
                new_version = (cert['version'] + 1) if cert else 1
                inserted = db.execute('''INSERT INTO learning.course_certificates
                    (id,class_id,username,version,recipient_name,course_title,instructor_name,issued_by,class_revision,evidence,evidence_digest,note)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (class_id,username,version) DO NOTHING RETURNING *''',
                    (str(uuid4()), class_id, username, new_version, recipient_display,
                     course['title'], instructor_display, issued_by, course['revision'],
                     Jsonb(evidence), digest, 'Automatically generated upon course completion')).fetchone()
                if inserted:
                    cert = deliver_certificate_email(db, inserted)
                    cert_by_user[username] = cert
        result.append({'username': username, 'display_name': learner_display_name(person),
                       'eligible': eligible,
                       'requirements': evidence, 'evidence_digest': digest,
                       'certificate': _certificate_summary(cert)})
    return result


def check_and_issue_for_folder(db, folder_id, username):
    """Automatically generate and email certificates when a learner finishes all course requirements."""
    if _is_mock_db(db):
        return []
    try:
        from .classrooms import ensure_folder_classes, class_identity
        ensure_folder_classes(db)
        classes = db.execute('SELECT * FROM learning.classes WHERE folder_id=%s AND NOT archived AND NOT deleted', (str(folder_id),)).fetchall()
        person = db.execute('''SELECT u.username, p.display_name FROM users u
            LEFT JOIN bob_user_profiles p ON p.username=u.username WHERE u.username=%s''', (username,)).fetchone()
        if not person:
            return []
        issued = []
        for row in classes:
            course = {**class_identity(db, row), 'can_manage': False}
            states = _state(db, course, [person], auto_issue=True)
            if states and states[0].get('certificate'):
                issued.append(states[0]['certificate'])
        return issued
    except Exception:
        return []


@router.get('/classes/{class_id}/completion')
def completion(class_id: UUID, user=Depends(current_user)):
    from .classrooms import authorize_class
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user)
        items = _state(db, course, _roster(db, course, user), auto_issue=True)
    smtp_enabled, _ = _smtp_status()
    return {'course': {key: course[key] for key in ('id', 'title', 'revision')},
            'can_manage': course['can_manage'], 'smtp_enabled': smtp_enabled, 'items': items}


@router.post('/classes/{class_id}/completion/claim', dependencies=[Depends(same_origin)])
def claim_completion_certificate(class_id: UUID, req: ClaimCertificate = ClaimCertificate(), user=Depends(current_user)):
    from .classrooms import authorize_class
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, lock=True)
        if course['archived']:
            raise HTTPException(409, 'This class is archived')
        person = {'username': user['username'], 'display_name': req.recipient_name.strip() if req.recipient_name and req.recipient_name.strip() else user.get('display_name')}
        state = _state(db, course, [person], lock=True, auto_issue=True)[0]
        if not state['eligible']:
            raise HTTPException(409, 'Complete all required lectures, quizzes, and assignments to generate your certificate')
        return {'issued': True, 'certificate': state['certificate']}


@router.post('/classes/{class_id}/completions/{username}/approve', dependencies=[Depends(same_origin)])
def approve_completion(class_id: UUID, username: str, req: Approval, user=Depends(current_user)):
    from .classrooms import authorize_class
    with job_queue._connect() as db:
        course = authorize_class(db, class_id, user, manage=True, lock=True)
        if course['archived']:
            raise HTTPException(409, 'Reopen this course before approving completion')
        if course['revision'] != req.expected_revision:
            raise HTTPException(409, 'Course requirements changed. Refresh completion evidence before approving.')
        member = db.execute('''SELECT m.username,u.is_admin FROM learning.class_members m
            JOIN users u ON u.username=m.username WHERE m.class_id=%s AND m.username=%s''', (str(class_id), username)).fetchone()
        if not member:
            raise HTTPException(404, 'Enrolled learner not found')
        try:
            store.folder(db, course['folder_id'], member)
        except HTTPException as error:
            raise HTTPException(409, 'This learner no longer has access to the course folder. Restore access before approving completion.') from error
        state = _state(db, course, [member], lock=True)[0]
        if state['evidence_digest'] != req.evidence_digest:
            raise HTTPException(409, 'Learner progress or marks changed. Refresh and review the current evidence.')
        if not state['eligible']:
            raise HTTPException(409, 'Complete every required assignment before approving the course')
        latest = db.execute('SELECT * FROM learning.course_certificates WHERE class_id=%s AND username=%s ORDER BY version DESC LIMIT 1', (str(class_id), username)).fetchone()
        if latest and not latest.get('revoked_at') and latest['evidence_digest'] == state['evidence_digest']:
            return {'issued': True, 'certificate': _certificate_summary(latest), 'existing': True}
        row = db.execute('''INSERT INTO learning.course_certificates
            (id,class_id,username,version,recipient_name,course_title,instructor_name,issued_by,class_revision,evidence,evidence_digest,note)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *''',
            (str(uuid4()), str(class_id), username, latest['version'] + 1 if latest else 1, req.recipient_name,
             course['title'], learner_display_name(user), user['username'], course['revision'],
             Jsonb(state['requirements']), state['evidence_digest'], req.note)).fetchone()
        if not _is_mock_db(db):
            row = deliver_certificate_email(db, row)
    return {'issued': True, 'certificate': _certificate_summary(row), 'existing': False}


@router.get('/certificates')
def list_user_certificates(user=Depends(current_user)):
    with job_queue._connect() as db:
        own_rows = db.execute('''SELECT DISTINCT ON (class_id) *
            FROM learning.course_certificates
            WHERE username=%s
            ORDER BY class_id, version DESC, issued_at DESC''', (user['username'],)).fetchall()
        own = []
        for row in own_rows:
            try:
                authorized_certificate(db, row['id'], user)
                own.append(_certificate_summary(row))
            except HTTPException:
                continue
    smtp_enabled, _ = _smtp_status()
    return {'items': own, 'smtp_enabled': smtp_enabled}


def authorized_certificate(db, certificate_id, user, manage=False, lock=False):
    from .classrooms import authorize_class
    row = db.execute('SELECT * FROM learning.course_certificates WHERE id=%s', (str(certificate_id),)).fetchone()
    if not row:
        raise HTTPException(404, 'Certificate not found')
    course = authorize_class(db, row['class_id'], user, manage=manage, lock=lock)
    if not course['can_manage'] and row['username'] != user['username']:
        raise HTTPException(404, 'Certificate not found')
    return row


@router.post('/certificates/{certificate_id}/send-email', dependencies=[Depends(same_origin)])
def send_certificate_email_endpoint(certificate_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        row = authorized_certificate(db, certificate_id, user)
        if row.get('revoked_at'):
            raise HTTPException(409, 'Revoked certificates cannot be emailed')
        updated = deliver_certificate_email(db, row)
    smtp_enabled, _ = _smtp_status()
    summary = _certificate_summary(updated) or {}
    return {
        'certificate': summary,
        'smtp_enabled': smtp_enabled,
        'delivery': {
            'status': summary.get('email_status'),
            'recipient': summary.get('email_recipient'),
            'error': summary.get('email_error'),
        },
    }


@router.post('/certificates/{certificate_id}/revoke', dependencies=[Depends(same_origin)])
def revoke_certificate(certificate_id: UUID, req: Revocation, user=Depends(current_user)):
    with job_queue._connect() as db:
        row = authorized_certificate(db, certificate_id, user, manage=True, lock=True)
        db.execute('''UPDATE learning.course_certificates SET revoked_at=COALESCE(revoked_at,now()),
            revocation_reason=COALESCE(revocation_reason,%s) WHERE id=%s''', (req.reason, str(row['id'])))
    return {'revoked': True}


@router.get('/certificates/{certificate_id}/download')
async def download_certificate(
    certificate_id: UUID,
    format: str = Query(default='html', pattern='^(html|pdf)$'),
    inline: bool = Query(default=False),
    user=Depends(current_user),
):
    def load():
        with job_queue._connect() as db:
            return authorized_certificate(db, certificate_id, user)
    row = await run_in_threadpool(load)
    from .course_certificate import certificate_html
    document = certificate_html(row)
    name = 'certificate-' + str(row['id'])
    disposition = 'inline' if inline else 'attachment'
    headers = {'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'}
    if format == 'pdf':
        from app.research_pdf import render_pdf
        data = await render_pdf(document)
        return Response(data, media_type='application/pdf', headers={**headers, 'Content-Disposition': f'{disposition}; filename="{name}.pdf"'})
    return HTMLResponse(document, headers={**headers, 'Content-Disposition': f'{disposition}; filename="{name}.html"',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"})
