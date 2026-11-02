import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from app import rag


class FreshnessTests(unittest.TestCase):
    def row(self, **changes):
        return {'id':'document','filename':'policy.pdf','description':'','status':'ready','error':None,'chunk_count':2,
                'created_at':datetime.now(timezone.utc),'username':'admin',**changes}

    def test_existing_documents_have_safe_defaults(self):
        item=rag.public_document(self.row())
        self.assertEqual(item['owner'],'')
        self.assertIsNone(item['review_due'])
        self.assertFalse(item['review_overdue'])

    def test_review_due_today_is_not_overdue(self):
        today=datetime.now(timezone.utc).date()
        self.assertFalse(rag.public_document(self.row(review_due=today))['review_overdue'])
        self.assertTrue(rag.public_document(self.row(review_due=today-timedelta(days=1)))['review_overdue'])

    def test_invalid_date_does_not_write(self):
        with patch.object(rag,'require_admin'),patch.object(rag.job_queue,'_connect') as connect:
            with self.assertRaises(ValueError):rag.update_freshness('admin','shared','document','Owner','2026-02-30',admin=True)
            connect.assert_not_called()

    def test_update_preserves_access_and_audits(self):
        connection=MagicMock();connection.__enter__.return_value=connection
        row=self.row(owner='Policy team',review_due=date(2027,1,1),audience='buddy')
        connection.execute.return_value.fetchone.return_value=row
        with patch.object(rag,'require_admin') as authorize,patch.object(rag,'ensure_schema'),patch.object(rag,'_manage_document',return_value=self.row()),patch.object(rag,'audit_document') as audit,patch.object(rag.job_queue,'_connect',return_value=connection):
            item=rag.update_freshness('admin','shared','document',' Policy team ','2027-01-01',reviewed=True,admin=True)
        authorize.assert_called_once_with('admin',True)
        self.assertEqual(item['audience'],'buddy')
        self.assertEqual(connection.execute.call_args.args[1],('Policy team',date(2027,1,1),True,'document'))
        audit.assert_called_once()


if __name__=='__main__':unittest.main()
