"""Real WebSocket boundary checks using disposable synthetic call fixtures."""
import asyncio,json
from pathlib import Path
import websockets
from websockets.exceptions import InvalidStatus

async def main():
    data=json.loads(Path('/tmp/people-voice-fixture.json').read_text());users=data['users'];url='ws://127.0.0.1:8080/api/community/calls/ws?audio=1'
    def cookie(u):return {'Cookie':u['cookie']+'='+u['token']}
    for kwargs in [{'origin':'http://127.0.0.1:8080'},{'origin':'https://foreign.example.invalid','additional_headers':cookie(users[0])}]:
        try:
            async with websockets.connect(url,**kwargs):raise AssertionError('Unauthorized socket accepted')
        except InvalidStatus as exc:assert exc.response.status_code in (401,403)
    async def next_event(ws,kind):
        async with asyncio.timeout(5):
            while True:
                event=json.loads(await ws.recv())
                if event['type']=='call_ping':await ws.send('{"action":"ping"}')
                elif event['type']==kind:return event
    async with websockets.connect(url,origin='http://127.0.0.1:8080',additional_headers=cookie(users[0])) as caller,websockets.connect(url,origin='http://127.0.0.1:8080',additional_headers=cookie(users[1])) as recipient,websockets.connect(url,origin='http://127.0.0.1:8080',additional_headers=cookie(users[2])) as outsider:
        for ws in (caller,recipient,outsider):await next_event(ws,'call_ready')
        await caller.send(json.dumps({'action':'start','room_id':data['room_id']}))
        call=(await next_event(caller,'call_state'))['call'];await next_event(recipient,'call_state')
        await outsider.send(json.dumps({'action':'accept','call_id':call['id']}))
        error=await next_event(outsider,'call_error');assert error['message']=='Voice call not found'
        await caller.send(json.dumps({'action':'end','call_id':call['id'],'username':users[1]['username']}))
        error=await next_event(caller,'call_error');assert error['message']=='Unsupported voice call message'
        await recipient.send(json.dumps({'action':'decline','call_id':call['id']}))
        async with asyncio.timeout(5):
            while (await next_event(caller,'call_state'))['call']['status']!='ended':pass
        # Outsiders receive no call metadata despite the same global LISTEN channel.
        try:
            async with asyncio.timeout(.3):
                while True:
                    e=json.loads(await outsider.recv());assert e['type'] not in ('call_state','call_signal')
        except TimeoutError:pass
    print('PASS: anonymous/foreign-origin sockets denied; nonmembers cannot answer or observe a call; identity overrides rejected; decline terminates the caller state.')
asyncio.run(main())
