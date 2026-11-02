"""Disposable real-DB/S3/HTTP checks. Uses explicitly synthetic accounts and book."""
import asyncio
import io
import json
import os
import secrets
from uuid import uuid4
from zipfile import ZipFile
import httpx
from fastapi import Response
from starlette.requests import Request
from app import auth, job_queue
from app.keycloak_groups import sync, realm
from app.s3_client import client as s3

async def main():
    prefix = 'learning-test-' + uuid4().hex[:10]
    names = [prefix+'-admin', prefix+'-member', prefix+'-group', prefix+'-outsider']
    folder_id = None; key = None
    users = []
    try:
        for index, name in enumerate(names):
            user = auth.create_user(name, secrets.token_urlsafe(24), admin=index == 0)
            response = Response()
            auth.start_session(response, user, Request({'type':'http','scheme':'http','path':'/','headers':[],'server':('localhost',8080)}))
            token = response.headers['set-cookie'].split(';')[0].split('=',1)[1]
            users.append(httpx.AsyncClient(base_url=os.getenv('LEARNING_TEST_URL','http://learning-plugin:8080'), cookies={auth.COOKIE:token}, headers={'Origin':os.getenv('LEARNING_TEST_URL','http://learning-plugin:8080')}, timeout=100, trust_env=False))
        with job_queue._connect() as db:
            for index, name in enumerate(names):
                subject = prefix + str(index)
                db.execute('INSERT INTO bob_keycloak_identities(issuer,subject,username) VALUES(%s,%s,%s)', (realm(), subject, name))
                sync(db, realm(), subject, {'groups':['/SyntheticLearning/Team','/teacher'] if index == 2 else []})
        admin, member, group, outsider = users
        async def request(client, method, path, status=200, **kwargs):
            response = await client.request(method, '/api/learning'+path, **kwargs)
            assert response.status_code == status, (method,path,response.status_code,response.text[:500])
            return response
        folder_id = (await request(admin,'POST','/folders',json={'name':prefix})).json()['id']
        await request(admin,'PUT',f'/folders/{folder_id}/members',json={'usernames':[names[1]],'groups':['/SyntheticLearning/Team']})
        assert folder_id in [row['id'] for row in (await request(group,'GET','/folders')).json()['items']]
        await request(outsider,'GET',f'/folders/{folder_id}/contents',status=404)
        buffer=io.BytesIO()
        with ZipFile(buffer,'w') as archive:
            archive.writestr('mimetype','application/epub+zip')
            archive.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
            archive.writestr('book.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Synthetic Learning Fixture</dc:title><dc:creator>Test Fixture</dc:creator></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>')
            archive.writestr('one.xhtml','<html><body><h1>Fixture chapter</h1><p>Synthetic plants need water and sunlight. This book is a test fixture.</p><script>window.bad=true</script></body></html>')
        book=(await request(admin,'POST',f'/folders/{folder_id}/books',files={'file':('fixture.epub',buffer.getvalue(),'application/epub+zip')})).json()
        with job_queue._connect() as db:
            key = db.execute('SELECT object_key FROM learning.books WHERE id=%s',(book['id'],)).fetchone()['object_key']
        if os.getenv('LEARNING_TEST_BROWSER') == '1':
            from playwright.async_api import async_playwright
            import re
            base=os.getenv('LEARNING_TEST_URL','http://bob-agent:8080')
            apps=(await admin.get('/api/apps')).json()['apps']
            assert any(app['id']=='learning' and app['launch']['url']=='/learning/' for app in apps)
            async with async_playwright() as runtime:
                browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox','--unsafely-treat-insecure-origin-as-secure='+base])
                context=await browser.new_context(viewport={'width':1440,'height':1000})
                await context.add_cookies([{'name':auth.COOKIE,'value':admin.cookies.get(auth.COOKIE),'url':base}])
                page=await context.new_page()
                await page.goto(base+'/learning/')
                await page.get_by_role('button',name=re.compile(re.escape(prefix))).click()
                await page.get_by_role('button',name='Read book →',exact=True).click()
                await page.frame_locator('iframe').get_by_text('Synthetic plants need water and sunlight.',exact=False).wait_for()
                assert await page.locator('iframe').get_attribute('sandbox') == ''
                assert await page.locator('body').evaluate('el => el.scrollWidth <= innerWidth')
                await browser.close()
            print('PASS: production Apps launcher, authenticated learning workspace, and real EPUB reader iframe.')
        info=(await request(member,'GET',f"/books/{book['id']}")).json()
        chapter=await request(group,'GET',f"/books/{book['id']}/chapters/0")
        assert '<script' not in chapter.text and 'sandbox' in chapter.headers['content-security-policy']
        await request(outsider,'GET',f"/books/{book['id']}/chapters/0",status=404)
        await request(member,'PUT',f"/books/{book['id']}/progress",json={'chapter_id':'0','bookmarks':[{'chapter_id':'0','label':'Fixture'}]})
        assert (await request(member,'GET',f"/books/{book['id']}")).json()['progress']['bookmarks']
        assert (await request(group,'GET',f"/books/{book['id']}")).json()['progress']=={}
        spec={'title':'Synthetic assessment','book_id':book['id'],'questions':[
            {'id':'choice','type':'dropdown','question':'What do fixture plants need?','options':['Water','Metal'],'answer':[0],'points':2},
            {'id':'written','type':'text','question':'Describe the fixture requirements.','answer':'Water and sunlight.','rubric':'One point each for water and sunlight.','points':2}]}
        quiz=(await request(admin,'POST',f'/folders/{folder_id}/quizzes',json=spec)).json(); qid=quiz['id']
        await request(member,'GET',f'/quizzes/{qid}',status=404)
        await request(admin,'POST',f'/quizzes/{qid}/publish',json={})
        quiz=(await request(member,'GET',f'/quizzes/{qid}')).json()
        assert all('answer' not in question and 'rubric' not in question for question in quiz['questions'])
        payload={'version':quiz['version'],'request_id':str(uuid4()),'answers':{'choice':[0],'written':'Water and sunlight.'}}
        confirmation=(await request(member,'POST',f'/quizzes/{qid}/submit',json=payload)).json()
        assert confirmation == {'submitted':True}
        assert (await request(member,'POST',f'/quizzes/{qid}/submit',json=payload)).json()==confirmation
        await request(member,'GET',f'/quizzes/{qid}/results',status=403)
        await request(member,'GET',f'/quizzes/{qid}/results.csv',status=403)
        results=(await request(admin,'GET',f'/quizzes/{qid}/results')).json()['items']
        assert len(results)==1 and results[0]['score']==2 and results[0]['pending_manual']
        await request(admin,'PUT',f"/submissions/{results[0]['id']}/grade",json={'grades':{'written':{'score':2,'feedback':'Synthetic review'}}})
        marked=(await request(admin,'GET',f'/quizzes/{qid}/results')).json()['items'][0]
        assert marked['score']==4 and not marked['pending_manual']
        await request(admin,'POST',f'/quizzes/{qid}/close',json={})
        await request(admin,'PUT',f'/quizzes/{qid}',json={**spec,'title':'Synthetic new draft'})
        assert (await request(member,'GET',f'/quizzes/{qid}')).json()['title']=='Synthetic assessment'
        await request(admin,'POST',f'/quizzes/{qid}/publish',json={})
        await request(group,'POST',f'/quizzes/{qid}/submit',json=payload,status=409)
        assert len((await request(admin,'GET',f'/quizzes/{qid}/results')).json()['items'])==1
        assert (await request(group,'GET','/me')).json()['can_create_quizzes']
        teacher_quiz=(await request(group,'POST',f'/folders/{folder_id}/quizzes',json=spec)).json()
        teacher_id=teacher_quiz['id']
        await request(admin,'GET',f'/quizzes/{teacher_id}',status=404)
        await request(member,'GET',f'/quizzes/{teacher_id}',status=404)
        await request(admin,'POST',f'/quizzes/{teacher_id}/publish',json={},status=404)
        await request(group,'POST',f'/quizzes/{teacher_id}/publish',json={})
        await request(admin,'POST',f'/quizzes/{teacher_id}/publish',json={},status=403)
        await request(group,'GET',f'/quizzes/{teacher_id}/results',status=403)
        assert all('answer' not in q for q in (await request(member,'GET',f'/quizzes/{teacher_id}')).json()['questions'])
        # Removing the snapshot simulates a verified login after Keycloak group removal.
        with job_queue._connect() as db:
            sync(db,realm(),prefix+'2',{'groups':[]})
        await request(group,'GET',f"/books/{book['id']}/chapters/0",status=404)
        await request(group,'POST',f'/quizzes/{teacher_id}/publish',json={},status=403)
        await request(admin,'PUT',f'/folders/{folder_id}/members',json={'usernames':[],'groups':[]})
        await request(member,'GET',f'/quizzes/{qid}',status=404)
        assert len((await request(admin,'GET',f'/quizzes/{qid}/results')).json()['items'])==1
        print('PASS: real PostgreSQL, S3 and HTTP; EPUB, user/group ACLs, reader progress, private submissions, grading, versions and revocation.')
    finally:
        for client in users:
            await client.aclose()
        if key:
            storage=s3(); bucket=os.environ['BOB_S3_BUCKET']
            for page in storage.get_paginator('list_object_versions').paginate(Bucket=bucket,Prefix=key):
                objects=[{'Key':v['Key'],'VersionId':v['VersionId']} for v in page.get('Versions',[])+page.get('DeleteMarkers',[]) if v['Key']==key]
                if objects: storage.delete_objects(Bucket=bucket,Delete={'Objects':objects})
        with job_queue._connect() as db:
            if folder_id:
                db.execute('DELETE FROM learning.submissions WHERE quiz_id IN (SELECT id FROM learning.quizzes WHERE folder_id=%s)',(folder_id,))
                db.execute('DELETE FROM learning.quizzes WHERE folder_id=%s',(folder_id,))
                db.execute('DELETE FROM learning.books WHERE folder_id=%s',(folder_id,))
                db.execute('DELETE FROM learning.folders WHERE id=%s',(folder_id,))
            db.execute('DELETE FROM bob_keycloak_identities WHERE username=ANY(%s)',(names,))
            for table in ('sessions','bob_user_profiles','users'):
                db.execute('DELETE FROM '+table+' WHERE username=ANY(%s)',(names,))
        print('Disposable learning accounts, records and book removed.')

asyncio.run(main())
