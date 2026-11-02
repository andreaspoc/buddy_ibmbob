"""Expanded MCP library and popup UI with intercepted synthetic responses only.

No provider authentication, connector calls, or account mutations reach services.
"""
import asyncio
import json
import os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright
from app.mcp_catalog import DEFAULTS

SID='c'*32

async def main():
    admin=False
    calls=[]; errors=[]; catalog_reads=0
    items=[]
    for definition in DEFAULTS:
        item=definition.model_dump()
        item.update(allowed=True,connected=False,ready=not item.get('requires_url'))
        items.append(item)
    forbidden={'airtable','supabase','neon','postgres','postgresql','mysql','redis','slack','hubspot','intercom','stripe','sentry'}
    assert not forbidden.intersection(item['id'] for item in items)
    base=os.getenv('LANGUAGE_PREVIEW_URL','http://127.0.0.1:8080')
    host=urlsplit(base).netloc
    by_id={item['id']:item for item in items}
    by_id['keycloak'].update(url='https://kc.example/realms/work',oauth_client_id='synthetic-buddy-client',ready=True)
    assert {'docmost','microsoft365','keycloak','notion','linear','context7','exa','firecrawl'}.issubset(by_id)
    async with async_playwright() as runtime:
        browser=await runtime.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
        context=await browser.new_context(viewport={'width':1440,'height':1050})
        await context.add_init_script("""
          localStorage.setItem('bob-ui-language','en');
          sessionStorage.setItem('buddy-approval-guide:fixture-user','seen');
          window.fixturePopupBlocked=false; window.fixturePopupUrls=[];
          const fixtureOriginalOpen=window.open;
          window.open=function(url,name,features){
            window.fixturePopupUrls.push(String(url));
            if(window.fixturePopupBlocked)return null;
            const child=fixtureOriginalOpen.call(window,url,name,features);
            window.fixtureLastPopup=child;return child;
          };
        """)
        async def intercept(route):
            nonlocal catalog_reads
            req=route.request;parsed=urlsplit(req.url);path=parsed.path
            if parsed.netloc==host and (path=='/' or path.startswith('/assets/') or path.endswith(('.svg','.png','.ico','.woff2'))):
                await route.continue_();return
            if parsed.netloc!=host:
                errors.append('Unexpected external request '+req.url)
                await route.abort();return
            calls.append((req.method,path,req.url))
            data=[]
            if path=='/auth/status':data={'user':{'username':'fixture-user','display_name':'Synthetic Catalogue User','is_admin':admin},'local_login_enabled':True,'keycloak_configured':False}
            elif path=='/personalization/tutorials':data={'disabled':True}
            elif path=='/sessions':data=[{'id':SID,'title':'Synthetic catalogue chat','updated_at':1}]
            elif path.endswith('/history'):data=[{'type':'request','prompt':'Synthetic catalogue UI question'},{'type':'delta','text':'Synthetic catalogue UI answer.'},{'type':'done'}]
            elif path=='/modes':data=[{'slug':'agent','name':'Agent','kind':'built-in'}]
            elif path=='/mcp-catalog':catalog_reads+=1;data=items
            elif path=='/admin/users':data={'users':[{'username':'fixture-user','display_name':'Synthetic Catalogue User','is_admin':True}]}
            elif path=='/auth/microsoft/status':data={'configured':True,'connected':by_id['microsoft365']['connected']}
            elif path.startswith('/mcp-oauth/') and path.endswith('/start') or path=='/auth/microsoft/login':
                await route.fulfill(status=200,content_type='text/html',body='<title>Synthetic OAuth popup</title><p>Synthetic provider login fixture. No credentials.</p>');return
            elif path.startswith('/mcp-catalog/'):
                identifier=path.split('/')[2]
                if path.endswith('/check'):data={'status':'working','message':'Synthetic connection test succeeded','tools':['synthetic_read_tool']}
                elif path.endswith('/connection') and req.method=='DELETE':by_id[identifier]['connected']=False;data=None
                else:
                    errors.append('Unexpected catalogue mutation '+path)
                    await route.fulfill(status=400,content_type='application/json',body=json.dumps({'detail':'Synthetic fixture refused mutation'}));return
            elif req.method not in {'GET','HEAD'}:
                errors.append('Unexpected mutation '+path)
                await route.fulfill(status=400,content_type='application/json',body=json.dumps({'detail':'Synthetic fixture refused mutation'}));return
            await route.fulfill(status=204 if data is None else 200,content_type='application/json',body='' if data is None else json.dumps(data))
        await context.route('**/*',intercept)
        page=await context.new_page();page.set_default_timeout(15000);page.on('pageerror',lambda error:errors.append(str(error)))
        await page.goto(base+'?conversation='+SID)
        await page.get_by_text('Synthetic catalogue UI answer.',exact=True).wait_for()
        sidebar=page.get_by_role('complementary',name='Workspace sidebar')
        assert await sidebar.locator('.mcp-card,.mcp-connection-card').count()==0
        assert await sidebar.get_by_text('MICROSOFT 365',exact=True).count()==1
        sidebar_text=await sidebar.inner_text()
        assert not any(text in sidebar_text for text in ['MCP Servers','MCP connections','Synthetic Tool'])
        async def open_catalog():
            await page.get_by_role('button',name='Settings menu',exact=True).click()
            await page.get_by_role('button',name='Add connections',exact=True).click()
            dialog=page.get_by_role('dialog',name='MCP server catalogue',exact=True)
            await dialog.get_by_role('heading',name='Docmost',exact=True).wait_for()
            return dialog
        dialog=await open_catalog()
        assert 'buddy-surface' in await dialog.get_attribute('class')
        card=lambda name:dialog.locator('.catalog-card').filter(has=page.get_by_role('heading',name=name,exact=True))
        assert await card('Docmost').get_by_role('button',name='Sign in to connect',exact=True).is_disabled()
        assert await card('Docmost').get_by_text('Administrator setup required',exact=True).is_visible()
        assert await dialog.get_by_role('button',name='Edit template & access',exact=True).count()==0
        assert await dialog.locator('input[type=password]').count()==0
        await dialog.get_by_label('Search catalog',exact=True).fill('Docmost')
        assert await dialog.locator('.catalog-card').count()==1
        await dialog.get_by_label('Search catalog',exact=True).fill('')
        await dialog.get_by_role('combobox').first.select_option('search')
        assert await card('Exa').count()==1 and await card('Docmost').count()==0
        await dialog.get_by_role('combobox').first.select_option('')
        assert 'data' not in await dialog.get_by_role('combobox').first.locator('option').all_text_contents()
        await page.evaluate('window.fixturePopupBlocked=true')
        await card('Linear').get_by_role('button',name='Sign in to connect',exact=True).click()
        await dialog.get_by_role('alert').filter(has_text='popup was blocked').wait_for()
        await page.evaluate('window.fixturePopupBlocked=false')
        async with page.expect_popup() as popup_event:
            await card('Linear').get_by_role('button',name='Sign in to connect',exact=True).click()
        popup=await popup_event.value;await popup.wait_for_load_state('domcontentloaded')
        assert popup.url.endswith('/mcp-oauth/linear/start')
        before=catalog_reads
        # Same-origin parent cannot impersonate the sign-in popup.
        await page.evaluate("window.postMessage({type:'buddy-mcp-oauth',template_id:'linear',status:'success'},location.origin)")
        await page.evaluate("window.dispatchEvent(new MessageEvent('message',{origin:'https://untrusted.invalid',source:window.fixtureLastPopup,data:{type:'buddy-mcp-oauth',template_id:'linear',status:'success'}}))")
        await popup.evaluate("opener.postMessage({type:'buddy-mcp-oauth',template_id:'wrong-template',status:'success'},location.origin)")
        await page.wait_for_timeout(150)
        assert catalog_reads==before
        assert await card('Linear').get_by_role('button',name='Waiting for sign-in…',exact=True).is_visible()
        by_id['linear']['connected']=True
        await popup.evaluate("opener.postMessage({type:'buddy-mcp-oauth',template_id:'linear',status:'success'},location.origin)")
        await card('Linear').get_by_role('button',name='Reconnect account',exact=True).wait_for()
        assert catalog_reads>before
        await popup.close()
        await card('Linear').get_by_role('button',name='Test',exact=True).click()
        await dialog.get_by_role('status').filter(has_text='Synthetic connection test succeeded').wait_for()
        await card('Linear').get_by_role('button',name='Disconnect',exact=True).click()
        await card('Linear').get_by_role('button',name='Sign in to connect',exact=True).wait_for()
        assert not any(path.endswith('/connect') for _,path,_ in calls)
        async with page.expect_popup() as microsoft_event:
            await card('Microsoft 365 / Office').get_by_role('button',name='Sign in to connect',exact=True).click()
        microsoft=await microsoft_event.value;await microsoft.wait_for_load_state('domcontentloaded')
        assert urlsplit(microsoft.url).path=='/auth/microsoft/login' and urlsplit(microsoft.url).query=='business=true'
        await microsoft.close()
        await page.wait_for_timeout(1100)
        async with page.expect_popup() as keycloak_event:
            await card('Keycloak').get_by_role('button',name='Sign in to connect',exact=True).click()
        keycloak=await keycloak_event.value;await keycloak.wait_for_load_state('domcontentloaded')
        assert keycloak.url.endswith('/mcp-oauth/keycloak/start')
        before=catalog_reads
        await keycloak.evaluate("opener.postMessage({type:'buddy-mcp-oauth',template_id:'keycloak',status:'untrusted-status'},location.origin)")
        await page.wait_for_timeout(100)
        assert catalog_reads==before
        by_id['keycloak']['connected']=True
        await keycloak.evaluate("opener.postMessage({type:'buddy-mcp-oauth',template_id:'keycloak',status:'success'},location.origin)")
        await card('Keycloak').get_by_role('button',name='Reconnect account',exact=True).wait_for()
        await keycloak.close()
        assert 'access_token' not in await dialog.inner_text() and 'refresh_token' not in await dialog.inner_text()
        # Admin sees configuration fields only; no real server/user mutation is made.
        admin=True
        await page.reload();await page.get_by_text('Synthetic catalogue UI answer.',exact=True).wait_for()
        dialog=await open_catalog()
        await card('Keycloak').get_by_role('button',name='Edit template & access',exact=True).click()
        await dialog.get_by_label('Keycloak realm issuer URL',exact=True).wait_for()
        await dialog.get_by_text('OAuth client registration (if provider requires it)',exact=True).click()
        await dialog.get_by_label('OAuth client ID',exact=True).wait_for()
        assert await dialog.get_by_label('OAuth client ID',exact=True).input_value()=='synthetic-buddy-client'
        assert await dialog.locator('input[type=password]').count()==0
        assert 'User records and write operations are not exposed' in await dialog.inner_text()
        await dialog.get_by_role('button',name='Cancel',exact=True).click()
        await card('Docmost').get_by_role('button',name='Edit template & access',exact=True).click()
        await dialog.get_by_label('Server URL',exact=True).wait_for()
        assert await dialog.get_by_label('Server URL',exact=True).input_value()==''
        await dialog.get_by_role('button',name='Cancel',exact=True).click()
        assert not errors,errors
        print('PASS: synthetic full-app expanded catalogue, filters, native login URL, source/origin popup protection, blocked popup, connection lifecycle, and admin configuration')
        await browser.close()

if __name__=='__main__':asyncio.run(main())
