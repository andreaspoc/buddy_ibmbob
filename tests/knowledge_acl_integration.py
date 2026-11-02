"""Knowledge ACL coverage in an isolated PostgreSQL schema, using test source fixtures."""
import asyncio
import json
import os
import secrets
import uuid
from pathlib import Path
from unittest.mock import patch, AsyncMock
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from app import auth, rag, job_queue
from app.knowledge_broker import search_shared, knowledge_broker
from tests.group_fixtures import delete_group, make_group, set_members


def main():
    original = os.environ['DATABASE_URL']
    schema = 'knowledge_acl_' + secrets.token_hex(5)
    with psycopg.connect(original, autocommit=True) as db:
        db.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    os.environ['DATABASE_URL'] = make_conninfo(original, options=f'-c search_path={schema}')
    rag._schema_ready = False
    try:
        for username in ('admin', 'alpha', 'beta', 'alpha-beta', 'unassigned'):
            auth.create_user(username, secrets.token_urlsafe(20), admin=username == 'admin', setup=username == 'admin')
        group_a = make_group('alpha', 'alpha', 'alpha-beta')
        group_b = make_group('beta', 'beta', 'alpha-beta')
        docs = {}
        for audience in ('both', group_a, group_b):
            text = f'Test policy fixture for {audience}.'
            doc = rag.add_document('admin','shared',f'{audience}.txt',text.encode(),audience=audience,admin=True)
            docs[audience] = doc['id']
            with job_queue._connect() as db:
                db.execute("UPDATE bob_knowledge_documents SET status='ready',model=%s,model_digest='fixture',dimensions=2,chunk_count=1,prepared_text=%s WHERE id=%s", (rag.model(),text,doc['id']))
                db.execute("INSERT INTO bob_knowledge_chunks VALUES(%s,0,'text',%s,'[1.0,0.0]'::jsonb)", (doc['id'],text))
        assert len(rag.list_documents('admin',admin=True)) == 3
        everyone, only_a, only_b = docs['both'], docs[group_a], docs[group_b]
        expected = {
            'alpha': {everyone, only_a},
            'beta': {everyone, only_b},
            'alpha-beta': {everyone, only_a, only_b},
            'unassigned': {everyone},
            'admin': {everyone},
            'missing-user': set(),
        }
        for username, allowed in expected.items():
            assert {d['id'] for d in rag.list_documents(username)} == allowed,username
            chunks = rag.ready_chunks(username,'any')
            assert {str(d['id']) for d in chunks} == allowed,username
            for doc_id in docs.values():
                assert bool(rag.get_document(username,'any',doc_id)) == (doc_id in allowed),username
            assert {str(p['id']) for p in rag.snapshot_passages(username,'any',rag.ready_chunks('alpha-beta','any'))} == allowed,username
        with patch.object(rag,'model_digest',AsyncMock(return_value='fixture')), patch.object(rag,'embed_passage',AsyncMock(return_value=[{'embedding':[1.,0.]}])):
            passages = asyncio.run(rag.retrieve('beta','shared','policy',knowledge_base='company'))
            assert {str(p['id']) for p in passages} == {everyone, only_b}
            text = asyncio.run(search_shared('policy','beta'))
            assert f'{group_b}.txt' in text and f'{group_a}.txt' not in text
        passage = next(p for p in passages if str(p['id']) == only_b)
        quote = passage['text']
        assert rag.citation_preview('beta','any',str(passage['id']),passage['citation_id'],quote)['exact']
        assert rag.citation_preview('alpha','any',str(passage['id']),passage['citation_id'],quote) is None
        # Revocations affect previously issued citation URLs and future retrieval immediately.
        set_members(group_b, 'alpha-beta')
        assert rag.citation_preview('beta','any',str(passage['id']),passage['citation_id'],quote) is None
        assert rag.get_document('beta','any',str(passage['id'])) is None
        try:
            rag.update_classification('alpha','shared',everyone,'company',group_a,admin=True)
            raise AssertionError('Nonadministrator classification accepted')
        except PermissionError:
            pass
        try:
            rag.add_document('alpha','shared','blocked.txt',b'Not allowed',admin=True)
            raise AssertionError('Nonadministrator upload accepted')
        except PermissionError:
            pass
        # An audience must be a group that exists right now.
        for invalid in ('alpha', str(uuid.uuid4())):
            try:
                rag.update_classification('admin','shared',everyone,'company',invalid,admin=True)
                raise AssertionError('Unknown audience accepted')
            except ValueError:
                pass
        updated = rag.update_classification('admin','shared',only_a,'company',group_b,admin=True,description='Moved fixture')
        assert updated['audience'] == group_b and updated['description'] == 'Moved fixture'
        assert rag.get_document('alpha','shared',updated['id']) is None
        assert rag.get_document('admin','shared',updated['id'],admin=True) is not None
        # Ranked passages retain old labels, so snapshots must replace those labels.
        current = rag.ready_chunks('alpha-beta','shared')
        ranked = [{**p, 'audience':'both'} for p in current if str(p['id']) == updated['id']]
        assert rag.snapshot_passages('alpha-beta','shared',ranked)[0]['audience'] == group_b
        # Deleting a group can never widen access: its content becomes administrator-only.
        delete_group(group_b)
        assert rag.get_document('alpha-beta','any',only_b) is None
        assert only_b not in {d['id'] for d in rag.list_documents('unassigned')}
        assert rag.get_document('admin','shared',only_b,admin=True) is not None
        # Identical bytes can be classified for different audiences without unique conflicts.
        rag.add_document('admin','shared','duplicate-fixture.txt',b'Identical fixture',admin=True)
        rag.add_document('admin','shared','duplicate-fixture.txt',b'Identical fixture',audience=group_a,admin=True)
        async def denied():
            try:
                await search_shared('policy')
                raise AssertionError('Unbound search accepted')
            except PermissionError:
                pass
        asyncio.run(denied())
        print('Knowledge ACL integration passed: everyone and group audiences, direct downloads, citations, revocations, admin management, caller binding')
    finally:
        os.environ['DATABASE_URL'] = original
        rag._schema_ready = False
        with psycopg.connect(original,autocommit=True) as db:
            db.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


if __name__ == '__main__':
    main()
