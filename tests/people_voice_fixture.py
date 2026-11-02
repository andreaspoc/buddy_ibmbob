"""Disposable real-service accounts for WebRTC integration; emits secrets only to a local fixture file."""
import json, secrets, sys
from uuid import uuid4
from fastapi import Response
from starlette.requests import Request
from app import auth, job_queue
from buddy_people import community as c

if len(sys.argv)>1 and sys.argv[1]=='cleanup':
    data=json.load(sys.stdin)
    with job_queue._connect() as db:
        db.execute('DELETE FROM people_chat.bob_chat_rooms WHERE id=%s',(data['room_id'],))
        for user in data['users']:
            name=user['username']
            db.execute('DELETE FROM sessions WHERE username=%s',(name,));db.execute('DELETE FROM bob_user_profiles WHERE username=%s',(name,));db.execute('DELETE FROM users WHERE username=%s',(name,))
    print('Disposable voice-call accounts, sessions, room and call metadata cleaned.')
else:
    c.ensure_schema();users=[]
    for label in ['Caller','Recipient','Outsider']:
        user=auth.create_user('voice-browser-'+uuid4().hex[:12],secrets.token_urlsafe(24))
        with job_queue._connect() as db:db.execute('UPDATE bob_user_profiles SET display_name=%s WHERE username=%s',('Synthetic Voice '+label,user['username']))
        response=Response();auth.start_session(response,user,Request({'type':'http','scheme':'https','path':'/','headers':[],'server':('localhost',443)}))
        token=response.headers['set-cookie'].split(';')[0].split('=',1)[1]
        users.append({'username':user['username'],'name':'Synthetic Voice '+label,'token':token,'cookie':auth.COOKIE})
    room=c.create_room(c.RoomCreate(kind='direct',peer=users[1]['username']),user=users[0])['id']
    print(json.dumps({'users':users,'room_id':room}))
