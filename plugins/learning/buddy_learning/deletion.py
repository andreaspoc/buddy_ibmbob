"""Author-only deletion, serialized against learner activity in the same folder."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from app import job_queue
from app.auth import current_user
from . import store
from .service import same_origin, teacher

router = APIRouter(prefix='/api/learning')


@router.post('/quizzes/{quiz_id}/start', dependencies=[Depends(same_origin)])
def start_quiz(quiz_id: UUID, user=Depends(current_user)):
    with job_queue._connect() as db:
        row = store.quiz(db, quiz_id, user, lock=True)
        if row['status'] != 'published':
            raise HTTPException(409, 'Only a published quiz can be started')
        db.execute('''INSERT INTO learning.quiz_starts(quiz_id,username) VALUES(%s,%s)
            ON CONFLICT(quiz_id,username) DO NOTHING''', (str(quiz_id), user['username']))
    return {'started': True}


@router.delete('/quizzes/{quiz_id}', dependencies=[Depends(same_origin)])
def delete_quiz(quiz_id: UUID, user=Depends(teacher)):
    with job_queue._connect() as db:
        row = store.quiz(db, quiz_id, user, lock=True)
        store.creator(row, user)
        if row['status'] != 'draft' or row['version'] != 0 or row.get('published'):
            raise HTTPException(409, 'Only an unpublished draft quiz can be deleted. Existing quiz versions and results are preserved.')
        used = db.execute('''SELECT 1 WHERE
            EXISTS(SELECT 1 FROM learning.submissions WHERE quiz_id=%s) OR
            EXISTS(SELECT 1 FROM learning.quiz_starts WHERE quiz_id=%s) OR
            EXISTS(SELECT 1 FROM learning.class_assignments WHERE resource_type='quiz' AND resource_id=%s)''',
            (str(quiz_id), str(quiz_id), str(quiz_id))).fetchone()
        if used:
            raise HTTPException(409, 'This quiz has learner activity or is assigned to a class and cannot be deleted.')
        db.execute('DELETE FROM learning.quizzes WHERE id=%s', (str(quiz_id),))
    return {'deleted': True}


@router.delete('/classes/{class_id}', dependencies=[Depends(same_origin)])
def delete_class(class_id: UUID, user=Depends(teacher)):
    with job_queue._connect() as db:
        row = db.execute('SELECT * FROM learning.classes WHERE id=%s', (str(class_id),)).fetchone()
        if not row or row.get('deleted'):
            raise HTTPException(404, 'Class not found')
        if row['created_by'] != user['username']:
            raise HTTPException(403, 'Only the class author can delete it')
        fid = str(row['folder_id'])
        # Activity routes take a shared folder lock through store.folder().
        # Wait for them, then recheck activity before hiding the unused class.
        db.execute('SELECT id FROM learning.folders WHERE id=%s FOR UPDATE', (fid,))
        store.folder(db, fid, user)
        primary = str(row['id']) == fid
        if primary and db.execute('''SELECT 1 WHERE
            EXISTS(SELECT 1 FROM learning.folders WHERE parent_id=%s AND NOT deleted) OR
            EXISTS(SELECT 1 FROM learning.classes WHERE folder_id=%s AND id<>%s AND NOT deleted)''',
            (fid, fid, str(class_id))).fetchone():
            raise HTTPException(409, 'Delete nested classes and other classes using this library first.')
        used = db.execute('''SELECT 1 WHERE
            EXISTS(SELECT 1 FROM learning.submissions s JOIN learning.quizzes q ON q.id=s.quiz_id WHERE q.folder_id=%s) OR
            EXISTS(SELECT 1 FROM learning.quiz_starts s JOIN learning.quizzes q ON q.id=s.quiz_id WHERE q.folder_id=%s) OR
            EXISTS(SELECT 1 FROM learning.lesson_progress p JOIN learning.lessons l ON l.id=p.lesson_id WHERE l.folder_id=%s AND p.username<>%s) OR
            EXISTS(SELECT 1 FROM learning.progress p JOIN learning.books b ON b.id=p.book_id WHERE b.folder_id=%s AND p.username<>%s) OR
            EXISTS(SELECT 1 FROM learning.reader_notes n JOIN learning.books b ON b.id=n.book_id WHERE b.folder_id=%s AND n.username<>%s) OR
            EXISTS(SELECT 1 FROM learning.class_notes WHERE folder_id=%s AND username<>%s) OR
            EXISTS(SELECT 1 FROM learning.class_submissions s JOIN learning.class_assignments a ON a.id=s.assignment_id WHERE a.class_id=%s) OR
            EXISTS(SELECT 1 FROM learning.course_certificates WHERE class_id=%s)''',
            (fid, fid, fid, user['username'], fid, user['username'], fid, user['username'], fid, user['username'], str(class_id), str(class_id))).fetchone()
        if used:
            raise HTTPException(409, 'Learners have started this class. Keep it or archive it to preserve their work and results.')
        db.execute('UPDATE learning.classes SET deleted=true,revision=revision+1 WHERE id=%s', (str(class_id),))
        if primary:
            # Retain source rows and objects; no submissions or results are erased.
            db.execute('UPDATE learning.folders SET deleted=true WHERE id=%s', (fid,))
    return {'deleted': True, 'folder_deleted': primary}
