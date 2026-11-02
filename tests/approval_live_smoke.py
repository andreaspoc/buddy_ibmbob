"""Live Bob: reject then approve an actual edit in disposable workspaces."""
import asyncio
import os
import tempfile
from pathlib import Path
from acp import PROTOCOL_VERSION
from acp.schema import TextContentBlock
from app.acp_bridge import CaptureClient, approval_agent_process, approval_child_environment

class ReviewClient(CaptureClient):
    def __init__(self, marker, approve):
        super().__init__()
        self.marker, self.approve, self.requests = marker, approve, 0

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        kind=tool_call.kind
        option=next(o for o in options if o.kind=='allow_once')
        if kind in {'read','search','think'}:
            return {'outcome':{'outcome':'selected','optionId':option.option_id}}
        assert kind in {'edit','execute'}, 'Expected actual write permission'
        assert not self.marker.exists(), 'Write ran before approval'
        self.requests+=1
        assert self.requests==1, 'Unexpected repeated write'
        return ({'outcome':{'outcome':'selected','optionId':option.option_id}} if self.approve
                else {'outcome':{'outcome':'cancelled'}})

async def run():
    for approve in (False, True):
        with tempfile.TemporaryDirectory(prefix='approval-live-') as directory:
            workspace=Path(directory)/'workspace'; workspace.mkdir()
            home=Path(directory)/'home'; home.mkdir()
            marker=workspace/'approval-marker.txt'
            client=ReviewClient(marker,approve)
            async with approval_child_environment(str(home),'') as env:
                async with approval_agent_process(client,str(workspace),env) as (conn,proc):
                    await conn.initialize(protocol_version=PROTOCOL_VERSION)
                    session=await conn.new_session(cwd=str(workspace),mcp_servers=[])
                    await asyncio.wait_for(conn.prompt(session_id=session.session_id,
                        prompt=[TextContentBlock(type='text',text='Use your file edit tool to create approval-marker.txt in the current workspace containing exactly approved. Do not use shell. Do not retry if permission is rejected.')]),timeout=180)
            assert client.requests==1
            if approve:
                assert marker.read_text().strip()=='approved'
            else:
                assert not marker.exists()
            print('Live actual edit approved once' if approve else 'Live rejection prevented actual edit')
if os.getenv('BOB_APPROVAL_LIVE_SMOKE') != '1':
    print('Live approval smoke skipped; set BOB_APPROVAL_LIVE_SMOKE=1 to enable')
else:
    asyncio.run(run())
