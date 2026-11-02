"""Synthetic browser checks; run against a Vite server, no real learning data."""
import asyncio,json,os
from playwright.async_api import async_playwright
BASE=os.getenv('LEARNING_UI_URL','http://127.0.0.1:3032')
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox','--unsafely-treat-insecure-origin-as-secure='+BASE])
  page=await browser.new_page(viewport={'width':1440,'height':1000})
  state={'admin':True,'submitted':False,'published':False,'saved_access':None,'progress':[],'suggest_calls':0,'save_calls':0,'quiz':{'id':'quiz1','title':'Synthetic knowledge check','is_creator':True,'status':'published','version':2,'questions':[{'id':'q1','type':'dropdown','question':'Choose an option','options':['First','Second'],'answer':[0],'points':1},{'id':'q2','type':'text','question':'Explain your choice','answer':'A reference','points':2,'rubric':'Review explanation'}]}}
  def personal_report():
   return {'id':'sub1','username':'synthetic-learner','submitted_at':'2026-10-25T08:00:00Z','score':2,'max_score':3,'pending_manual':False,'quiz_version':2,'questions':state['quiz']['questions'],'answers':{'q1':[0],'q2':'My reason'},'grades':{'q1':{'score':1,'feedback':'First is correct.','method':'automatic'},'q2':{'score':1,'feedback':'Add more reasoning.','method':'ai'}}}
  grading_ready=asyncio.Event()
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  async def route(r):
   path=r.request.url.split('/api/learning',1)[1].split('?',1)[0];method=r.request.method
   data={}
   if path=='/me':data={'username':'synthetic-admin' if state['admin'] else 'synthetic-learner','is_admin':state['admin'],'can_create_quizzes':state['admin'] or state.get('teacher',False),'teacher_group':'/teacher'}
   elif path=='/folders':data={'items':[{'id':'folder1','name':'Learning resources'}]}
   elif path=='/folders/folder1/contents':data={'books':[{'id':'book1','title':'A thoughtful guide','author':'Synthetic author'}],'quizzes':[{'id':'quiz1','title':'Synthetic knowledge check','is_creator':True,'status':state['quiz']['status'],'version':2,'submitted':state['submitted'],'is_creator':state.get('creator',True)}]}
   elif path=='/users':data={'items':[{'username':'learner','display_name':'Learner'}],'directory_note':'Verified sign-in directory.'}
   elif path=='/groups':data={'items':[{'path':'/Training'}]}
   elif path=='/folders/folder1/members':
    if method=='PUT':state['saved_access']=r.request.post_data_json;data={'saved':True}
    else:data={'items':[],'groups':[]}
   elif path=='/books/book1/notes':data={'items':[]}
   elif path=='/books/book1':data={'id':'book1','title':'A thoughtful guide','author':'Synthetic author','chapters':[{'id':'chapter1','title':'Introduction'},{'id':'chapter2','title':'A new perspective'}],'progress':{'chapter_id':'chapter2','bookmarks':[]}}
   elif path.startswith('/books/book1/chapters/'):
    await r.fulfill(content_type='text/html',body='<html><body><h1>Synthetic chapter</h1><p>Reading content.</p></body></html>');return
   elif path=='/books/book1/search':data={'items':[{'chapter_id':'chapter1','title':'Introduction','excerpt':'A matching passage'}]}
   elif path=='/books/book1/quiz-draft':data={'id':'quiz1','title':'Synthetic knowledge check','is_creator':True,'status':'draft','version':2,'source_truncated':True}
   elif path=='/books/book1/progress':state['progress'].append(r.request.post_data_json);data={'saved':True}
   elif path=='/quizzes/quiz1':
    data={**state['quiz'],'submitted':state['submitted'],'is_creator':state.get('creator',True)}
    if not state['admin']:data['questions']=[{k:v for k,v in q.items() if k not in ['answer','rubric']} for q in data['questions']]
   elif path=='/quizzes/quiz1/results':data={'items':[{'id':'sub1','username':'synthetic-learner','submitted_at':'2026-10-25T08:00:00Z','score':1,'max_score':3,'pending_manual':True,'quiz_version':2,'questions':state['quiz']['questions'],'answers':{'q1':[0],'q2':'My reason'},'grades':{'q1':{'score':1,'feedback':'First is correct.'},'q2':{'score':None,'feedback':''}}}],'questions':state['quiz']['questions']}
   elif path=='/submissions/sub1/suggest-grades':
    state['suggest_calls']+=1
    if state['suggest_calls']==1:
     await r.fulfill(status=503,content_type='application/json',body='{"detail":"Synthetic grading unavailable"}');return
    data={'grades':{'q2':{'score':2,'feedback':'Suggested reasoning mark'}},'review_required':True}
   elif path=='/submissions/sub1/grade':state['save_calls']+=1;data={'saved':True}
   elif path=='/quizzes/quiz1/my-result':data=personal_report()
   elif path=='/quizzes/quiz1/submit':
    assert r.request.post_data_json['version']==2
    assert r.request.post_data_json['answers']=={'q1':[0],'q2':'My reason'}
    await grading_ready.wait()
    state['submitted']=True;data={'submitted':True,'result':personal_report()}
   else:raise Exception('Unexpected request '+path)
   await r.fulfill(content_type='application/json',body=json.dumps(data))
  await page.route('**/api/learning/**',route)
  await page.goto(BASE+'/learning.html')
  await page.get_by_role('heading',name='Learning resources',exact=True).wait_for()
  await page.get_by_role('button',name='♙ Manage access').click()
  await page.get_by_role('checkbox').first.check()
  await page.get_by_label('/Training',exact=True).check()
  await page.get_by_role('button',name='Save access',exact=True).click()
  await page.get_by_role('status').filter(has_text='Folder access updated.').wait_for()
  assert state['saved_access']=={'usernames':['learner'],'groups':['/Training']}
  await page.get_by_role('button',name='Read A thoughtful guide',exact=True).click()
  await page.locator('.learning-book-columns p').wait_for()
  assert 'Chapter 2 / 2' in await page.locator('.learning-page-badge').inner_text()
  await page.get_by_role('button',name='◇ Bookmark chapter',exact=True).click()
  await page.get_by_text('Reading position saved',exact=True).wait_for()
  assert state['progress'][-1]['bookmarks'][0]['chapter_id']=='chapter2'
  await page.get_by_label('Search this document').fill('matching')
  await page.get_by_role('button',name='Search',exact=True).click()
  await page.get_by_text('A matching passage',exact=True).wait_for()
  await page.get_by_role('button',name='← Library',exact=True).click()
  await page.get_by_role('tab',name='Quizzes 1').click()
  await page.get_by_role('button',name='Results',exact=True).click()
  await page.get_by_role('button',name='View answers',exact=True).click()
  assert state['suggest_calls']==0
  await page.get_by_label('Score (0–2)').fill('1')
  await page.get_by_label('Feedback for learner').fill('Manual draft')
  await page.get_by_role('button',name='Ask Buddy to grade written answers',exact=True).click()
  await page.get_by_role('alert').filter(has_text='Synthetic grading unavailable').wait_for()
  assert await page.get_by_label('Score (0–2)').input_value()=='1'
  assert await page.get_by_label('Feedback for learner').input_value()=='Manual draft'
  await page.get_by_role('button',name='Ask Buddy to grade written answers',exact=True).click()
  await page.get_by_role('status').filter(has_text='suggested marks are not saved').wait_for()
  assert await page.get_by_label('Score (0–2)').input_value()=='2'
  assert await page.get_by_label('Feedback for learner').input_value()=='Suggested reasoning mark'
  assert state['save_calls']==0
  await page.get_by_role('button',name='Save marking',exact=True).click()
  await page.get_by_role('button',name='Close dialog').click()
  await page.screenshot(path='/tmp/learning-admin.png',full_page=True)
  for width in [390,768,1440]:
   await page.set_viewport_size({'width':width,'height':900})
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
  state['quiz']['status']='closed'
  await page.goto(BASE+'/learning.html')
  await page.get_by_role('tab',name='Quizzes 1').click()
  await page.get_by_role('button',name='Approve new version',exact=True).wait_for()
  await page.get_by_role('button',name='Edit draft',exact=True).click()
  await page.get_by_label('Quiz title',exact=True).wait_for()
  await page.get_by_role('button',name='Cancel',exact=True).click()
  await page.get_by_role('tab',name='Library 1').click()
  await page.get_by_role('button',name='Draft quiz with Buddy',exact=True).click()
  await page.get_by_text('Buddy used bounded excerpts rather than the complete book.',exact=False).wait_for()
  await page.get_by_role('button',name='Cancel',exact=True).click()
  state['creator']=False
  await page.goto(BASE+'/learning.html')
  await page.get_by_role('tab',name='Quizzes 1').click()
  assert await page.get_by_role('button',name='Edit draft',exact=True).count()==0
  assert await page.get_by_role('button',name='Approve new version',exact=True).count()==0
  state['creator']=True
  state['admin']=False
  state['teacher']=True
  await page.goto(BASE+'/learning.html')
  await page.get_by_text('Teacher',exact=True).wait_for()
  assert await page.get_by_role('button',name='♙ Manage access').count()==0
  assert await page.get_by_role('button',name='+ Upload EPUB',exact=True).count()==0
  await page.get_by_role('button',name='Draft quiz with Buddy',exact=True).wait_for()
  await page.get_by_role('tab',name='Quizzes 1').click()
  await page.get_by_role('button',name='+ Create quiz',exact=True).wait_for()
  await page.get_by_role('button',name='Approve new version',exact=True).wait_for()
  assert await page.get_by_role('button',name='Results',exact=True).count()==0
  state['creator']=False
  state['teacher']=False
  state['quiz']['status']='published'
  state['admin']=False
  await page.goto(BASE+'/learning.html')
  await page.get_by_role('tab',name='Quizzes 1').click()
  assert await page.get_by_role('button',name='Results',exact=True).count()==0
  assert await page.get_by_role('button',name='♙ Manage access').count()==0
  await page.get_by_role('button',name='Start quiz →',exact=True).click()
  await page.get_by_label('Answer question 1').select_option('0')
  assert await page.locator('.learning-take-question').count()==1
  assert await page.get_by_label('Answer question 2').count()==0
  await page.get_by_role('button',name='Next →',exact=True).click()
  await page.get_by_label('Answer question 2').fill('My reason')
  await page.get_by_role('button',name='← Previous',exact=True).click()
  assert await page.get_by_label('Answer question 1').input_value()=='0'
  await page.get_by_role('button',name='Next →',exact=True).click()
  assert await page.get_by_label('Answer question 2').input_value()=='My reason'
  assert 'A reference' not in await page.locator('body').inner_text()
  await page.get_by_role('button',name='Review answers',exact=True).click()
  await page.get_by_role('heading',name='Ready to submit?',exact=True).wait_for()
  assert not state['submitted']
  quiz_url=page.url
  await page.get_by_role('button',name='Submit answers',exact=True).click()
  await page.get_by_role('heading',name='Preparing your results',exact=True).wait_for()
  assert page.url==quiz_url
  assert await page.get_by_role('button',name='Submit answers',exact=True).count()==0
  grading_ready.set()
  await page.get_by_role('region',name='Your learning report').wait_for()
  assert page.url==quiz_url
  await page.get_by_role('heading',name='A study plan based on your answers').wait_for()
  await page.locator('[aria-label="Answer outcomes"][data-bob-carbon-chart] svg').wait_for()
  assert '2 / 3 points' in await page.locator('body').inner_text()
  assert await page.locator('.learning-feedback-card').count()==1
  await page.get_by_role('button',name='Next answer →',exact=True).click()
  await page.get_by_text('A reference',exact=True).wait_for()
  assert 'Add more reasoning.' in await page.locator('body').inner_text()
  assert not errors,errors
  print('PASS: admin suggested grading errors preserve manual drafts; suggestions are not saved until Save marking. Also folder user/group grants, reading progress/bookmarks, sandbox reader, admin marking, one-question quiz navigation, preserved answers, final review, automatic results, Carbon charts and personal improvement feedback, responsive widths 390/768/1440.')
  await browser.close()
asyncio.run(main())
