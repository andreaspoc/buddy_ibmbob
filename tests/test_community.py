"""Conversation privacy, sharing ownership and durable unread-state regression tests."""
from contextlib import contextmanager
from io import BytesIO
from unittest import TestCase
from unittest.mock import MagicMock, patch

from fastapi import HTTPException, Response, UploadFile
from starlette.routing import WebSocketRoute
from pydantic import ValidationError
from app import community


@contextmanager
def connection(db):
    yield db


class CommunityTests(TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.schema = patch.object(community, 'ensure_schema').start()
        patch.object(community, 'changed').start()
        # Away queue behavior has dedicated PostgreSQL coverage.
        patch('app.community_away.enqueue').start()
        patch('app.community_collaboration.notifications_paused',return_value=False).start()
        patch.object(community.job_queue, '_connect', lambda: connection(self.db)).start()
        self.addCleanup(patch.stopall)
        self.user = {'username': 'alice'}

    def test_every_route_requires_authenticated_user(self):
        for route in community.router.routes:
            if isinstance(route, WebSocketRoute):
                continue
            self.assertTrue(any(item.call is community.current_user for item in route.dependant.dependencies), route.path)

    def test_websocket_rejects_cross_origin_and_anonymous_connections(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        from unittest.mock import AsyncMock
        app = FastAPI()
        app.include_router(community.router)
        with TestClient(app) as client:
            with patch.object(community, 'current_user', new=AsyncMock(side_effect=HTTPException(401))):
                for headers in ({'origin': 'https://evil.example'}, {'origin': 'http://testserver'}):
                    with self.assertRaises(WebSocketDisconnect) as error:
                        with client.websocket_connect('/api/community/ws', headers=headers):
                            pass
                    self.assertEqual(error.exception.code, 1008)

    def test_http_write_rejects_cross_origin_before_mutation(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(community.router)
        app.dependency_overrides[community.current_user] = lambda: self.user
        with TestClient(app) as client:
            result = client.post('/api/community/rooms', json={'kind': 'channel', 'name': 'Forbidden'},
                                 headers={'origin': 'https://evil.example'})
        self.assertEqual(result.status_code, 403)
        self.db.execute.assert_not_called()

    def test_nonmember_cannot_read_write_download_or_unsubscribe(self):
        self.db.execute.return_value.fetchone.return_value = None
        operations = [
            lambda: community.messages(7, Response(), after=0, user=self.user),
            lambda: community.receipts(7, Response(), user=self.user),
            lambda: community.mark_read(7, community.ReadAcknowledgement(message_id=1), user=self.user),
            lambda: community.send(7, body='hello', note_id=None, file=None, user=self.user),
            lambda: community.attachment(7, 19, self.user),
            lambda: community.unsubscribe(7, self.user),
        ]
        for operation in operations:
            self.db.reset_mock()
            with self.assertRaises(HTTPException) as error:
                operation()
            self.assertEqual(error.exception.status_code, 404)
            self.assertEqual(self.db.execute.call_count, 1)
            self.assertIn('people_chat.bob_chat_members WHERE room_id=%s AND username=%s', self.db.execute.call_args.args[0])
            self.assertEqual(self.db.execute.call_args.args[1], (7, 'alice'))

    def test_note_lookup_requires_authenticated_ownership(self):
        self.db.execute.return_value.fetchone.side_effect = [{'username': 'alice'}, None]
        with patch.object(community.notes, 'ensure_schema'):
            with self.assertRaises(HTTPException) as error:
                community.send(7, body='', note_id=55, file=None, user=self.user)
        self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(self.db.execute.call_count, 2)
        self.assertIn('WHERE id=%s AND username=%s', self.db.execute.call_args.args[0])
        self.assertEqual(self.db.execute.call_args.args[1], (55, 'alice'))

    def test_note_is_shared_as_snapshot(self):
        self.db.execute.return_value.fetchone.side_effect = [{'username': 'alice'}, {'title': 'Plan', 'body': 'Original'}, {'id': 8}]
        with patch.object(community.notes, 'ensure_schema'), patch.object(community, 'message_snapshot', return_value=[{'id': 8}]):
            result = community.send(7, body=' Read this ', note_id=55, file=None, user=self.user)
        self.assertEqual(result, {'id': 8})
        self.assertEqual(self.db.execute.call_args.args[1][:5], (7, 'alice', 'Read this\n\nShared note: Plan\n\nOriginal', None, None))

    def test_direct_pair_has_symmetric_key_and_conflict_safe_insert(self):
        self.db.execute.return_value.fetchone.side_effect = [{'username': 'alice'}, {'id': 8}, {'username': 'bob'}, {'id': 8}]
        first = community.create_room(community.RoomCreate(kind='direct', peer='bob'), self.user)
        first_call = self.db.execute.call_args_list[1]
        second = community.create_room(community.RoomCreate(kind='direct', peer='alice'), {'username': 'bob'})
        second_call = self.db.execute.call_args_list[5]
        self.assertEqual(first, second)
        self.assertEqual(first_call.args[1][2], second_call.args[1][2])
        self.assertIn('ON CONFLICT(direct_key) DO UPDATE', first_call.args[0])
        self.assertIn('ON CONFLICT DO NOTHING', self.db.execute.call_args.args[0])

    def test_direct_rejects_self_and_unknown_member(self):
        self.db.execute.return_value.fetchone.return_value = None
        for peer in ('alice', 'missing'):
            with self.assertRaises(HTTPException) as error:
                community.create_room(community.RoomCreate(kind='direct', peer=peer), self.user)
            self.assertEqual(error.exception.status_code, 422)
        self.assertFalse(any('INSERT' in call.args[0] for call in self.db.execute.call_args_list))

    def test_subscription_only_allows_channels(self):
        self.db.execute.return_value.fetchone.return_value = None
        with self.assertRaises(HTTPException) as error:
            community.subscribe(7, self.user)
        self.assertEqual(error.exception.status_code, 404)
        self.assertIn("kind='channel'", self.db.execute.call_args.args[0])
        self.assertEqual(self.db.execute.call_count, 1)

    def test_fetching_messages_does_not_mark_them_read(self):
        self.db.execute.return_value.fetchone.return_value = {'username': 'alice'}
        self.db.execute.return_value.fetchall.side_effect = [[
            {'id': 5, 'sender': 'bob', 'body': 'First', 'filename': None, 'created_at': None},
            {'id': 9, 'sender': 'bob', 'body': 'Slides', 'filename': 'deck.pdf', 'created_at': None},
        ], [], []]
        response = Response()
        rows = community.messages(7, response, after=3, user=self.user)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        membership, fetch = self.db.execute.call_args_list[:2]
        self.assertNotIn('FOR UPDATE', membership.args[0])
        self.assertIn('ORDER BY msg.id LIMIT 200', fetch.args[0])
        self.assertEqual(fetch.args[1], (7, 3, None, None))
        self.assertIsNone(rows[0]['attachment'])
        self.assertEqual(rows[1]['attachment'], {'id': 9, 'filename': 'deck.pdf', 'size': None})

    def test_empty_poll_does_not_advance_cursor(self):
        self.db.execute.return_value.fetchone.return_value = {'username': 'alice'}
        self.db.execute.return_value.fetchall.return_value = []
        self.assertEqual(community.messages(7, Response(), after=99, user=self.user), [])
        self.assertEqual(self.db.execute.call_count, 2)

    def test_room_list_hides_other_direct_rooms_and_excludes_own_messages_from_unread(self):
        community.rooms(Response(), self.user)
        sql, params = self.db.execute.call_args.args
        self.assertIn("WHERE (r.kind='channel' AND r.visibility='open') OR own.username IS NOT NULL", sql)
        self.assertIn('msg.sender<>%s AND NOT EXISTS', sql)
        self.assertIn('own.username IS NOT NULL AND msg.sender<>%s', sql)
        self.assertEqual(params, ('alice',) * 6)

    def test_attachment_scopes_id_to_room_and_forces_download(self):
        self.db.execute.return_value.fetchone.side_effect = [{'username': 'alice'}, {'filename': 'deck "x".pdf', 'content': b'pdf'}]
        response = community.attachment(7, 19, self.user)
        self.assertEqual(self.db.execute.call_args.args[1], (7, 19))
        self.assertIn('WHERE room_id=%s AND id=%s', self.db.execute.call_args.args[0])
        self.assertEqual(response.body, b'pdf')
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertIn('%22x%22', response.headers['Content-Disposition'])

    def test_file_limit_and_filename_normalization(self):
        self.db.execute.return_value.fetchone.return_value = {'id': 8}
        with patch.object(community, 'MAX_FILE', 4), patch.object(community, 'message_snapshot', return_value=[{'id': 8}]):
            with self.assertRaises(HTTPException) as error:
                community.send(7, body='', note_id=None, file=UploadFile(BytesIO(b'12345'), filename='large.pdf'), user=self.user)
            self.assertEqual(error.exception.status_code, 413)
            self.assertEqual(self.db.execute.call_count, 1)
            community.send(7, body='', note_id=None, file=UploadFile(BytesIO(b'1234'), filename='../private\\deck.pdf'), user=self.user)
        self.assertEqual(self.db.execute.call_args.args[1][:5], (7, 'alice', '', 'deck.pdf', b'1234'))

    def test_empty_message_and_invalid_room_input_are_rejected(self):
        self.db.execute.return_value.fetchone.return_value = {'username': 'alice'}
        with self.assertRaises(HTTPException) as error:
            community.send(7, body='  ', note_id=None, file=None, user=self.user)
        self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(self.db.execute.call_count, 1)
        for payload in ({'kind': 'channel', 'name': ' '}, {'kind': 'direct'}, {'kind': 'public', 'name': 'room'}):
            with self.assertRaises(ValidationError):
                community.RoomCreate(**payload)


class CommunityPostgresTests(TestCase):
    """Exercise the real membership and unread queries in an isolated user namespace."""
    def setUp(self):
        import os
        import uuid
        if not os.environ.get('DATABASE_URL'):
            self.skipTest('DATABASE_URL required for PostgreSQL integration')
        community.ensure_schema()
        prefix = 'communitytest_' + uuid.uuid4().hex
        self.names = [prefix + suffix for suffix in ('a', 'b', 'c')]
        self.alice, self.bob, self.eve = [{'username': name} for name in self.names]
        with community.job_queue._connect() as db:
            for name in self.names:
                db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES (%s,%s,false)', (name, 'disabled-test-account'))
        self.addCleanup(self.cleanup_records)

    def cleanup_records(self):
        with community.job_queue._connect() as db:
            db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE creator=ANY(%s)', (self.names,))
            db.execute('DELETE FROM bob_user_profiles WHERE username=ANY(%s)', (self.names,))
            db.execute('DELETE FROM users WHERE username=ANY(%s)', (self.names,))

    def test_private_rooms_membership_downloads_and_unread(self):
        room = community.create_room(community.RoomCreate(kind='direct', peer=self.names[1]), self.alice)['id']
        duplicate = community.create_room(community.RoomCreate(kind='direct', peer=self.names[0]), self.bob)['id']
        self.assertEqual(room, duplicate)
        sent = community.send(room, body='Private slides', note_id=None,
                              file=UploadFile(BytesIO(b'presentation'), filename='slides.pdf'), user=self.alice)['id']
        self.assertNotIn(room, [row['id'] for row in community.rooms(Response(), self.eve)])
        for operation in (
            lambda: community.messages(room, Response(), after=0, user=self.eve),
            lambda: community.send(room, body='Intrusion', note_id=None, file=None, user=self.eve),
            lambda: community.attachment(room, sent, self.eve),
            lambda: community.subscribe(room, self.eve),
        ):
            with self.assertRaises(HTTPException) as error:
                operation()
            self.assertEqual(error.exception.status_code, 404)
        own = next(row for row in community.rooms(Response(), self.alice) if row['id'] == room)
        peer = next(row for row in community.rooms(Response(), self.bob) if row['id'] == room)
        self.assertEqual(own['unread_count'], 0)
        self.assertEqual(peer['unread_count'], 1)
        received = community.messages(room, Response(), after=0, user=self.bob)
        self.assertEqual([row['id'] for row in received], [sent])
        self.assertEqual(community.attachment(room, sent, self.bob).body, b'presentation')
        peer = next(row for row in community.rooms(Response(), self.bob) if row['id'] == room)
        self.assertEqual(peer['unread_count'], 1)
        community.mark_read(room, community.ReadAcknowledgement(message_id=sent), self.bob)
        peer = next(row for row in community.rooms(Response(), self.bob) if row['id'] == room)
        self.assertEqual(peer['unread_count'], 0)
        community.messages(room, Response(), after=0, user=self.bob)
        with community.job_queue._connect() as db:
            row = db.execute('SELECT last_read FROM people_chat.bob_chat_members WHERE room_id=%s AND username=%s', (room, self.names[1])).fetchone()
        self.assertEqual(row['last_read'], sent)

    def test_notification_metadata_tracks_incoming_ids_without_exposing_content(self):
        room = community.create_room(community.RoomCreate(kind='direct', peer=self.names[1]), self.alice)['id']

        def listed(user=self.bob):
            return next(row for row in community.rooms(Response(), user) if row['id'] == room)

        self.assertIsNone(listed()['latest_incoming_id'])
        self.assertIsNone(listed()['latest_incoming_sender_name'])
        community.send(room, body='Own message', note_id=None, file=None, user=self.bob)
        self.assertIsNone(listed()['latest_incoming_id'])
        with community.job_queue._connect() as db:
            db.execute('INSERT INTO bob_user_profiles(username,display_name) VALUES (%s,%s)',
                       (self.names[0], 'Alice Example'))
        first = community.send(room, body='Private content', note_id=None,
                               file=UploadFile(BytesIO(b'secret'), filename='private.pdf'), user=self.alice)['id']
        before = listed()
        self.assertEqual(before['latest_incoming_id'], first)
        self.assertEqual(before['latest_incoming_sender_name'], 'Alice Example')
        for key in ('body', 'content', 'filename', 'attachment'):
            self.assertNotIn(key, before)
        community.delete_message(room, first, self.alice)
        second = community.send(room, body='Another message', note_id=None, file=None, user=self.alice)['id']
        after = listed()
        self.assertEqual(after['unread_count'], before['unread_count'])
        self.assertGreater(after['latest_incoming_id'], before['latest_incoming_id'])
        community.mark_read(room, community.ReadAcknowledgement(message_id=second), self.bob)
        self.assertEqual(listed()['latest_incoming_id'], second)
        with community.job_queue._connect() as db:
            db.execute('UPDATE bob_user_profiles SET display_name=%s WHERE username=%s',
                       ('kc-private-identity', self.names[0]))
        self.assertEqual(listed()['latest_incoming_sender_name'], self.names[0])
        self.assertNotIn(room, [row['id'] for row in community.rooms(Response(), self.eve)])

    def test_open_channel_notification_metadata_requires_subscription(self):
        room = community.create_room(community.RoomCreate(kind='channel', name='Public'), self.alice)['id']
        sent = community.send(room, body='Subscriber content', note_id=None, file=None, user=self.alice)['id']
        outsider = next(row for row in community.rooms(Response(), self.eve) if row['id'] == room)
        self.assertFalse(outsider['subscribed'])
        self.assertIsNone(outsider['latest_incoming_id'])
        self.assertIsNone(outsider['latest_incoming_sender_name'])
        community.subscribe(room, self.eve)
        subscriber = next(row for row in community.rooms(Response(), self.eve) if row['id'] == room)
        self.assertEqual(subscriber['latest_incoming_id'], sent)
        self.assertEqual(subscriber['latest_incoming_sender_name'], self.names[0])

    def test_read_receipts_are_explicit_monotonic_and_member_scoped(self):
        room = community.create_room(community.RoomCreate(kind='direct', peer=self.names[1]), self.alice)['id']
        first = community.send(room, body='First', note_id=None, file=None, user=self.alice)['id']
        second = community.send(room, body='Second', note_id=None, file=None, user=self.alice)['id']
        other = community.create_room(community.RoomCreate(kind='channel', name='Other'), self.alice)['id']
        foreign = community.send(other, body='Other room', note_id=None, file=None, user=self.alice)['id']
        response = Response()
        before = {row['username']: row for row in community.receipts(room, response, self.alice)}
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(before[self.names[1]]['last_read'], 0)
        community.messages(room, Response(), after=0, user=self.bob)
        self.assertEqual(next(row['unread_count'] for row in community.rooms(Response(), self.bob) if row['id'] == room), 2)
        with patch.object(community, 'changed') as notify:
            self.assertEqual(community.mark_read(room, community.ReadAcknowledgement(message_id=second), self.bob), {'last_read': second, 'last_seen': second})
            self.assertEqual(notify.call_count, 1)
            for message_id in (second, first):
                self.assertEqual(community.mark_read(room, community.ReadAcknowledgement(message_id=message_id), self.bob), {'last_read': second, 'last_seen': second})
            self.assertEqual(notify.call_count, 1)
        after = {row['username']: row for row in community.receipts(room, Response(), self.alice)}
        self.assertEqual(after[self.names[1]]['last_read'], second)
        self.assertEqual(after[self.names[0]]['last_read'], 0)
        self.assertEqual(next(row['unread_count'] for row in community.rooms(Response(), self.bob) if row['id'] == room), 0)
        for operation in (
            lambda: community.receipts(room, Response(), self.eve),
            lambda: community.mark_read(room, community.ReadAcknowledgement(message_id=second), self.eve),
            lambda: community.mark_read(room, community.ReadAcknowledgement(message_id=foreign), self.bob),
        ):
            with self.assertRaises(HTTPException) as error:
                operation()
            self.assertEqual(error.exception.status_code, 404)
        for message_id in (0, -1):
            with self.assertRaises(ValidationError):
                community.ReadAcknowledgement(message_id=message_id)

    def test_legacy_fetch_cursor_does_not_imply_explicit_seen(self):
        room = community.create_room(community.RoomCreate(kind='direct', peer=self.names[1]), self.alice)['id']
        sent = community.send(room, body='Legacy fetch', note_id=None, file=None, user=self.alice)['id']
        with community.job_queue._connect() as db:
            db.execute('UPDATE people_chat.bob_chat_members SET last_read=%s WHERE room_id=%s AND username=%s',
                       (sent, room, self.names[1]))
        receipts = {row['username']: row for row in community.receipts(room, Response(), self.alice)}
        self.assertEqual(receipts[self.names[1]]['last_read'], 0)
        with patch.object(community, 'changed') as notify:
            self.assertEqual(community.mark_read(room, community.ReadAcknowledgement(message_id=sent), self.bob),
                             {'last_read': sent, 'last_seen': sent})
            self.assertEqual(notify.call_count, 1)
        receipts = {row['username']: row for row in community.receipts(room, Response(), self.alice)}
        self.assertEqual(receipts[self.names[1]]['last_read'], sent)

    def test_delete_message_only_sender_and_removes_shared_attachment(self):
        room = community.create_room(community.RoomCreate(kind='direct', peer=self.names[1]), self.alice)['id']
        message = community.send(room, body='Delete me', note_id=None,
            file=UploadFile(BytesIO(b'private'), filename='slides.pdf'), user=self.alice)['id']
        for user in (self.bob, self.eve):
            with self.assertRaises(HTTPException) as error:
                community.delete_message(room, message, user)
            self.assertEqual(error.exception.status_code, 404)
        self.assertEqual(len(community.messages(room, Response(), after=0, user=self.bob)), 1)
        self.assertEqual(community.delete_message(room, message, self.alice), {'deleted': message})
        self.assertEqual(community.messages(room, Response(), after=0, user=self.bob), [])
        with self.assertRaises(HTTPException) as error:
            community.attachment(room, message, self.bob)
        self.assertEqual(error.exception.status_code, 404)

    def test_private_group_exact_audience_and_outsider_isolation(self):
        room = community.create_room(community.RoomCreate(kind='channel', name='Private group',
            visibility='private', members=[self.names[1], self.names[1], self.names[0]]), self.alice)['id']
        listing = next(row for row in community.rooms(Response(), self.bob) if row['id'] == room)
        self.assertEqual(listing['visibility'], 'private')
        self.assertEqual(listing['member_count'], 2)
        self.assertNotIn(room, [row['id'] for row in community.rooms(Response(), self.eve)])
        self.assertEqual({row['username'] for row in community.room_members(room, Response(), self.bob)}, set(self.names[:2]))
        for operation in (
            lambda: community.subscribe(room, self.eve),
            lambda: community.room_members(room, Response(), self.eve),
            lambda: community.messages(room, Response(), after=0, user=self.eve),
            lambda: community.send(room, body='Intrusion', note_id=None, file=None, user=self.eve),
        ):
            with self.assertRaises(HTTPException) as error:
                operation()
            self.assertEqual(error.exception.status_code, 404)
        community.send(room, body='Invited', note_id=None, file=None, user=self.bob)
        self.assertEqual(community.messages(room, Response(), after=0, user=self.alice)[0]['body'], 'Invited')
        community.unsubscribe(room, self.bob)
        with self.assertRaises(HTTPException):
            community.subscribe(room, self.bob)
        with self.assertRaises(HTTPException):
            community.room_members(room, Response(), self.bob)

    def test_private_group_requires_registered_other_members(self):
        for invited in ([], [self.names[0]], ['not-a-registered-member'], [self.names[1], 'not-a-registered-member']):
            with self.assertRaises(HTTPException) as error:
                community.create_room(community.RoomCreate(kind='channel', name='Rejected', visibility='private', members=invited), self.alice)
            self.assertEqual(error.exception.status_code, 422)
        self.assertFalse(any(row['name'] == 'Rejected' for row in community.rooms(Response(), self.alice)))

    def test_sender_names_resolve_profiles_for_self_and_peer_and_safe_fallback(self):
        opaque = 'kc-' + self.names[2]
        with community.job_queue._connect() as db:
            db.execute('INSERT INTO users(username,password_hash,is_admin) VALUES (%s,%s,false)',
                       (opaque, 'disabled-test-account'))
        self.names.append(opaque)
        with community.job_queue._connect() as db:
            for username, name in ((self.names[0], 'Alice Example'), (self.names[1], 'Bob Example'), (opaque, opaque)):
                db.execute('INSERT INTO bob_user_profiles(username,display_name) VALUES (%s,%s)', (username, name))
        room = community.create_room(community.RoomCreate(kind='channel', name='Names'), self.alice)['id']
        for user in (self.alice, self.bob, {'username': opaque}):
            community.subscribe(room, user)
            community.send(room, body='Hello', note_id=None, file=None, user=user)
        for reader in (self.alice, self.bob):
            rows = community.messages(room, Response(), after=0, user=reader)
            self.assertEqual([row['sender_name'] for row in rows], ['Alice Example', 'Bob Example', 'Member'])
            self.assertEqual([row['sender'] for row in rows], [self.names[0], self.names[1], opaque])
        directory = {row['username']: row['display_name'] for row in community.members(self.alice)}
        self.assertEqual(directory[self.names[1]], 'Bob Example')
        self.assertEqual(directory[opaque], 'Member')
        direct = community.create_room(community.RoomCreate(kind='direct', peer=opaque), self.alice)['id']
        self.assertEqual(next(row['name'] for row in community.rooms(Response(), self.alice) if row['id'] == direct), 'Member')
        with community.job_queue._connect() as db:
            db.execute('DELETE FROM bob_user_profiles WHERE username=ANY(%s)', (self.names,))
        self.assertEqual(community.messages(room, Response(), after=0, user=self.alice)[2]['sender_name'], 'Member')

    def test_websocket_receives_committed_member_notification_without_content(self):
        from threading import Event, Thread
        from unittest.mock import AsyncMock
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        room = community.create_room(community.RoomCreate(kind='direct', peer=self.names[1]), self.alice)['id']
        foreign = community.create_room(community.RoomCreate(kind='channel', name='Other channel'), self.eve)['id']
        listening, delivered, checked_foreign = Event(), Event(), Event()
        errors = []
        original_connect = community.psycopg.AsyncConnection.connect

        class ListeningConnection:
            def __init__(self, db):
                self.db = db
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                await self.db.close()
            async def execute(self, sql, params=None):
                cursor = await self.db.execute(sql, params)
                if sql.startswith('LISTEN '):
                    listening.set()
                elif params and params[0] == foreign:
                    checked_foreign.set()
                return cursor
            def notifies(self, **kwargs):
                return self.db.notifies(**kwargs)

        async def connect(*args, **kwargs):
            return ListeningConnection(await original_connect(*args, **kwargs))

        def publish():
            try:
                if not listening.wait(5):
                    raise AssertionError('WebSocket listener never became ready')
                with community.job_queue._connect() as db:
                    community.changed(db, foreign)
                if not checked_foreign.wait(5):
                    raise AssertionError('Foreign room membership was not checked')
                for attempt in range(30):
                    with community.job_queue._connect() as db:
                        community.changed(db, room)
                    if delivered.wait(0.1):
                        break
            except Exception as error:
                errors.append(error)

        app = FastAPI()
        app.include_router(community.router)
        publisher = Thread(target=publish, daemon=True)
        with patch.object(community.psycopg.AsyncConnection, 'connect', side_effect=connect), \
             patch.object(community, 'current_user', new=AsyncMock(side_effect=[self.alice, self.alice, HTTPException(401)])):
            publisher.start()
            with TestClient(app) as client:
                with client.websocket_connect('/api/community/ws', headers={'origin': 'http://testserver'}) as socket:
                    self.assertEqual(socket.receive_json(), {'type': 'ping'})
                    self.assertEqual(socket.receive_json(), {'type': 'refresh', 'room_id': room})
                    delivered.set()
                    with self.assertRaises(WebSocketDisconnect):
                        socket.receive_json()
            publisher.join(5)
        self.assertFalse(publisher.is_alive())
        self.assertEqual(errors, [])

    def test_channel_subscription_controls_message_access(self):
        room = community.create_room(community.RoomCreate(kind='channel', name='Integration channel'), self.alice)['id']
        community.send(room, body='Welcome', note_id=None, file=None, user=self.alice)
        listing = next(row for row in community.rooms(Response(), self.bob) if row['id'] == room)
        self.assertFalse(listing['subscribed'])
        with self.assertRaises(HTTPException):
            community.messages(room, Response(), after=0, user=self.bob)
        community.subscribe(room, self.bob)
        self.assertEqual(len(community.messages(room, Response(), after=0, user=self.bob)), 1)
        community.unsubscribe(room, self.bob)
        with self.assertRaises(HTTPException):
            community.messages(room, Response(), after=0, user=self.bob)


if __name__ == '__main__':
    import unittest
    unittest.main()
