"""Quiz submission route: ownership, fixed marks and queued grading context."""
import json
import uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from app.main import app
from app.auth import current_user
from app.quiz import quiz_key

raw=json.dumps({'title':'Synthetic source quiz','questions':[{'id':'q1','type':'single','question':'What does the synthetic source say?','options':['A','B'],'answer':[1],'explanation':'The source says B.','source':'Synthetic.txt, section 1'},{'id':'q2','type':'text','question':'Explain the synthetic source.','answer':'The source distinguishes identity and permissions.','rubric':'Credit the distinction; accept equivalent wording.','explanation':'Identity and permissions differ.'}]})
history=[{'type':'request','prompt':'Create a document test'}, {'type':'delta','text':'```bobquiz\n'+raw+'\n```'}, {'type':'done'}]
workspace=uuid.uuid4().hex
job=uuid.uuid4().hex
prompt='Quiz submission: '+quiz_key(raw)+'\nAnswers:\n'+json.dumps({'q1':[0],'q2':'Identity and access rights are different.'})
async def user(): return {'username':'synthetic-owner','is_admin':False}
async def events(*args,**kwargs): yield json.dumps({'type':'done'})+'\n'

try:
    app.dependency_overrides[current_user]=user
    with ExitStack() as stack:
        owned=stack.enter_context(patch('app.main.workspace_for',return_value=Path('/tmp/synthetic-quiz')))
        stack.enter_context(patch('app.main.workspace_key',return_value='synthetic-quiz'))
        saved=stack.enter_context(patch('app.main.read_history',return_value=history))
        stack.enter_context(patch('app.main.list_modes',return_value=[{'slug':'agent'}]))
        intent=stack.enter_context(patch('app.main.presentation_intent',return_value={'presentation':False}))
        stack.enter_context(patch('app.main.execute_event_hooks',AsyncMock(return_value=(True,'',None))))
        queue=stack.enter_context(patch('app.main.job_queue.enqueue',return_value=job))
        record=stack.enter_context(patch('app.main.append_history'))
        stack.enter_context(patch('app.main.touch_session'))
        stack.enter_context(patch('app.main._stream_job_events',events))
        client=TestClient(app)
        response=client.post('/chat/stream',json={'workspace_id':workspace,'prompt':prompt,'agent_name':'synthetic-remote','skill_name':'synthetic-skill','template_studio':True,'edit_artifact_path':'existing.html'})
        assert response.status_code==200,response.text
        owned.assert_called_with(workspace,'synthetic-owner')
        payload=queue.call_args.args[3]
        assert payload['mode']=='agent' and payload['agent_name'] is None and payload['skill_name'] is None
        assert payload['edit_artifact_path'] is None
        assert payload['html_artifact_output_path'] is None and payload['presentation_output_path'] is None
        intent.assert_not_called()
        assert '"score": 0' in payload['quiz_grading_context']
        assert 'Credit the distinction' in payload['quiz_grading_context']
        assert record.call_args.args[2]['display_prompt']=='📝 Submitted test answers'
        assert record.call_args.args[2]['prompt']==prompt
        queue.reset_mock()
        bad=client.post('/chat/stream',json={'workspace_id':workspace,'prompt':prompt.replace('"q1": [0], ','')})
        assert bad.status_code==422,bad.text
        queue.assert_not_called()
        saved.return_value=[]
        missing=client.post('/chat/stream',json={'workspace_id':workspace,'prompt':prompt})
        assert missing.status_code==422,missing.text
        owned.side_effect=ValueError('Not owned')
        denied=client.post('/chat/stream',json={'workspace_id':workspace,'prompt':prompt})
        assert denied.status_code==404,denied.text
        app.dependency_overrides.pop(current_user,None)
        anonymous=client.post('/chat/stream',json={'workspace_id':workspace,'prompt':prompt})
        assert anonymous.status_code==401,anonymous.text
    print('PASS: quiz grading queue, fixed-choice marks, written rubric, saved attempt, validation, ownership and authentication')
finally:
    app.dependency_overrides.pop(current_user,None)
