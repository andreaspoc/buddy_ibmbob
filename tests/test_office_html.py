"""HTML source preservation, authorization and optimistic save boundaries."""
from contextlib import contextmanager
from unittest import TestCase
from unittest.mock import MagicMock, patch
from uuid import uuid4
from fastapi import HTTPException
from app import office
from app.office_html import validate_html

HTML = b'<!DOCTYPE html><html><body><section>Slide</section><script>window.slide=1;</script></body></html>'


@contextmanager
def connection(db):
    yield db


class HTMLTests(TestCase):
    def test_preserves_scripts_styles_and_exact_source(self):
        self.assertEqual(validate_html(HTML).encode(), HTML)
        office.validate_content(HTML, 'html')
        office.validate_content(HTML, 'htm')

    def test_rejects_binary_or_non_html(self):
        for raw in (b'PK\x03\x04<html>', b'%PDF-<html>', b'<html>\x00', b'<html>\xff', b'plain text'):
            with self.subTest(raw=raw), self.assertRaises(HTTPException):
                validate_html(raw)

    def test_content_requires_authenticated_file_access(self):
        with patch.object(office, 'require_storage'), patch.object(office, 'ensure_schema'), \
             patch.object(office.job_queue, '_connect', lambda: connection(MagicMock())), \
             patch.object(office, '_file', side_effect=HTTPException(404)) as lookup, patch.object(office, 'read') as read:
            with self.assertRaises(HTTPException):
                office.html_content(uuid4(), {'username': 'alice'})
            self.assertEqual(lookup.call_args.args[2], 'alice')
            read.assert_not_called()

    def test_content_preserves_source(self):
        row = {'extension': 'html', 'object_key': 'key', 'revision': 3}
        with patch.object(office, 'require_storage'), patch.object(office, 'ensure_schema'), \
             patch.object(office.job_queue, '_connect', lambda: connection(MagicMock())), \
             patch.object(office, '_file', return_value=row), patch.object(office, 'read', return_value=HTML):
            self.assertEqual(office.html_content(uuid4(), {'username': 'alice'}), {'html': HTML.decode(), 'revision': 3})

    def test_save_rejects_stale_revision_before_upload(self):
        row = {'extension': 'html', 'revision': 3}
        with patch.object(office, 'require_storage'), patch.object(office, 'ensure_schema'), \
             patch.object(office.job_queue, '_connect', lambda: connection(MagicMock())), \
             patch.object(office, '_file', return_value=row) as lookup, patch.object(office, 'put') as put:
            with self.assertRaises(HTTPException) as failure:
                office.save_html_content(uuid4(), office.HTMLContent(html=HTML.decode(), revision=2), {'username': 'alice'})
            self.assertEqual(failure.exception.status_code, 409)
            self.assertTrue(lookup.call_args.kwargs['require_write'])
            self.assertTrue(lookup.call_args.kwargs['lock'])
            put.assert_not_called()

    def test_save_preserves_source_and_updates_revision(self):
        row = {'id': uuid4(), 'username': 'owner', 'extension': 'htm', 'revision': 3}
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = {'revision': 4}
        with patch.object(office, 'require_storage'), patch.object(office, 'ensure_schema'), \
             patch.object(office.job_queue, '_connect', lambda: connection(db)), \
             patch.object(office, '_file', return_value=row), patch.object(office, 'put', return_value='digest') as put, \
             patch.object(office, 'summary', side_effect=lambda value, username: value):
            result = office.save_html_content(row['id'], office.HTMLContent(html=HTML.decode(), revision=3), {'username': 'alice'})
            self.assertEqual(result['revision'], 4)
            self.assertEqual(put.call_args.args[0], HTML)
            self.assertEqual(put.call_args.args[2], 'htm')
            self.assertIn('revision=revision+1', db.execute.call_args.args[0])


if __name__ == '__main__':
    from unittest import main
    main()
