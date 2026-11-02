"""Access previews must match personal retrieval and audit pagination is stable."""
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
from app import rag, access_views

GA = '11111111-1111-4111-8111-111111111111'
GB = '22222222-2222-4222-8222-222222222222'


class AccessViewsTests(unittest.TestCase):
    def test_preview_uses_personal_predicate_without_admin_bypass(self):
        for groups in ([], [GA], [GA, GB]):
            profile = {'groups': groups, 'is_admin': True}
            expected = rag.profile_access_filter(profile)
            with patch('app.auth.knowledge_access', return_value=profile):
                self.assertEqual(rag.access_filter('test'), expected)
                self.assertEqual(rag.access_filter('test', admin=True), ('TRUE', ()))
            self.assertEqual(expected[1], (groups,))

    def test_summary_does_not_give_admin_extra_personal_libraries(self):
        summary = access_views.access_summary({'groups': [], 'is_admin': True})
        self.assertEqual(summary['audiences'], ['both'])
        self.assertEqual([library['id'] for library in summary['libraries']], ['company'])
        summary = access_views.access_summary({'groups': [{'id': GB, 'name': 'B'}]})
        self.assertEqual(summary['audiences'], ['both', GB])
        self.assertEqual(access_views.access_summary({'groups': [GA]})['audiences'], ['both', GA])

    def test_audit_cursor_and_filters_bound_to_query(self):
        db = MagicMock()
        now = datetime.now(timezone.utc)
        db.execute.return_value.fetchall.return_value = [
            (5, 'admin', 'Administrator', 'classify-document', 'doc', {'before': {}, 'after': {}}, now, 'doc'),
            (4, 'admin', 'Administrator', 'classify-document', 'doc2', {}, now, 'doc2'),
            (3, 'admin', 'Administrator', 'classify-document', 'doc3', {}, now, 'doc3')]
        @contextmanager
        def connection():
            yield db
        with patch.object(access_views, '_connect', connection):
            result = access_views.audit({'is_admin': True}, 2, 6, 'admin', 'classify-document')
        self.assertEqual([event['id'] for event in result['events']], [5, 4])
        self.assertEqual(result['next_before_id'], 4)
        self.assertEqual(db.execute.call_args.args[1], ('admin', 'admin', '%admin%', '%admin%', 6, 6, 'classify-document', 'classify-document', 3))

    def test_audit_filters_are_bound_even_for_sql_like_values(self):
        db = MagicMock()
        db.execute.return_value.fetchall.return_value = []
        @contextmanager
        def connection():
            yield db
        attack = "' OR true --"
        with patch.object(access_views, '_connect', connection):
            access_views.audit({'is_admin': True}, 10, None, attack, attack)
        query, params = db.execute.call_args.args
        self.assertNotIn(attack, query)
        self.assertEqual(params, (attack, attack, '%' + attack + '%', '%' + attack + '%', None, None, attack, attack, 11))

    def test_classification_audit_contains_no_document_content(self):
        db = MagicMock()
        before = {'id': 'doc', 'filename': 'policy.md', 'audience': 'both', 'knowledge_base': 'company', 'content': b'private'}
        after = {**before, 'audience': 'company_b'}
        rag.audit_document(db, 'admin', 'classify-document', before, after)
        values = db.execute.call_args.args[1]
        self.assertEqual(values[:3], ('admin', 'classify-document', 'doc'))
        details = values[3].obj
        self.assertEqual(details['before']['audience'], 'both')
        self.assertEqual(details['after']['audience'], 'company_b')
        self.assertNotIn('content', details['before'])
        db.reset_mock()
        rag.audit_document(db, 'admin', 'classify-document', after, after)
        db.execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
