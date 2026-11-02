"""Real chat quiz UI, hidden solutions, keyboard/input, draft and submission checks."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

QUIZ={'title':'Synthetic source test','questions':[
 {'id':'q1','type':'single','question':'Choose an item from the synthetic source.', 'options':['A source option with long wording '*5,'Another source option'], 'answer':[1], 'explanation':'HIDDEN EXPLANATION'},
 {'id':'q2','type':'multiple','question':'Select all matching items.', 'options':['First','Second','Third'], 'answer':[0,2], 'explanation':'HIDDEN EXPLANATION'},
 {'id':'q3','type':'text','question':'Explain the source concept.', 'answer':'HIDDEN REFERENCE ANSWER', 'rubric':'HIDDEN RUBRIC', 'explanation':'HIDDEN EXPLANATION'}
]}
CONTENT='Complete the test.\n\n```bobquiz\n'+json.dumps(QUIZ)+'\n```'

async def main():
 async with async_playwright() as runtime:
  browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1280,'height':1000})
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  await page.route('**/workflows/capabilities',lambda route:route.fulfill(json={'web_search':False}))
  url=os.getenv('QUIZ_FIXTURE_URL','http://127.0.0.1:3002/quiz_fixture.html')
  await page.goto(url)
  await page.wait_for_function('typeof window.renderQuiz === "function"')
  await page.evaluate('(text)=>renderQuiz(text,true)',CONTENT)
  assert await page.locator('.quiz-card').count()==0
  assert 'HIDDEN' not in await page.locator('.conversation').inner_text()
  await page.evaluate('(text)=>renderQuiz(text,false)',CONTENT)
  card=page.locator('.quiz-card')
  await card.wait_for()
  assert await page.locator('.conversation').evaluate('node=>node.scrollTop') < 2, 'New quiz jumped to its last questions'
  assert 'HIDDEN' not in await page.locator('.conversation').inner_text()
  assert await card.get_by_role('button',name='Submit test').is_disabled()
  for width in [1280,390,320]:
   await page.set_viewport_size({'width':width,'height':1000})
   assert await card.evaluate('node=>node.scrollWidth<=node.clientWidth+1'),f'Quiz overflow at {width}'
   for option in await card.locator('.quiz-options label').all():
    assert await option.evaluate('node=>node.scrollWidth<=node.clientWidth+1'),f'Option overflow at {width}'
  radio=card.get_by_role('radio').nth(1)
  await radio.focus()
  await page.keyboard.press('Space')
  assert await radio.is_checked()
  await card.get_by_role('checkbox').nth(0).check()
  await card.get_by_role('checkbox').nth(2).check()
  await card.get_by_role('textbox').fill('My answer from the document.')
  assert await card.get_by_role('button',name='Submit test').is_enabled()
  assert 'HIDDEN' not in await page.locator('.conversation').inner_text()
  await page.reload()
  await page.wait_for_function('typeof window.renderQuiz === "function"')
  await page.evaluate('(text)=>renderQuiz(text,false)',CONTENT)
  await card.wait_for()
  assert await card.get_by_role('radio').nth(1).is_checked()
  assert await card.get_by_role('textbox').input_value()=='My answer from the document.'
  await card.evaluate('node=>{node.requestSubmit();node.requestSubmit();}')
  await page.wait_for_function('window.submissionCount===1')
  assert await page.evaluate('window.submissionCount')==1
  prompt=await page.evaluate('window.submittedPrompt')
  assert 'HIDDEN' not in prompt
  answers=json.loads(prompt.split('Answers:\n')[1])
  assert answers=={'q1':[1],'q2':[0,2],'q3':'My answer from the document.'}
  assert await card.get_by_role('button',name='Submit test').count()==0
  assert await card.get_by_role('textbox').is_disabled()
  assert 'HIDDEN' not in await page.locator('.conversation').inner_text()
  await page.evaluate('failGrading()')
  assert await card.get_by_role('textbox').input_value()=='My answer from the document.'
  assert await card.get_by_role('button',name='Submit test').is_enabled()
  await card.evaluate('node=>node.requestSubmit()')
  await page.wait_for_function('window.submissionCount===2')
  assert not errors,errors
  await browser.close()
  print('PASS: real chat quiz, no streaming/key leakage, vertical desktop/mobile layout, keyboard/input, saved drafts, end-only submission and retry after grading failure')
asyncio.run(main())
