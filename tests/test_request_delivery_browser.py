"""Actual chat UI receives synthetic lifecycle milestones without a page refresh."""
import asyncio
import os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1280,'height':900})
        errors=[]
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('REQUEST_DELIVERY_FIXTURE_URL','http://127.0.0.1:3006/tests/background.html'))
        await page.get_by_role('button',name='Alpha chat',exact=True).wait_for()
        await page.get_by_role('button',name='Alpha chat',exact=True).click()
        await page.evaluate('''() => {
            const original=window.fetch;
            window.fetch=(input,options={})=>{
                if(input==='/chat/stream')window.deliveryPayload={body:JSON.parse(options.body),headers:options.headers};
                return original(input,options);
            };
        }''')
        composer=page.get_by_role('textbox',name='Message',exact=True)
        await composer.fill('Synthetic delivery timeline fixture')
        await composer.press('Enter')
        await page.wait_for_function('window.testState.requests.length===1')
        await page.wait_for_function('!!document.querySelector(".message.user[data-correlation-id]")')
        await page.evaluate('''() => {
            const {body,headers}=window.deliveryPayload;
            if(headers['Idempotency-Key']!==body.correlation_id || body.idempotency_key!==body.correlation_id)throw Error('Submission key mismatch');
            window.emitDelivery=(state)=>{
                const request=window.testState.requests[0];
                request.controller.enqueue(request.encoder.encode(JSON.stringify({type:'delivery_state',state,timestamp:new Date().toISOString(),correlation_id:body.correlation_id,job_id:request.task.id,workspace_id:body.workspace_id,user_message_id:body.user_message_id,assistant_message_id:body.assistant_message_id})+'\\n'));
            };
        }''')
        user=page.locator('.message.user').last
        assistant=page.locator('.message.assistant').last
        for state in ('accepted','queued','running','streaming'):
            await page.evaluate('(state)=>window.emitDelivery(state)',state)
            await user.locator('.request-delivery-status').filter(has_text=state.capitalize()).wait_for()
        await assistant.locator('summary').filter(has_text='Request timeline').click()
        timeline=assistant.locator('.request-delivery-timeline')
        assert await timeline.locator('time').count()>=5
        assert await timeline.get_by_text('On this device',exact=False).count()==1
        await page.evaluate("window.emitDelivery('completed');window.completeResponse(0,'Synthetic completed response')")
        await user.locator('.request-delivery-status').filter(has_text='Completed').wait_for()
        await assistant.get_by_text('Synthetic completed response',exact=True).wait_for()
        assert await timeline.get_by_text('Completed',exact=True).count()==1
        assert not errors, errors
        await browser.close()
        print('PASS: actual chat delivery status and expandable timestamped timeline, stable routing and idempotency key, live completion')

asyncio.run(main())
