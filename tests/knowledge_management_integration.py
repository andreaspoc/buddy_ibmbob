"""Real PostgreSQL lifecycle checks, with temporary sources cleaned up."""
import uuid
import secrets
from app.auth import create_user
from app import rag, job_queue

name='knowledge-test-'+uuid.uuid4().hex
ids=[]
try:
    create_user(name,secrets.token_urlsafe(20),admin=True)
    first=rag.add_document(name,'shared','first.txt',('Original '+name).encode(),'Initial description',admin=True)
    ids.append(first['id'])
    assert first['description']=='Initial description'
    assert rag.update_description(name,'shared',first['id'],'Updated',admin=True)['description']=='Updated'
    try:
        rag.replace_document('other-user','shared',first['id'],'other.txt',b'Unauthorized')
        raise AssertionError('Unauthorized replacement accepted')
    except PermissionError:pass
    with job_queue._connect() as db:
        token=str(uuid.uuid4())
        db.execute("UPDATE bob_knowledge_documents SET status='indexing',worker_token=%s WHERE id=%s",(token,first['id']))
        db.execute("INSERT INTO bob_knowledge_chunks VALUES (%s,0,'old','old text','[1]'::jsonb)",(first['id'],))
        db.execute("INSERT INTO bob_knowledge_citations(id,document_id,sha256,location,text) VALUES (%s,%s,'old','old','old')",(str(uuid.uuid4()),first['id']))
    replaced=rag.replace_document(name,'shared',first['id'],'replacement.md',('Replacement '+name).encode(),admin=True)
    assert replaced['status']=='queued' and replaced['chunk_count']==0 and replaced['description']=='Updated'
    rag.save_index({'id':first['id'],'worker_token':token},[], 'old','old')
    with job_queue._connect() as db:
        row=db.execute('SELECT * FROM bob_knowledge_documents WHERE id=%s',(first['id'],)).fetchone()
        assert row['status']=='queued' and row['worker_token'] is None and row['prepared_text'] is None
        assert db.execute('SELECT count(*) AS n FROM bob_knowledge_chunks WHERE document_id=%s',(first['id'],)).fetchone()['n']==0
        assert db.execute('SELECT count(*) AS n FROM bob_knowledge_citations WHERE document_id=%s',(first['id'],)).fetchone()['n']==0
    try:rag.replace_document(name,'shared',first['id'],'bad.exe',b'bad',admin=True);raise AssertionError('Invalid file accepted')
    except ValueError:pass
    assert rag.get_document(name,'shared',first['id'])['filename']=='replacement.md'
    assert rag.remove_document(name,'shared',first['id'],admin=True)
    assert rag.get_document(name,'shared',first['id']) is None
    print('Knowledge lifecycle integration passed')
finally:
    with job_queue._connect() as db:
        for document_id in ids:db.execute('DELETE FROM bob_knowledge_documents WHERE id=%s',(document_id,))
        db.execute('DELETE FROM users WHERE username=%s',(name,))
