"""New feature browser flows with explicitly synthetic API fixtures."""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

async def main():
    errors, requests = [], []
    user = dict(username='fixture-admin', display_name='Fixture Admin', is_admin=True, groups=[])
    session = 'a' * 32
    comments = []
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda error: errors.append(str(error)))
        await page.add_init_script("localStorage.setItem('bob-ui-language','en');")
        async def route_request(route):
            request=route.request; path=urlsplit(request.url).path
            if path=='/' or path.startswith('/assets/') or path.endswith(('.svg','.png','.ico')):
                await route.continue_(); return
            requests.append((path,request.method))
            data=[]
            if path=='/auth/status': data={'user':user}
            elif path == '/api/apps': data = {'apps': [{'id': identity, 'name': label, 'description': 'Synthetic app fixture', 'kind': 'core', 'desktop_only': False, 'launch': {'kind': identity}} for identity, label in [('research', 'Research reports'), ('knowledge', 'Knowledge base'), ('productivity', 'Productivity workspace'), ('workflows', 'Workflows'), ('search', 'Search saved work'), ('presentations', 'Presentations')]]}
            elif path=='/personalization/tutorials': data={'disabled':True}
            elif path=='/sessions': data=[{'id':session,'title':'Synthetic review fixture','updated':'2026-10-14T00:00:00Z'}]
            elif path==f'/sessions/{session}/history': data=[]
            elif path.startswith('/auth/microsoft'): data={'configured':False,'connected':False}
            elif path=='/search': data={'results':[{'kind':'files','id':'fixture-file','title':'Synthetic report.md','snippet':'Synthetic searchable passage','session_id':session,'path':'report.md'}],'has_more':False}
            elif path=='/documents/compare': data={'before_name':'original.txt','after_name':'revised.txt','method':'Text comparison','summary':{'added_lines':1,'removed_lines':1,'unchanged_lines':1},'changes':[{'kind':'modified','before':[{'text':'Old synthetic clause','source':'original.txt','location':'text','line':2}],'after':[{'text':'New synthetic clause','source':'revised.txt','location':'text','line':2}]}]}
            elif path=='/admin/users': data={'users':[user],'pending_admins':[]}
            elif path=='/admin/feedback': data={'items':[],'next_before_id':None}
            elif path=='/admin/feedback/quality': data={'days':30,'totals':{'reports':2,'open':1,'reviewed':0,'resolved':1,'reporters':1},'categories':[{'category':'incorrect_answer','reports':2}],'sources':[{'source_document_id':'fixture','source_filename':'Synthetic policy.txt','reports':2,'unresolved':1}],'trend':[{'day':'2026-10-14','reports':2,'resolved':1}]}
            elif path=='/admin/audit': data={'events':[],'next_before_id':None}
            elif path=='/admin/smtp': data={'enabled':False,'host':'','port':587,'security':'starttls','username':'','sender_address':'','sender_name':''}
            elif path==f'/sessions/{session}/artifacts': data=[{'path':'review.html','kind':'html'}]
            elif path==f'/sessions/{session}/artifacts/source': data={'path':'review.html','content':'<h1>Synthetic artifact</h1>','sha256':'fixturehash','kind':'html'}
            elif path==f'/sessions/{session}/artifacts/history': data=[]
            elif path=='/artifact-comments':
                if request.method=='POST':
                    posted=request.post_data_json
                    comments.append({'id':1,'anchor':posted['anchor'],'comment':posted['comment'],'status':'open','outdated':False,'created_at':'2026-10-14T00:00:00Z'})
                    data=comments[-1]
                else: data={'items':comments,'has_more':False}
            elif path=='/artifact-comments/1':
                comments[0]['status']=request.post_data_json['status']; data=comments[0]
            await route.fulfill(status=200,content_type='application/json',body=json.dumps(data))
        await page.route('**/*',route_request)
        await page.goto(os.getenv('LANGUAGE_PREVIEW_URL','http://127.0.0.1:8080'))
        await page.get_by_role('button',name='Apps',exact=True).click()
        await page.get_by_role('dialog',name='Apps',exact=True).locator('.installed-app-card').filter(has_text='Search saved work').click()
        search=page.get_by_role('dialog',name='Unified search')
        await search.get_by_role('searchbox').fill('synthetic')
        await search.get_by_role('button',name='Synthetic report.md').wait_for()
        await search.get_by_label('Search in',exact=True).select_option('knowledge')
        await search.get_by_text('Synthetic searchable passage').wait_for()
        await search.get_by_role('button',name='Close',exact=True).click()
        await page.get_by_role('button',name='Buddy menu',exact=True).click()
        await page.get_by_role('button',name='Compare documents',exact=True).click()
        comparison=page.get_by_role('dialog',name='Compare documents')
        await comparison.get_by_label('Original document').set_input_files({'name':'original.txt','mimeType':'text/plain','buffer':b'Old synthetic clause'})
        await comparison.get_by_label('Revised document').set_input_files({'name':'revised.txt','mimeType':'text/plain','buffer':b'New synthetic clause'})
        await comparison.get_by_role('button',name='Compare documents',exact=True).click()
        await comparison.get_by_text('Old synthetic clause',exact=True).wait_for()
        await comparison.get_by_text('New synthetic clause',exact=True).wait_for()
        await comparison.get_by_role('button',name='Close',exact=True).click()
        await page.get_by_role('button',name='Settings menu',exact=True).click()
        await page.get_by_role('button',name='User groups & administrators',exact=True).click()
        await page.get_by_role('heading',name='Answer quality',exact=True).wait_for()
        await page.get_by_text('Synthetic policy.txt',exact=True).wait_for()
        await page.get_by_label('Reporting period').select_option('7')
        await page.get_by_text('Synthetic policy.txt',exact=True).wait_for()
        await page.get_by_role('button',name='← Back to chat',exact=True).click()
        await page.get_by_role('button',name='Synthetic review fixture',exact=True).click()
        await page.get_by_role('button',name='Buddy menu',exact=True).click()
        await page.get_by_role('button',name='Artifact editor',exact=True).click()
        await page.get_by_role('button',name='Review comments',exact=True).click()
        review=page.get_by_role('region',name='Artifact review comments')
        await review.get_by_label('Location',exact=True).fill('Paragraph 1')
        await review.get_by_label('Comment',exact=True).fill('Explicit synthetic review comment')
        await review.get_by_role('button',name='Add comment',exact=True).click()
        await review.get_by_text('Explicit synthetic review comment',exact=True).wait_for()
        await review.get_by_role('button',name='Resolve',exact=True).click()
        await review.get_by_role('button',name='Reopen',exact=True).wait_for()
        await page.set_viewport_size({'width':390,'height':844})
        assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2')
        assert not errors, errors
        assert ('/documents/compare','POST') in requests
        print('Synthetic browser checks passed: unified search, comparison uploads and citations, quality period, artifact comment creation and resolution, narrow layout.')
        await browser.close()

asyncio.run(main())
