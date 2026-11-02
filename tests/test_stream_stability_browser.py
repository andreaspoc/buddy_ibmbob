"""Chat DOM/scroll regressions using the real components in a Vite preview.

Start Vite on port 3001; set STREAM_PREVIEW_URL when running elsewhere.
For Docker browsers allow host.docker.internal with Vite's
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS environment variable.
"""
import asyncio,json,os
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.getenv('CHROMIUM_PATH', '/usr/bin/chromium'),args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':900})
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  await page.route('**/workflows/capabilities',lambda route:route.fulfill(json={'web_search':False}))
  await page.goto(os.getenv('STREAM_PREVIEW_URL', 'http://host.docker.internal:3001/tests/streaming.html'))
  await page.wait_for_function("typeof window.renderAnswer === 'function'")
  result=await page.evaluate('''async () => {
   const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   const base='Intro.\\n\\n1. First\\n2. Second';
   const md=document.querySelector('.markdown-body');
   const intro=md.querySelector('p'), list=md.querySelector('ol'), first=list.firstElementChild;
   window.renderAnswer(base+' item\\n3. Third',true); await frame();
   if(md.querySelector('p')!==intro || md.querySelector('ol')!==list || list.firstElementChild!==first) throw Error('List nodes replaced');
   window.renderAnswer(base+' item\\n3. Third',false); await frame();
   if(md.querySelector('p')!==intro || md.querySelector('ol')!==list || list.firstElementChild!==first) throw Error('Finish rebuilt answer');
   const question='```bobquestion\\n'+JSON.stringify({question:'Which direction?',options:['Summarize','Explain']})+'\\n```';
   for(let i=1;i<=question.length;i++) { window.renderAnswer(base+' item\\n3. Third\\n\\n'+question.slice(0,i),true); if(md.textContent.includes('bobquestion')||md.textContent.includes('options'))throw Error('Partial question leaked at '+i); }
   window.renderAnswer(base+' item\\n3. Third\\n\\n'+question,false); await frame();
   if(!document.querySelector('.clarification-card'))throw Error('Final question card missing');
   const long='Intro.\\n\\n'+Array.from({length:50},(_,i)=>(i+1)+'. Follow-up detail '+i).join('\\n');
   window.renderAnswer(long,true); await frame();
   const scroller=document.querySelector('.conversation');
   if(scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop>2)throw Error('Not following stream');
   window.renderAnswer(long+'\\n\\n'+question,false); await frame();
   if(scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop>2)throw Error('Final card jump');
   const formTop=scroller.scrollTop;
   const custom=document.querySelector('.clarification-custom-tile input');
   custom.focus({preventScroll:true}); custom.click(); await frame();
   if(Math.abs(scroller.scrollTop-formTop)>2)throw Error('Form interaction moved the viewport');
   return {listNodesPreserved:true,finishNodesPreserved:true,questionPrefixesChecked:question.length,finalCardVisible:true,finalScrollGap:scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop};
  }''')
  await page.mouse.move(500,350)
  await page.mouse.wheel(0,-400)
  await page.wait_for_timeout(100)
  before=await page.locator('.conversation').evaluate('(e)=>e.scrollTop')
  await page.evaluate("window.renderAnswer('Intro.\\n\\n'+Array.from({length:60},(_,i)=>(i+1)+'. Follow-up detail '+i).join('\\n'),true)")
  await page.wait_for_timeout(100)
  after=await page.locator('.conversation').evaluate('(e)=>e.scrollTop')
  if abs(before-after)>2:raise AssertionError(f'Reader scroll stolen: {before} -> {after}')
  result['manualScrollPreserved']=True
  if errors:raise AssertionError(errors)
  print(json.dumps(result))
  await browser.close()
asyncio.run(main())
