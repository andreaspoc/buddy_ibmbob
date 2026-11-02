"""Verified Keycloak group snapshots and realm-scoped folder authorization."""
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from app import keycloak_groups as groups
from buddy_learning import store

ISSUER = 'https://identity.fixture/realms/buddy'
OTHER_ISSUER = 'https://identity.fixture/realms/other'


class Cursor:
    def __init__(self, value=None):
        self.value = value

    def fetchone(self):
        return self.value


class SnapshotDB:
    def __init__(self):
        self.memberships = {(OTHER_ISSUER, 'subject', '/Preserved')}
        self.sync_state = {}
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if sql.startswith('DELETE FROM bob_keycloak_group_memberships'):
            issuer, subject = params
            self.memberships = {row for row in self.memberships if row[:2] != (issuer, subject)}
        elif sql.startswith('INSERT INTO bob_keycloak_group_memberships'):
            self.memberships.add(tuple(params))
        elif sql.startswith('INSERT INTO bob_keycloak_group_sync'):
            self.sync_state[params[:2]] = params[2]
        else:
            raise AssertionError('Unexpected query: ' + sql)
        return Cursor(None)


class GroupSnapshotTests(unittest.TestCase):
    def test_full_group_paths_are_preserved_and_deduplicated(self):
        self.assertEqual(groups.verified_groups({'groups': ['/Training/Team', '/Training', '/Training/Team']}),
                         (['/Training', '/Training/Team'], True))
        self.assertEqual(groups.verified_groups({'groups': []}), ([], True))

    def test_missing_or_malformed_claim_never_grants_partial_membership(self):
        for claims in ({}, {'groups': None}, {'groups': '/Training/Team'}, {'groups': {}},
                       {'groups': ['/Training/Team', 'short-name']}, {'groups': [True]},
                       {'groups': ['/']}, {'groups': ['/Team/']}, {'groups': ['/Team//Child']},
                       {'groups': ['/Team/../Child']}, {'groups': ['/Team/./Child']},
                       {'groups': ['/Team\\Child']}, {'groups': ['/Team\nChild']},
                       {'groups': ['/' + 'a' * 512]}, {'groups': ['/Team'] * 1001}):
            with self.subTest(claims=claims):
                self.assertEqual(groups.verified_groups(claims), ([], False))

    def test_verified_login_replaces_old_groups_for_exact_issuer_and_subject(self):
        db = SnapshotDB()
        db.memberships.update({(ISSUER, 'subject', '/Former'), (ISSUER, 'another', '/Keep')})
        groups.sync(db, ISSUER, 'subject', {'groups': ['/Training/Team', '/Training/Team']})
        self.assertEqual(db.memberships, {(OTHER_ISSUER, 'subject', '/Preserved'),
                                         (ISSUER, 'another', '/Keep'), (ISSUER, 'subject', '/Training/Team')})
        self.assertTrue(db.sync_state[(ISSUER, 'subject')])
        inserts = [params for sql, params in db.calls if sql.startswith('INSERT INTO bob_keycloak_group_memberships')]
        self.assertEqual(inserts, [(ISSUER, 'subject', '/Training/Team')])

    def test_unavailable_or_malformed_groups_revoke_previous_snapshot(self):
        for claims in ({}, {'groups': ['/Training/Team', 'invalid']}):
            with self.subTest(claims=claims):
                db = SnapshotDB()
                db.memberships.add((ISSUER, 'subject', '/Training/Team'))
                groups.sync(db, ISSUER, 'subject', claims)
                self.assertEqual(db.memberships, {(OTHER_ISSUER, 'subject', '/Preserved')})
                self.assertFalse(db.sync_state[(ISSUER, 'subject')])
        db = SnapshotDB()
        groups.sync(db, ISSUER, 'subject', {'groups': []})
        self.assertTrue(db.sync_state[(ISSUER, 'subject')])

    def test_realm_normalization_does_not_select_other_issuer(self):
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': ' ' + ISSUER + '/ '}):
            self.assertEqual(groups.realm(), ISSUER)
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': ''}):
            self.assertEqual(groups.realm(), '')


class ACLDatabase:
    """SQL-boundary double: asserts security predicates, evaluates fixture ACLs."""
    def __init__(self, folder):
        self.folder = str(folder)
        self.identities = {(ISSUER, 'learner'): 'subject'}
        self.memberships = {(ISSUER, 'subject', '/Training/Team')}
        self.grants = {(self.folder, ISSUER, '/Training/Team')}
        self.direct = set()
        self.checked = False

    def execute(self, sql, params=None):
        if sql.startswith('WITH RECURSIVE app_ancestor_ids'):
            return Cursor({'allowed':1} if (params[0],params[1]) in self.direct else None)
        if sql.startswith('SELECT * FROM learning.folders'):
            return Cursor({'id': self.folder, 'name': 'Synthetic restricted folder'})
        if sql.startswith(('SELECT 1 FROM bob_keycloak_identities', 'WITH RECURSIVE ancestor_ids')):
            normalized = ' '.join(sql.split())
            for required in ('i.issuer=%s', 'i.username=%s', 'km.issuer=g.issuer',
                             'km.group_path=g.group_path', 'km.subject=i.subject', 'g.issuer=i.issuer'):
                if required not in normalized:
                    raise AssertionError('Missing ACL predicate: ' + required)
            if ' LIKE ' in normalized or ' ILIKE ' in normalized:
                raise AssertionError('Folder groups must not use prefix or substring matching')
            direct_folder, issuer, username = params
            group_folder = direct_folder
            self.checked = True
            subject = self.identities.get((issuer, username))
            allowed = subject is not None and ((direct_folder, username) in self.direct or any(
                (group_folder, issuer, path) in self.grants
                for member_issuer, member_subject, path in self.memberships
                if (member_issuer, member_subject) == (issuer, subject)))
            return Cursor({'allowed': 1} if allowed else None)
        raise AssertionError('Unexpected query: ' + sql)


class FolderGroupAccessTests(unittest.TestCase):
    def setUp(self):
        self.folder = uuid4()
        self.db = ACLDatabase(self.folder)
        self.user = {'username': 'learner', 'is_admin': False}
        self.realm = patch.dict(os.environ, {'KEYCLOAK_ISSUER': ISSUER})
        self.realm.start()

    def tearDown(self):
        self.realm.stop()

    def denied(self):
        with self.assertRaises(HTTPException) as failure:
            store.folder(self.db, self.folder, self.user)
        self.assertEqual(failure.exception.status_code, 404)

    def test_exact_full_group_path_grants_access(self):
        self.assertEqual(store.folder(self.db, self.folder, self.user)['id'], str(self.folder))
        self.assertTrue(self.db.checked)

    def test_parent_child_and_similar_group_names_do_not_match(self):
        for path in ('/Training', '/Training/Team/Child', '/Training/TeamOther', '/training/team'):
            with self.subTest(path=path):
                self.db.grants = {(str(self.folder), ISSUER, path)}
                self.denied()

    def test_issuer_scoping_prevents_cross_realm_membership_and_grants(self):
        self.db.grants = {(str(self.folder), OTHER_ISSUER, '/Training/Team')}
        self.denied()
        self.db.grants = {(str(self.folder), ISSUER, '/Training/Team')}
        self.db.memberships = {(OTHER_ISSUER, 'subject', '/Training/Team')}
        self.denied()
        self.db.memberships = {(ISSUER, 'subject', '/Training/Team')}
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': OTHER_ISSUER}):
            self.denied()

    def test_absent_snapshot_or_identity_does_not_grant_group_access(self):
        self.db.memberships.clear()
        self.denied()
        self.db.memberships = {(ISSUER, 'subject', '/Training/Team')}
        self.db.identities.clear()
        self.denied()
        self.db.direct.add((str(self.folder), 'learner'))
        self.assertEqual(store.folder(self.db,self.folder,self.user)['id'],str(self.folder))  # Explicit local account grants require no Keycloak identity.

    def test_individual_verified_user_grant_does_not_require_group(self):
        self.db.memberships.clear()
        self.db.direct.add((str(self.folder), 'learner'))
        self.assertEqual(store.folder(self.db, self.folder, self.user)['id'], str(self.folder))


class TeacherRoleTests(unittest.TestCase):
    def test_exact_teacher_group_and_realm_are_required(self):
        class RoleDB:
            def __init__(self, group):
                self.group = group
                self.calls = []
            def execute(self, sql, params=None):
                self.calls.append((sql, params))
                normalized = ' '.join(sql.split())
                if normalized.startswith('SELECT 1 FROM bob_app_roles'):
                    return Cursor()
                for required in ('m.issuer=i.issuer', 'm.subject=i.subject', 'i.issuer=%s', 'i.username=%s', 'm.group_path=%s'):
                    if required not in normalized:
                        raise AssertionError('Missing teacher role predicate: ' + required)
                return Cursor({'allowed': 1} if params == (ISSUER, 'teacher-user', self.group) else None)
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': ISSUER, 'BUDDY_LEARNING_TEACHER_GROUP': '/teacher'}):
            self.assertTrue(store.can_create(RoleDB('/teacher'), {'username':'teacher-user'}))
            for group in ('/Teacher', '/teacher/child', '/department/teacher', 'teacher'):
                self.assertFalse(store.can_create(RoleDB(group), {'username':'teacher-user'}))
            self.assertFalse(store.can_create(RoleDB('/teacher'), {'username':'unrelated-user'}))
            with patch.dict(os.environ, {'KEYCLOAK_ISSUER': OTHER_ISSUER}):
                self.assertFalse(store.can_create(RoleDB('/teacher'), {'username':'teacher-user'}))

    def test_configured_teacher_group_is_exact(self):
        class RoleDB:
            def execute(self, sql, params=None):
                if sql.startswith('SELECT 1 FROM bob_app_roles'):
                    return Cursor()
                if params != (ISSUER, 'teacher-user', '/Educators/Teachers'):
                    raise AssertionError('Configured full teacher group was not used')
                return Cursor({'allowed':1})
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': ISSUER, 'BUDDY_LEARNING_TEACHER_GROUP': '/Educators/Teachers'}):
            self.assertTrue(store.can_create(RoleDB(), {'username':'teacher-user'}))

    def test_platform_admin_does_not_depend_on_group_lookup(self):
        class NoDB:
            def execute(self, *args, **kwargs):
                raise AssertionError('Admin role should not query a teacher group')
        self.assertTrue(store.can_create(NoDB(), {'username':'admin-user', 'is_admin': True}))



if __name__ == '__main__':
    unittest.main()
