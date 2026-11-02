import unittest
from unittest import mock

from pydantic import ValidationError

from app import user_appearance
from app.user_appearance import Appearance

VALID = {'accent': '#0F62FE', 'assistantName': "Nova-1 O'Neil", 'companyName': 'Ακμή', 'theme': 'carbon'}


class FakeDb:
    def __init__(self, row=None):
        self.row, self.calls = row, []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self

    def fetchone(self):
        return self.row


class AppearanceValidation(unittest.TestCase):
    def test_accepts_and_normalises(self):
        self.assertEqual(Appearance(**VALID).accent, '#0f62fe')

    def test_rejects_unsafe_or_oversized_values(self):
        for field, value in [('accent', 'red'), ('accent', '#12345'), ('assistantName', '<b>'), ('assistantName', ''),
                             ('assistantName', ' Nova'), ('companyName', 'x' * 25), ('theme', 'purple')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                Appearance(**{**VALID, field: value})


class AppearanceStorage(unittest.TestCase):
    def test_read_returns_only_the_requested_account(self):
        db = FakeDb(({'accent': '#0f62fe'},))
        with mock.patch.object(user_appearance, '_connect', return_value=db):
            self.assertEqual(user_appearance.read_appearance('ana'), {'accent': '#0f62fe'})
        self.assertEqual(db.calls[-1][1], ('ana',))

    def test_read_is_none_before_anything_is_saved(self):
        with mock.patch.object(user_appearance, '_connect', return_value=FakeDb()):
            self.assertIsNone(user_appearance.read_appearance('ana'))

    def test_write_updates_the_same_row(self):
        db = FakeDb()
        with mock.patch.object(user_appearance, '_connect', return_value=db):
            saved = user_appearance.write_appearance('ana', Appearance(**VALID))
        self.assertEqual(saved['accent'], '#0f62fe')
        self.assertIn('ON CONFLICT (username) DO UPDATE', db.calls[-1][0])
        self.assertEqual(db.calls[-1][1][0], 'ana')


if __name__ == '__main__':
    unittest.main()
