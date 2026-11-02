"""Real authenticated audio sockets; only synthetic opaque packets/test accounts."""
import asyncio,json
from pathlib import Path
from uuid import uuid4
import websockets
from websockets.exceptions import InvalidStatus,ConnectionClosed
KEY={'kty':'EC','crv':'P-256','x':'A'*43,'y':'B'*43}
async def main():
    data=json.loads(Path('/tmp/people-voice-fixture.json').read_text());users=data['users'];origin='http://127.0.0.1:8080';root='ws://127.0.0.1:8080/api/community'
    def options(user=None,foreign=False):return {'origin':'https://foreign.example.invalid' if foreign else origin,'additional_headers':{'Cookie':user['cookie']+'='+user['token']} if user else {},'proxy':None}
    async def event(ws,kind):
        async with asyncio.timeout(5):
            while True:
                value=json.loads(await ws.recv())
                if value['type']==kind:return value
                if value['type']=='call_ping':await ws.send('{"action":"ping"}')
    async with websockets.connect(root+'/calls/ws?audio=1',**options(users[0])) as caller,websockets.connect(root+'/calls/ws?audio=1',**options(users[1])) as recipient:
        ca,cb=await event(caller,'call_ready'),await event(recipient,'call_ready')
        assert ca['audio_transport']=='websocket' and ca['ice_servers']==[]
        await caller.send(json.dumps({'action':'start','room_id':data['room_id']}));call=(await event(caller,'call_state'))['call'];await event(recipient,'call_state')
        url=root+'/calls/'+call['id']+'/audio'
        for opts in [options(),options(users[0],True)]:
            try:
                async with websockets.connect(url,**opts):raise AssertionError('Unauthorized socket accepted')
            except InvalidStatus as exc:assert exc.response.status_code in (401,403)
        async def denied(user,client):
            async with websockets.connect(url,**options(user)) as ws:
                await ws.send(json.dumps({'client_id':client,'public_key':KEY}))
                try:
                    async with asyncio.timeout(3):await ws.recv();raise AssertionError('Unauthorized audio handshake accepted')
                except ConnectionClosed:pass
        await denied(users[0],ca['client_id']) # Must not receive audio before Answer.
        await recipient.send(json.dumps({'action':'accept','call_id':call['id']}))
        while (await event(caller,'call_state'))['call']['status']=='ringing':pass
        await denied(users[2],str(uuid4()));await denied(users[0],str(uuid4()))
        async with websockets.connect(url,**options(users[0])) as audio_a,websockets.connect(url,**options(users[1])) as audio_b:
            await audio_a.send(json.dumps({'client_id':ca['client_id'],'public_key':KEY}));await event(audio_a,'audio_ready')
            await audio_b.send(json.dumps({'client_id':cb['client_id'],'public_key':KEY}));await event(audio_b,'audio_ready')
            await event(audio_a,'audio_peer');await event(audio_b,'audio_peer')
            packet=b'\x17'*4124 # Synthetic opaque ciphertext; server must neither decode nor store it.
            await audio_a.send(packet)
            async with asyncio.timeout(3):assert await audio_b.recv()==packet
            await audio_a.send(b'\x00'*4096) # Plain/incorrectly sized audio frames are rejected.
            try:
                async with asyncio.timeout(3):await audio_a.recv();raise AssertionError('Invalid frame accepted')
            except ConnectionClosed:pass
    print('PASS: audio requires login, same origin, acceptance and owning client; opaque packets reach only the peer; plaintext-sized frames are rejected; no relay addresses advertised.')
asyncio.run(main())
