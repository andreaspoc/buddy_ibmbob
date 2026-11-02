"""Inherited folder ACL contract; inaccessible ancestor names stay private.

The query-boundary double asserts the recursive/equality predicates and evaluates
synthetic ACLs. Deployment integration tests exercise these queries on Postgres.
"""
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from buddy_learning import store

REALM = 'https://identity.fixture/realms/buddy'


class Cursor:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows if rows is not None else ([] if row is None else [row])

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class TreeDB:
    def __init__(self):
        self.root, self.child, self.grandchild, self.sibling = (str(uuid4()) for _ in range(4))
        self.rows = {
            self.root: {'id': self.root, 'name': 'Private root title', 'parent_id': None},
            self.child: {'id': self.child, 'name': 'Assigned child', 'parent_id': self.root},
            self.grandchild: {'id': self.grandchild, 'name': 'Grandchild', 'parent_id': self.child},
            self.sibling: {'id': self.sibling, 'name': 'Unassigned sibling', 'parent_id': self.root},
        }
        self.direct = set()
        self.identities = {(REALM, 'learner'): 'subject'}
        self.memberships = {(REALM, 'subject', '/Training')}
        self.groups = set()
        self.calls = []

    def ancestor_ids(self, identity):
        values = set()
        while identity in self.rows and identity not in values:
            values.add(identity)
            identity = self.rows[identity]['parent_id']
        return values

    def has_direct_grant(self, folder, issuer, username):
        subject = self.identities.get((issuer, username))
        return subject is not None and ((folder, username) in self.direct or any(
            (folder, issuer, path) in self.groups for realm, member, path in self.memberships
            if realm == issuer and member == subject))

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        normalized = ' '.join(sql.split())
        if normalized.startswith('SELECT * FROM learning.folders'):
            return Cursor(self.rows.get(params[0]))
        if normalized.startswith('WITH RECURSIVE app_ancestor_ids'):
            return Cursor(None)
        if normalized.startswith('WITH RECURSIVE app_authorized_folders'):
            return Cursor(rows=[])
        if normalized.startswith('WITH RECURSIVE ancestor_ids'):
            if ' UNION ' not in normalized or 'UNION ALL' in normalized:
                raise AssertionError('Ancestor recursion must be cycle bounded')
            for clause in ('f.id=a.parent_id', 'i.issuer=%s', 'i.username=%s', 'a.id=m.folder_id',
                           'a.id=g.folder_id', 'km.issuer=g.issuer', 'km.group_path=g.group_path', 'km.subject=i.subject', 'g.issuer=i.issuer'):
                if clause not in normalized:
                    raise AssertionError('Missing inherited authorization constraint: ' + clause)
            identity, issuer, username = params
            allowed = any(self.has_direct_grant(folder, issuer, username) for folder in self.ancestor_ids(identity))
            return Cursor({'allowed': 1} if allowed else None)
        if normalized.startswith('WITH RECURSIVE authorized_folders'):
            if ' UNION ' not in normalized or 'UNION ALL' in normalized or 'child.parent_id=a.id' not in normalized:
                raise AssertionError('Visibility must recurse down from grants with cycle protection')
            issuer, username = params
            allowed = {identity for identity in self.rows if self.has_direct_grant(identity, issuer, username)}
            while True:
                descendants = {identity for identity, row in self.rows.items() if row['parent_id'] in allowed}
                added = descendants - allowed
                if not added:
                    break
                allowed.update(added)
            return Cursor(rows=[self.rows[identity] for identity in sorted(allowed)])
        if normalized.startswith('WITH RECURSIVE ancestor_rows'):
            if ' UNION ' not in normalized or 'UNION ALL' in normalized:
                raise AssertionError('Administrative ancestor traversal must be cycle bounded')
            return Cursor(rows=[self.rows[identity] for identity in sorted(self.ancestor_ids(params[0])) if identity != params[1]])
        if normalized.startswith('SELECT id,name,parent_id FROM learning.folders'):
            return Cursor(rows=list(self.rows.values()))
        raise AssertionError('Unexpected query: ' + normalized)


class FolderHierarchyTests(unittest.TestCase):
    def setUp(self):
        self.db = TreeDB()
        self.user = {'username': 'learner', 'is_admin': False}
        self.realm = patch.dict(os.environ, {'KEYCLOAK_ISSUER': REALM})
        self.realm.start()

    def tearDown(self):
        self.realm.stop()

    def denied(self, identity):
        with self.assertRaises(HTTPException) as error:
            store.folder(self.db, identity, self.user)
        self.assertEqual((error.exception.status_code, error.exception.detail), (404, 'Folder not found'))

    def visible_ids(self):
        return {row['id'] for row in store.visible_folders(self.db, self.user)}

    def test_parent_individual_grant_reaches_children_and_grandchildren(self):
        self.db.direct.add((self.db.root, 'learner'))
        for identity in self.db.rows:
            self.assertEqual(store.folder(self.db, identity, self.user)['id'], identity)
        self.assertEqual(self.visible_ids(), set(self.db.rows))

    def test_exact_parent_group_grant_inherits_without_group_path_prefix_matching(self):
        self.db.groups.add((self.db.child, REALM, '/Training'))
        self.assertEqual(self.visible_ids(), {self.db.child, self.db.grandchild})
        self.assertEqual(store.folder(self.db, self.db.grandchild, self.user)['id'], self.db.grandchild)
        self.denied(self.db.sibling)
        self.db.groups = {(self.db.child, REALM, '/Training/Subgroup')}
        self.assertEqual(self.visible_ids(), set())
        self.denied(self.db.grandchild)

    def test_child_only_grant_does_not_reveal_parent_or_sibling_names(self):
        self.db.direct.add((self.db.child, 'learner'))
        visible = store.visible_folders(self.db, self.user)
        self.assertEqual({row['id'] for row in visible}, {self.db.child, self.db.grandchild})
        self.assertNotIn('Private root title', json.dumps(visible))
        self.assertNotIn('Unassigned sibling', json.dumps(visible))
        self.denied(self.db.root)
        self.denied(self.db.sibling)

    def test_removing_ancestor_grant_blocks_next_descendant_lookup(self):
        self.db.direct.add((self.db.child, 'learner'))
        store.folder(self.db, self.db.grandchild, self.user)
        self.db.direct.clear()
        self.denied(self.db.grandchild)
        self.assertEqual(self.visible_ids(), set())

    def test_parent_grants_still_require_current_realm_identity(self):
        self.db.direct.add((self.db.root, 'learner'))
        self.db.identities.clear()
        self.denied(self.db.child)
        self.assertEqual(self.visible_ids(), set())
        self.db.identities[(REALM, 'learner')] = 'subject'
        with patch.dict(os.environ, {'KEYCLOAK_ISSUER': REALM + '-other'}):
            self.denied(self.db.child)
            self.assertEqual(self.visible_ids(), set())

    def test_admin_reads_all_folders_without_individual_grants(self):
        self.user['is_admin'] = True
        self.db.identities.clear()
        self.assertEqual(self.visible_ids(), set(self.db.rows))
        self.assertEqual(store.folder(self.db, self.db.child, self.user)['id'], self.db.child)

    def test_nonexistent_and_unauthorized_folders_have_same_error(self):
        self.denied(self.db.root)
        self.denied(str(uuid4()))

    def test_administrative_ancestors_exclude_requested_folder_and_bound_cycles(self):
        result = store.ancestors(self.db, self.db.grandchild)
        self.assertEqual({row['id'] for row in result}, {self.db.root, self.db.child})
        self.db.rows[self.db.root]['parent_id'] = self.db.grandchild
        result = store.ancestors(self.db, self.db.grandchild)
        self.assertEqual({row['id'] for row in result}, {self.db.root, self.db.child})
        self.db.direct.add((self.db.child, 'learner'))
        self.assertEqual(self.visible_ids(), set(self.db.rows))
        store.folder(self.db, self.db.root, self.user)


if __name__ == '__main__':
    unittest.main()
