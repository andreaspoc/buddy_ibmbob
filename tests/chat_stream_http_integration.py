"""Exercise /chat/stream over real HTTP with isolated queue and identity fixtures."""
import json
import threading
import time
from contextlib import ExitStack
from unittest.mock import Mock, patch
from urllib.request import Request, urlopen
import uvicorn
from app import main
from app.auth import current_user

async def test_events(job_id):
    for event in ({'type':'start'}, {'type':'delta','text':'Explicit HTTP test fixture'}, {'type':'done'}):
        yield json.dumps(event)+'\n'

async def test_user():
    return {'username':'stream-regression-test'}

with ExitStack() as stack:
    changes = {
        'workspace_for': lambda *args: '/tmp',
        'list_modes': lambda: [{'slug':'agent'}],
        'list_skills': lambda: [],
        'presentation_intent': lambda *args: {'presentation':False},
        'read_history': lambda *args: [],
        'workspace_key': lambda *args: 'test-workspace',
        'append_history': Mock(), 'touch_session': Mock(),
        '_stream_job_events': test_events,
    }
    for name, value in changes.items():
        stack.enter_context(patch.object(main,name,value))
    enqueue=stack.enter_context(patch.object(main.job_queue,'enqueue',return_value='test-job'))
    main.app.dependency_overrides[current_user]=test_user
    server=uvicorn.Server(uvicorn.Config(main.app,host='127.0.0.1',port=8099,log_level='error',lifespan='off'))
    thread=threading.Thread(target=server.run,daemon=True)
    thread.start()
    for attempt in range(100):
        if server.started: break
        time.sleep(.05)
    assert server.started
    try:
        request=Request('http://127.0.0.1:8099/chat/stream',data=json.dumps({'prompt':'HTTP regression test','workspace_id':'legacy','mode':'agent'}).encode(),headers={'Content-Type':'application/json'})
        with urlopen(request,timeout=10) as response:
            assert response.status==200
            assert response.headers['X-Bob-Job-Id']=='test-job'
            events=[json.loads(line) for line in response if line.strip()]
        assert [e['type'] for e in events]==['start','delta','done']
        assert enqueue.call_count==1
        assert main.append_history.call_count==1
        print(json.dumps({'httpStreaming':True,'validJobHeader':True,'submissions':enqueue.call_count,'historyRequests':main.append_history.call_count}))
    finally:
        server.should_exit=True
        thread.join(timeout=5)
        main.app.dependency_overrides.clear()
