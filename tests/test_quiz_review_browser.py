"""Clarify before quiz creation, suppress interruptions during tests, and show graded review."""
import asyncio
import json
import os
from playwright.async_api import async_playwright

QUIZ={'title':'Synthetic interactive test','questions':[
 {'id':'q1','type':'single','question':'Choose the synthetic source item.','options':['First','Second'],'answer':[1],'explanation':'PRIVATE KEY EXPLANATION'},
 {'id':'q2','type':'multiple','question':'Choose all source items.','options':['A','B','C'],'answer':[0,2],'explanation':'PRIVATE KEY EXPLANATION'},
 {'id':'q3','type':'text','question':'Explain the synthetic concept.','answer':'PRIVATE REFERENCE','rubric':'PRIVATE RUBRIC','explanation':'PRIVATE KEY EXPLANATION'}
]}
FOLLOW='\n\n```bobquestion\n'+json.dumps({'question':'What would you like to do next?','options':['Practice the missed concepts','Create another test']})+'\n```'
CONTENT='```bobquiz\n'+json.dumps(QUIZ)+'\n```'+FOLLOW

async def main():
 async with async_playwright() as runtime:
  browser=await runtime.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page(viewport={'width':1100,'height':1000},reduced_motion='reduce')
  errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  await page.route('**/workflows/capabilities',lambda route:route.fulfill(json={'web_search':False}))
  await page.goto(os.getenv('QUIZ_FIXTURE_URL','http://127.0.0.1:3002/quiz_fixture.html'))
  await page.wait_for_function('typeof window.renderQuiz === "function"')
  brief = '```bobquestion\n'+json.dumps({'question':'What topic and purpose should this test cover?','options':['Staff training','Personal study'],'context':'Specify the subject in your own answer.'})+'\n```'
  for request in ['Create an interactive quiz on my uploaded document.', 'Need a qa mutliple choice test']:
   await page.evaluate('(args)=>renderQuiz(args.brief,false,args.request)', {'brief':brief,'request':request})
   assert await page.locator('.clarification-card').count()==1,'Missing quiz brief clarification was hidden'
   assert await page.locator('.quiz-card').count()==0,'Quiz created before clarification'
   assert await page.locator('.clarification-title').evaluate("node => getComputedStyle(node).color === 'rgb(255, 255, 255)' && getComputedStyle(node).marginTop === '0px'"), 'Chat markdown styles overrode the form header'
   await page.evaluate('(args)=>renderQuiz(args.brief,true,args.request)', {'brief':brief,'request':request})
   assert await page.locator('.clarification-card').count()==0,'Partial streaming clarification was displayed'
  await page.evaluate('(text)=>renderQuiz(text)',CONTENT)
  card=page.locator('.quiz-card')
  await card.wait_for()
  assert await page.locator('.clarification-card').count()==0,'Creation showed a follow-up form'
  assert 'PRIVATE' not in await page.locator('.conversation').inner_text()
  await card.get_by_role('button',name='Mark for review',exact=True).first.click()
  await card.get_by_role('button',name='Marked for review',exact=True).click()
  assert await card.locator('fieldset').count()==1
  await card.get_by_role('button',name='All questions',exact=True).click()
  await card.get_by_role('button',name='Unanswered',exact=True).click()
  await card.get_by_role('radio').first.check()
  assert await card.locator('fieldset').count()==1,'Answering hid the active question'
  assert QUIZ['questions'][0]['question'] in await card.locator('fieldset').inner_text()
  await card.get_by_role('button',name='Next',exact=True).click()
  await card.get_by_role('checkbox').nth(0).check()
  assert await card.get_by_role('checkbox').count()==3,'Multiple-select choices disappeared mid-answer'
  await card.get_by_role('checkbox').nth(2).check()
  await card.get_by_role('button',name='Next',exact=True).click()
  await card.get_by_role('textbox').fill('A partially correct synthetic answer')
  assert await card.get_by_role('progressbar',name='Test progress').get_attribute('value')=='3'
  await card.evaluate('node=>node.requestSubmit()')
  await page.wait_for_function('window.submissionCount===1')
  key=(await page.evaluate('window.submittedPrompt')).split('\n')[0].split(': ')[1]
  reading={'title':'Explicit synthetic reading fixture','url':'https://example.org/synthetic-learning','why':'Synthetic learning reference for browser checks.','verified':True}
  result={'quiz_key':key,'title':QUIZ['title'],'questions':[
   {'id':'q1','question':QUIZ['questions'][0]['question'],'submitted_answer':['First'],'correct_answer':['Second'],'score':0,'explanation':'Your selection differed from the synthetic source.','study_topic':'Synthetic concept','source':'Synthetic.txt, section A','resources':[reading]},
   {'id':'q2','question':QUIZ['questions'][1]['question'],'submitted_answer':['A','C'],'correct_answer':['A','C'],'score':1,'explanation':'Both synthetic items match.','study_topic':'','resources':[]},
   {'id':'q3','question':QUIZ['questions'][2]['question'],'submitted_answer':'Partial synthetic answer','correct_answer':'Full synthetic reference answer','score':0.5,'explanation':'The answer omitted an essential synthetic concept.','study_topic':'Synthetic concept','resources':[reading]}
  ],'total_points':1.5,'eligible_questions':3,'percentage':50,'reading_status':'Synthetic verified-reading fixture status.'}
  review='```bobquizresult\n'+json.dumps(result)+'\n```'+FOLLOW
  await page.evaluate('(text)=>renderReview(text,true)',review)
  assert await page.locator('.quiz-results').count()==0
  assert await page.locator('.clarification-card').count()==0
  assert 'Full synthetic reference answer' not in await page.locator('.conversation').inner_text()
  await page.evaluate('(text)=>renderReview(text,false)',review)
  results=page.locator('.quiz-results')
  await results.wait_for()
  await card.get_by_role('button',name='View results').click()
  assert '1.5/3 · 50%' in await results.inner_text()
  followup=page.locator('.clarification-card')
  assert await followup.count()==1
  assert await followup.evaluate('(node)=>Boolean(node.previousElementSibling?.classList.contains("quiz-results"))'),'Follow-up precedes results'
  await results.get_by_role('button',name='Missed questions',exact=True).click()
  assert await results.locator('.quiz-review-question').count()==2
  await results.get_by_role('button',name='Collapse explanations',exact=True).click()
  assert not await results.get_by_text('Your selection differed from the synthetic source.').is_visible()
  await results.get_by_role('button',name='Expand explanations',exact=True).click()
  await results.get_by_role('checkbox',name='Mark as read',exact=True).first.check()
  assert '1 of 1 resources marked as read' in await results.inner_text()
  assert await results.get_by_role('link',name='Explicit synthetic reading fixture',exact=False).first.get_attribute('href')==reading['url']
  for width in [1100,390,320]:
   await page.set_viewport_size({'width':width,'height':1000})
   assert await results.evaluate('node=>node.scrollWidth<=node.clientWidth+1'),f'Review overflow at {width}'
  await results.get_by_role('button',name='Practice missed topics',exact=True).click()
  await page.wait_for_function('window.submissionCount===2')
  practice=await page.evaluate('window.submittedPrompt')
  assert 'Synthetic concept' in practice and 'Use a bobquiz form' in practice
  assert not errors,errors
  await browser.close()
  print('PASS: pre-quiz clarification, in-quiz follow-up suppression, progress/navigation/flags, stable multi-select filtering, end-only results, review filters, explanations, reading checklist, practice and mobile layout')
asyncio.run(main())
