"""Synthetic classroom routes: no real courses, learner records, grants, or model calls."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch
from uuid import UUID
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.auth import current_user
from buddy_learning import classrooms as api
from buddy_learning.classroom_models import Assignment, Feedback, Session

FOLDER='11111111-1111-4111-8111-111111111111'
CLASS='22222222-2222-4222-8222-222222222222'
ASSIGNMENT='33333333-3333-4333-8333-333333333333'
SUBMISSION='44444444-4444-4444-8444-444444444444'
RESOURCE='55555555-5555-4555-8555-555555555555'


class Cursor:
    def __init__(self, row=None, rows=None):
        self.row=row
        self.rows=rows if rows is not None else []
    def fetchone(self): return self.row
    def fetchall(self): return self.rows


class Database:
    def __init__(self):
        self.course={'id':CLASS,'folder_id':FOLDER,'title':'Synthetic human class','description':'Authored material',
                     'created_by':'teacher','teacher_username':'teacher','archived':False,'revision':1}
        self.enrolled={'learner'}
        self.users=[{'username':'learner','display_name':'Fixture learner','is_admin':False},
                    {'username':'outsider','display_name':'Fixture outsider','is_admin':False}]
        self.item={'id':ASSIGNMENT,'class_id':CLASS,'title':'Written reflection','instructions':'Explain your reasoning',
                   'section':'Week 1','due_at':None,'allow_late':True,'required':True,'minimum_score_percent':0,
                   'resource_type':'none','resource_id':None,'resource_version':None,'revision':1}
        self.previous=None
        self.writes=[]
        self.feedback=None
    def execute(self, sql, params=()):
        compact=' '.join(sql.split())
        if compact.startswith('SELECT display_name FROM bob_user_profiles'):
            return Cursor({'display_name':'Human '+params[0]})
        if compact.startswith('SELECT username,is_admin FROM users'):
            return Cursor({'username':params[0],'is_admin':False} if params[0] in {'teacher','other-teacher','learner','outsider','administrator'} else None)
        if compact.startswith('SELECT * FROM learning.classes'):
            return Cursor(deepcopy(self.course) if params[0]==str(self.course['id']) else None)
        if compact.startswith('SELECT 1 FROM learning.class_members'):
            return Cursor({'allowed':1} if params[1] in self.enrolled else None)
        if compact.startswith('SELECT username FROM learning.class_members WHERE class_id='):
            return Cursor(rows=[{'username': username} for username in self.enrolled])
        if compact.startswith('SELECT DISTINCT u.username'):
            return Cursor(rows=deepcopy(self.users))
        if compact.startswith('SELECT m.username'):
            return Cursor(rows=[row for row in self.users if row['username'] in self.enrolled])
        if compact.startswith('SELECT * FROM learning.class_assignments WHERE id='):
            return Cursor(deepcopy(self.item) if params[0]==ASSIGNMENT and params[1]==str(self.item['class_id']) else None)
        if compact.startswith('SELECT * FROM learning.class_assignments WHERE class_id='):
            return Cursor(rows=[deepcopy(self.item)])
        if compact.startswith('SELECT * FROM learning.class_submissions WHERE assignment_id='):
            return Cursor(deepcopy(self.previous))
        if compact.startswith('SELECT * FROM learning.class_submissions WHERE id='):
            return Cursor(deepcopy(self.previous) if self.previous and params[0]==self.previous['id'] and params[1]==self.previous['assignment_id'] else None)
        if compact.startswith('SELECT s.* FROM learning.class_submissions s JOIN'):
            return Cursor(rows=[deepcopy(self.previous)] if self.previous and self.previous['username']==params[1] else [])
        if compact.startswith(('INSERT','UPDATE','DELETE')):
            self.writes.append((compact,params))
            if compact.startswith('INSERT INTO learning.classes'):
                return Cursor({**self.course,'id':params[0],'created_by':params[4],'teacher_username':params[5]})
            if compact.startswith('DELETE FROM learning.class_members'):
                self.enrolled.clear()
            if compact.startswith('INSERT INTO learning.class_members'):
                self.enrolled.add(params[1])
            if compact.startswith('UPDATE learning.classes SET title='):
                self.course.update(title=params[0],description=params[1],archived=params[2],teacher_username=params[3],revision=self.course['revision']+1)
                return Cursor(deepcopy(self.course))
            if compact.startswith('UPDATE learning.classes SET revision='):
                self.course['revision']+=1
            if compact.startswith('INSERT INTO learning.class_submissions'):
                self.previous={'id':params[0],'assignment_id':params[1],'username':params[2],'text':params[3],
                    'assignment_revision':params[4],'assignment_snapshot':params[5].obj,'revision':1,'reviewed_at':None,
                    'feedback':'','mark':None,'max_mark':None}
                return Cursor(deepcopy(self.previous))
            if compact.startswith('UPDATE learning.class_submissions SET feedback='):
                self.previous.update(feedback=params[0],mark=params[1],max_mark=params[2],reviewed_by=params[3],
                                     reviewed_at=datetime.now(timezone.utc),revision=self.previous['revision']+1)
                return Cursor(deepcopy(self.previous))
            return Cursor({'id':ASSIGNMENT,'revision':1})
        raise AssertionError('Unexpected synthetic query: '+compact)


class ClassroomTests(unittest.TestCase):
    def setUp(self):
        self.db=Database()
        self.user={'username':'learner','is_admin':False}
        self.denied=set()
        self.teachers={'teacher','other-teacher'}
        @contextmanager
        def connect(): yield self.db
        def folder(db, folder_id, user):
            if user['username'] in self.denied or user['username']=='outsider':
                raise HTTPException(404,'Folder not found')
            return {'id':str(folder_id)}
        self.enterContext(patch.object(api.job_queue,'_connect',connect))
        self.enterContext(patch.object(api.store,'folder',side_effect=folder))
        self.enterContext(patch.object(api.store,'can_create',side_effect=lambda db,u:u['username'] in self.teachers or u.get('is_admin',False)))
        app=FastAPI()
        app.include_router(api.router)
        app.dependency_overrides[current_user]=lambda:self.user
        self.client=TestClient(app)
        self.addCleanup(self.client.close)
        self.url='/api/learning/classes/'+CLASS
    def teacher(self): self.user={'username':'teacher','is_admin':False}
    def homework(self,**change): return {'text':'My manually written answer','expected_revision':1,**change}

    def test_enrollment_and_folder_access_are_both_required(self):
        self.assertEqual(self.client.get(self.url).status_code,200)
        self.db.enrolled.clear()
        self.assertEqual(self.client.get(self.url).status_code,404)
        self.db.enrolled.add('learner');self.denied.add('learner')
        self.assertEqual(self.client.get(self.url).status_code,404)

    def test_owner_teacher_or_admin_can_manage_but_other_teachers_cannot(self):
        self.teacher()
        self.assertTrue(self.client.get(self.url).json()['can_manage'])
        data={'title':'Manual update','description':'Teacher-authored','expected_revision':1,'archived':False}
        self.assertEqual(self.client.put(self.url,json=data).status_code,200)
        self.assertEqual(self.client.put(self.url,json=data).status_code,409)
        self.user={'username':'other-teacher','is_admin':False}
        self.assertEqual(self.client.put(self.url,json=data).status_code,403)
        self.user={'username':'administrator','is_admin':True}
        data['expected_revision']=2
        self.assertEqual(self.client.put(self.url,json=data).status_code,200)

    def test_teacher_can_manually_create_class_without_ai(self):
        self.teacher()
        response=self.client.post('/api/learning/folders/'+FOLDER+'/classes',json={'title':'Manual class','description':'Human syllabus'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.db.writes[-1][1][2:4],('Manual class','Human syllabus'))

    def test_eligible_roster_does_not_grant_folder_access_or_accept_unknown_users(self):
        self.teacher()
        response=self.client.get(self.url+'/candidates')
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual([row['username'] for row in response.json()['items']],['learner'])
        self.assertEqual(self.client.put(self.url+'/members',json={'usernames':['outsider']}).status_code,422)
        self.assertFalse(self.db.writes)
        self.assertEqual(self.client.put(self.url+'/members',json={'usernames':['learner']}).status_code,200)
        self.assertEqual(self.db.course['revision'],2)

    def test_enrollment_notifies_only_new_members(self):
        self.teacher()
        self.db.enrolled.clear()
        with patch.object(api, 'notify_enrolled') as notify:
            response = self.client.put(self.url + '/members', json={'usernames': ['learner']})
            self.assertEqual(response.status_code, 200)
            notify.assert_called_once_with('Synthetic human class', ['learner'])
            notify.reset_mock()
            response = self.client.put(self.url + '/members', json={'usernames': ['learner']})
            self.assertEqual(response.status_code, 200)
            notify.assert_called_once_with('Synthetic human class', [])

    def test_homework_is_private_versioned_and_cannot_replace_reviewed_work(self):
        url=self.url+'/assignments/'+ASSIGNMENT+'/submit'
        response=self.client.post(url,json=self.homework())
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['assignment_snapshot']['instructions'],'Explain your reasoning')
        self.assertEqual(response.json()['username'],'learner')
        self.assertEqual(self.client.get(self.url+'/assignments').json()['items'][0]['my_submission']['text'],'My manually written answer')
        self.db.previous['username']='someone-else'
        self.assertIsNone(self.client.get(self.url+'/assignments').json()['items'][0]['my_submission'])
        self.db.previous['username']='learner';self.db.previous['reviewed_at']=datetime.now(timezone.utc)
        self.assertEqual(self.client.post(url,json=self.homework()).status_code,409)

    def test_deadlines_revisions_and_archival_prevent_submission(self):
        url=self.url+'/assignments/'+ASSIGNMENT+'/submit'
        self.assertEqual(self.client.post(url,json=self.homework(expected_revision=2)).status_code,409)
        self.db.item.update(due_at=datetime.now(timezone.utc)-timedelta(days=1),allow_late=False)
        self.assertEqual(self.client.post(url,json=self.homework()).status_code,409)
        self.db.item['allow_late']=True
        self.assertEqual(self.client.post(url,json=self.homework()).status_code,200)
        self.db.course['archived']=True
        self.assertEqual(self.client.post(url,json=self.homework()).status_code,409)

    def test_teacher_feedback_uses_submission_revision_and_students_cannot_write_it(self):
        self.client.post(self.url+'/assignments/'+ASSIGNMENT+'/submit',json=self.homework())
        url=self.url+'/assignments/'+ASSIGNMENT+'/submissions/'+str(self.db.previous['id'])+'/feedback'
        data={'feedback':'Explain the second step more clearly','mark':8,'max_mark':10,'expected_revision':1}
        self.assertEqual(self.client.put(url,json=data).status_code,403)
        self.teacher()
        response=self.client.put(url,json=data)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['reviewed_by'],'teacher')
        self.assertEqual(self.client.put(url,json=data).status_code,409)

    def test_assignment_resource_must_be_published_and_from_same_folder(self):
        self.teacher()
        data={'title':'Practice','instructions':'Complete linked material','resource_type':'quiz','resource_id':RESOURCE}
        with patch.object(api.store,'quiz',return_value={'folder_id':FOLDER,'status':'draft','version':0}):
            self.assertEqual(self.client.post(self.url+'/assignments',json=data).status_code,422)
        with patch.object(api.store,'quiz',return_value={'folder_id':RESOURCE,'status':'published','version':1}):
            self.assertEqual(self.client.post(self.url+'/assignments',json=data).status_code,422)
        with patch.object(api.store,'quiz',return_value={'folder_id':FOLDER,'status':'published','version':3}):
            self.assertEqual(self.client.post(self.url+'/assignments',json=data).status_code,200)
            self.assertEqual(self.db.writes[-1][1][9],3)

    def test_cross_origin_writes_rejected(self):
        self.teacher()
        self.assertEqual(self.client.post(self.url+'/announcements',json={'title':'Class','body':'Human note'},headers={'origin':'https://other.invalid'}).status_code,403)

    def test_cross_class_and_cross_assignment_ids_do_not_expose_work(self):
        self.assertEqual(self.client.get('/api/learning/classes/'+RESOURCE).status_code,404)
        self.db.item['class_id']=RESOURCE
        self.assertEqual(self.client.get(self.url+'/assignments/'+ASSIGNMENT).status_code,404)
        self.db.item['class_id']=CLASS
        self.client.post(self.url+'/assignments/'+ASSIGNMENT+'/submit',json=self.homework())
        self.teacher()
        self.db.previous['assignment_id']=RESOURCE
        url=self.url+'/assignments/'+ASSIGNMENT+'/submissions/'+str(self.db.previous['id'])+'/feedback'
        self.assertEqual(self.client.put(url,json={'feedback':'Review','expected_revision':1}).status_code,404)

    def test_admin_assigns_teacher_per_course_and_preserves_creator_audit(self):
        self.user={'username':'administrator','is_admin':True}
        data={'title':'Assigned course','description':'Human course','teacher_username':'other-teacher'}
        created=self.client.post('/api/learning/folders/'+FOLDER+'/classes',json=data)
        self.assertEqual(created.status_code,200,created.text)
        self.assertEqual(created.json()['created_by'],'administrator')
        self.assertEqual(created.json()['teacher_username'],'other-teacher')
        self.assertEqual(created.json()['teacher_display_name'],'Human other-teacher')
        updated=self.client.put(self.url,json={**data,'expected_revision':1,'archived':False})
        self.assertEqual(updated.status_code,200,updated.text)
        self.assertEqual(self.db.course['created_by'],'teacher')
        self.teacher()
        self.assertEqual(self.client.get(self.url).status_code,404)
        self.db.enrolled.add('teacher')
        self.assertFalse(self.client.get(self.url).json()['can_manage'])
        self.assertEqual(self.client.put(self.url,json={**data,'expected_revision':2,'archived':False}).status_code,403)
        self.user={'username':'other-teacher','is_admin':False}
        self.assertTrue(self.client.get(self.url).json()['can_manage'])
        self.teachers.remove('other-teacher')
        self.assertEqual(self.client.put(self.url,json={**data,'expected_revision':2,'archived':False}).status_code,403)

    def test_nonadmin_cannot_assign_another_teacher_and_invalid_assignment_rejected(self):
        self.teacher()
        path='/api/learning/folders/'+FOLDER+'/classes'
        self.assertEqual(self.client.post(path,json={'title':'Course','teacher_username':'other-teacher'}).status_code,403)
        self.assertEqual(self.client.put(self.url,json={'title':'Course','expected_revision':1,'teacher_username':'other-teacher'}).status_code,403)
        self.user={'username':'administrator','is_admin':True}
        for identity in ('learner','unknown'):
            self.assertEqual(self.client.post(path,json={'title':'Course','teacher_username':identity}).status_code,422)
        self.denied.add('other-teacher')
        self.assertEqual(self.client.post(path,json={'title':'Course','teacher_username':'other-teacher'}).status_code,422)

    def test_manual_input_validation(self):
        for data in ({'title':'Lesson','starts_at':'2026-11-01T10:00:00','ends_at':'2026-11-01T11:00:00'},
                     {'title':'Lesson','starts_at':'2026-11-01T11:00:00Z','ends_at':'2026-11-01T10:00:00Z'}):
            with self.assertRaises(ValueError): Session.model_validate(data)
        with self.assertRaises(ValueError):
            Assignment(title='Homework',instructions='Human task',minimum_score_percent=50)
        with self.assertRaises(ValueError):
            Feedback(feedback='Human feedback',mark=11,max_mark=10,expected_revision=1)

if __name__=='__main__': unittest.main()
