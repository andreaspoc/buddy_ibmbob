"""Team adapter preserves signed requests and cannot proxy arbitrary hosts."""
import asyncio
import httpx
from app.acp_team_gateway import gateway_app

async def run():
    seen=[]
    async def upstream(request):
        seen.append(request)
        assert str(request.url)=='https://api.us-east.bob.ibm.com/inference/v1/chat?model=1'
        assert request.headers['x-team-id']=='configured-team'
        assert request.headers['x-request-signature']=='signed'
        assert await request.aread()==b'{"message":"unchanged"}'
        return httpx.Response(200, stream=httpx.ByteStream(b'chunk1\nchunk2\n'),headers={'Content-Type':'text/event-stream'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=gateway_app('configured-team','test-key',upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.post('/inference/v1/chat?model=1',headers={'Authorization':'apikey test-key','x-team-id':'untrusted','x-request-signature':'signed'},content=b'{"message":"unchanged"}')).content==b'chunk1\nchunk2\n'
            assert len(seen)==1
            assert (await client.get('/inference/v1/chat')).status_code==403
            assert (await client.get('/https://other.example',headers={'Authorization':'apikey test-key'})).status_code==404
            assert (await client.get('/admin/v1/profile',headers={'Authorization':'apikey wrong-key'})).status_code==403
            assert len(seen)==1
asyncio.run(run())
print('Team adapter preserves signature/body and rejects other keys/destinations')

async def region_metadata():
    import json
    profile={'user_id':'user','instances':[{'instance_id':'instance','subscription_id':'subscription','region_domain':'eu-de.bob.ibm.com','teams':[{'id':'configured-team','budget_limit':42}]}]}
    seen=[]
    async def upstream(request):
        seen.append(str(request.url))
        if request.url.path=='/admin/v1/profile':
            return httpx.Response(200,stream=httpx.ByteStream(json.dumps(profile).encode()),headers={'content-type':'application/json','etag':'old'})
        assert str(request.url)=='https://api.eu-de.bob.ibm.com/inference/v1/a%2Fb?q=%2f&x=a+b'
        return httpx.Response(200,stream=httpx.ByteStream(b'ok'))
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=gateway_app('configured-team','test-key',upstream_client)),base_url='http://test',headers={'Authorization':'apikey test-key'}) as client:
            response=await client.get('/admin/v1/profile')
            expected=json.loads(json.dumps(profile));del expected['instances'][0]['region_domain']
            assert response.json()==expected and 'etag' not in response.headers
            assert (await client.get('/inference/v1/a%2Fb?q=%2f&x=a+b')).text=='ok'
asyncio.run(region_metadata())
print('Real profile metadata preserved; signed encoded targets use configured team region')

async def cancelled_stream_cleanup():
    import time
    from unittest.mock import patch
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from app.acp_team_gateway import team_gateway
    entered=asyncio.Event(); blocked=asyncio.Event(); info={}
    app=FastAPI()
    @app.get('/stream')
    async def stream():
        async def chunks():
            yield b'first'
            await blocked.wait()
        return StreamingResponse(chunks())
    async def owner():
        with patch('app.acp_team_gateway.gateway_app',return_value=app):
            async with team_gateway('team','test-key') as url:
                info['url']=url
                entered.set()
                await asyncio.Event().wait()
    owner_task=asyncio.create_task(owner());await entered.wait()
    async with httpx.AsyncClient(timeout=10) as client:
        async with client.stream('GET',info['url']+'/stream') as response:
            assert await anext(response.aiter_bytes())==b'first'
            started=time.monotonic();owner_task.cancel()
            try:await owner_task
            except asyncio.CancelledError:pass
            assert time.monotonic()-started<5
        try:await client.get(info['url']+'/stream')
        except httpx.ConnectError:pass
        else:raise AssertionError('Cancelled gateway listener remained open')
asyncio.run(cancelled_stream_cleanup())
print('Cancellation closes active streams and localhost listener within five seconds')
