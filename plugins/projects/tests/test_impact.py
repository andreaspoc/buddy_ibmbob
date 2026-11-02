import unittest
from datetime import date
from buddy_projects.impact import analyze

class ImpactTests(unittest.TestCase):
    def fixture(self):
        return {'projects': [{'id': i, 'status': 'active', 'due_date': None} for i in (1, 2, 3)],
          'people': [{'id': 'alice', 'status': 'active'}, {'id': 'backup', 'status': 'active'}],
          'assignments': [{'id': 1, 'project_id': 1, 'person_id': 'alice', 'responsibility': 'Approval', 'backup_person_id': None}],
          'dependencies': [{'id': 1, 'source_project_id': 1, 'target_project_id': 2, 'description': 'Delivery'},
                           {'id': 2, 'source_project_id': 2, 'target_project_id': 3, 'description': 'Release'},
                           {'id': 3, 'source_project_id': 3, 'target_project_id': 1, 'description': 'Cycle'}]}
    def test_departure_direct_gap_downstream_risk_and_cycle(self):
        data = self.fixture()
        result = analyze(data, {'kind': 'person_departure', 'person_id': 'alice', 'status': 'departed'})
        self.assertEqual(result['summary'], {'confirmed': 1, 'risks': 2, 'affected_projects': 3})
        self.assertEqual(result['items'][-1]['path'], [1,2,3])
        self.assertEqual(data['people'][0]['status'], 'active')
    def test_backup_is_risk_not_confirmed_gap(self):
        data = self.fixture()
        data['assignments'][0]['backup_person_id'] = 'backup'
        self.assertEqual(analyze(data, {'kind':'person_departure','person_id':'alice','status':'departed'})['summary']['confirmed'], 0)
    def test_completed_project_not_affected(self):
        data = self.fixture()
        data['projects'][0]['status'] = 'completed'
        self.assertEqual(analyze(data, {'kind':'person_departure','person_id':'alice','status':'departed'})['items'], [])
    def test_milestone_priority_and_status_changes_trace_dependencies(self):
        for key,value in [('start_date','2027-01-01'),('milestone','New release'),('priority','high'),('status','planned'),('description','Expanded scope')]:
            result = analyze(self.fixture(), {'kind':'project_change','project_id':1,key:value})
            self.assertEqual(result['summary'], {'confirmed':1,'risks':2,'affected_projects':3})
            self.assertEqual(result['items'][0]['evidence']['changes'][key]['after'], value)
    def work(self, kind='task', status='todo', due=None):
        data = self.fixture()
        data['work_items'] = [{'id':10,'project_id':1,'kind':kind,'status':status,'title':'Recorded item','due_date':due,'owner_id':'alice'}]
        return data
    def test_blocked_tasks_and_issues_trace_evidence(self):
        for kind,status in [('task','blocked'),('issue','open')]:
            result = analyze(self.work(kind,status), today=date(2027,1,5))
            self.assertEqual(result['summary'], {'confirmed':1,'risks':2,'affected_projects':3})
            self.assertEqual(result['items'][0]['evidence']['work_item_id'],10)
    def test_risks_and_pending_decisions_are_not_confirmed_delays(self):
        for kind,status in [('risk','mitigating'),('decision','proposed')]:
            result = analyze(self.work(kind,status), today=date(2027,1,5))
            self.assertEqual(result['summary'], {'confirmed':0,'risks':3,'affected_projects':3})
    def test_task_due_date_uses_injected_day_and_done_is_clear(self):
        data = self.work(due='2027-01-05')
        self.assertEqual(analyze(data,today=date(2027,1,5))['items'],[])
        result = analyze(data,today=date(2027,1,6))
        self.assertEqual(result['summary']['confirmed'],1)
        self.assertEqual(result['items'][0]['evidence']['as_of'],'2027-01-06')
        data['work_items'][0]['status']='done'
        self.assertEqual(analyze(data,today=date(2027,1,6))['items'],[])
    def test_closed_raid_items_and_completed_projects_are_clear(self):
        for kind,status in [('risk','resolved'),('issue','resolved'),('decision','approved'),('decision','declined')]:
            self.assertEqual(analyze(self.work(kind,status))['items'],[])
        data=self.work(status='blocked')
        data['projects'][0]['status']='completed'
        self.assertEqual(analyze(data)['items'],[])
    def test_work_owner_departure_without_assignment_is_traced(self):
        data=self.work()
        data['assignments']=[]
        result=analyze(data,{'kind':'person_departure','person_id':'alice','status':'departed'})
        self.assertEqual(result['summary'],{'confirmed':1,'risks':2,'affected_projects':3})
        self.assertEqual(result['items'][0]['evidence']['work_item_id'],10)
        self.assertEqual(result['items'][0]['evidence']['person_id'],'alice')
        data['work_items'][0]['status']='done'
        self.assertEqual(analyze(data,{'kind':'person_departure','person_id':'alice','status':'departed'})['items'],[])
    def test_empty_portfolio(self):
        self.assertEqual(analyze({'projects': [], 'people': [], 'assignments': [], 'dependencies': []})['summary']['affected_projects'], 0)
    def test_due_change_preserves_dates_without_claiming_delay(self):
        result = analyze(self.fixture(), {'kind':'project_change', 'project_id':1, 'due_date':'2027-01-01'})
        self.assertEqual(result['summary']['confirmed'], 1)
        self.assertEqual(result['summary']['risks'], 2)

    def test_prince2_tolerance_and_exceptions(self):
        data = self.fixture()
        data['projects'][0]['exception_status'] = 'breached'
        result = analyze(data, today=date(2027, 1, 1))
        # Breached tolerance triggers confirmed exception on project 1 + downstream risks on 2 and 3
        self.assertEqual(result['summary']['confirmed'], 1)
        self.assertEqual(result['summary']['risks'], 2)
        self.assertIn('PRINCE2 Exception', result['items'][0]['reason'])

        # Threatened tolerance triggers risk
        data['projects'][0]['exception_status'] = 'threatened'
        res_threatened = analyze(data, today=date(2027, 1, 1))
        self.assertEqual(res_threatened['summary']['confirmed'], 0)
        self.assertEqual(res_threatened['summary']['risks'], 3)

    def test_prince2_time_tolerance_overdue(self):
        data = self.fixture()
        # Due 2027-01-01, tolerance 5 days
        data['projects'][0]['due_date'] = '2027-01-01'
        data['projects'][0]['tolerance_days'] = 5
        # On 2027-01-04 (3 days over <= 5 tolerance days): warning risk
        res_within = analyze(data, today=date(2027, 1, 4))
        self.assertEqual(res_within['summary']['confirmed'], 0)
        self.assertEqual(res_within['summary']['risks'], 3)
        self.assertIn('within PRINCE2 tolerance', res_within['items'][0]['reason'])

        # On 2027-01-10 (9 days over > 5 tolerance days): confirmed exception
        res_exceeded = analyze(data, today=date(2027, 1, 10))
        self.assertEqual(res_exceeded['summary']['confirmed'], 1)
        self.assertIn('PRINCE2 Exception', res_exceeded['items'][0]['reason'])

    def test_project_due_date_tolerance_boundaries(self):
        for tolerance in (None, 0, 5):
            data = self.fixture()
            data['projects'][0].update(due_date='2027-01-01', tolerance_days=tolerance)
            with self.subTest(tolerance=tolerance):
                self.assertEqual(analyze(data, today=date(2027, 1, 1))['items'], [])
                first_overdue = analyze(data, today=date(2027, 1, 2))
                self.assertEqual(first_overdue['summary']['confirmed'], 0 if tolerance else 1)
                self.assertEqual(first_overdue['items'][0]['evidence']['days_over'], 1)
                if tolerance:
                    self.assertEqual(analyze(data, today=date(2027, 1, 6))['summary']['confirmed'], 0)
                    self.assertEqual(analyze(data, today=date(2027, 1, 7))['summary']['confirmed'], 1)
                data['projects'][0]['status'] = 'completed'
                self.assertEqual(analyze(data, today=date(2027, 1, 10))['items'], [])

    def test_milestone_alerts_use_recorded_status_and_date(self):
        for status, due, expected in [('todo', '2027-01-01', 1),
                                      ('blocked', None, 1), ('done', '2027-01-01', 0),
                                      ('todo', '2027-01-05', 0)]:
            with self.subTest(status=status, due=due):
                data = self.work(kind='milestone', status=status, due=due)
                result = analyze(data, today=date(2027, 1, 5))
                self.assertEqual(result['summary']['confirmed'], expected)
                if expected:
                    self.assertIn('milestone', result['items'][0]['reason'])
                data['projects'][0]['status'] = 'completed'
                self.assertEqual(analyze(data, today=date(2027, 1, 5))['items'], [])

    def test_prince2_deliverables_and_lessons(self):
        data = self.work(kind='deliverable', status='quality_review')
        res = analyze(data, today=date(2027, 1, 5))
        self.assertEqual(res['summary']['confirmed'], 0)
        self.assertEqual(res['summary']['risks'], 3)
        self.assertIn('quality review', res['items'][0]['reason'])

        # Overdue deliverable
        data_overdue = self.work(kind='deliverable', status='in_development', due='2027-01-01')
        res_overdue = analyze(data_overdue, today=date(2027, 1, 5))
        self.assertEqual(res_overdue['summary']['confirmed'], 1)
        self.assertIn('product deliverable', res_overdue['items'][0]['reason'])

        # Accepted deliverable is clear
        data_accepted = self.work(kind='deliverable', status='accepted', due='2027-01-01')
        res_accepted = analyze(data_accepted, today=date(2027, 1, 5))
        self.assertEqual(res_accepted['items'], [])

if __name__ == '__main__':
    unittest.main()
