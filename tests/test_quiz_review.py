import json
import os
import unittest
from unittest.mock import patch
from app.quiz import quiz_key, submission_context, is_quiz_creation
from app.quiz_review import graded_result, find_reading, finalize_review

RAW=json.dumps({'title':'Synthetic source test','questions':[
 {'id':'q1','type':'single','question':'Synthetic choice?', 'options':['A','B'], 'answer':[1], 'explanation':'The source says B.', 'source':'Synthetic.txt, section A'},
 {'id':'q2','type':'text','question':'Explain the synthetic concept.', 'answer':'Authentication verifies identity.', 'rubric':'Identity is essential.', 'explanation':'Identity differs from permissions.'}
]})
HISTORY=[{'type':'request'}, {'type':'delta','text':'```bobquiz\n'+RAW+'\n```'}]
CONTEXT=submission_context('Quiz submission: '+quiz_key(RAW)+'\nAnswers:\n'+json.dumps({'q1':[0],'q2':'My private learner response'}),HISTORY)
def response(score=0.5):
 return '```bobquizresult\n'+json.dumps({'questions':[
  {'id':'q1','score':1,'explanation':'Synthetic model tried to override the fixed mark.','study_topic':'authentication versus authorization','resources':[{'url':'https://invented.invalid'}]},
  {'id':'q2','score':score,'explanation':'Your answer needs to identify identity verification.','study_topic':'authentication versus authorization', 'review_reason':'Synthetic ambiguous source' if score is None else ''}
 ]})+'\n```'

class QuizReviewTests(unittest.IsolatedAsyncioTestCase):
 def test_fixed_marks_total_and_model_urls_discarded(self):
  result,_=graded_result(response(),CONTEXT)
  self.assertEqual(result['questions'][0]['score'],0)
  self.assertEqual(result['questions'][0]['explanation'],'The source says B.')
  self.assertEqual(result['total_points'],0.5)
  self.assertEqual(result['percentage'],25)
  self.assertEqual(result['questions'][0]['resources'],[])
  reviewed,_=graded_result(response(None),CONTEXT)
  self.assertEqual(reviewed['eligible_questions'],1)
  self.assertIsNone(reviewed['questions'][1]['score'])
  with self.assertRaises(ValueError): graded_result(response(True),CONTEXT)
  with self.assertRaises(ValueError): graded_result('Incomplete review',CONTEXT)

 def test_creation_phase(self):
  for text in ['Create a quiz on my document','Create a test on the uploaded document','quiz me','Use a bobquiz form.']:
   self.assertTrue(is_quiz_creation(text),text)
  self.assertFalse(is_quiz_creation('Quiz submission: '+quiz_key(RAW)))
  self.assertFalse(is_quiz_creation('Write software unit tests'))

 def test_readings_require_fetched_relevant_pages(self):
  search='1. **[Synthetic irrelevant](https://example.org/irrelevant)**\n2. **[Synthetic primary source](https://example.org/auth)**'
  def fetch(url):
   return {'title':'Synthetic source','url':url,'text':'Cooking instructions' if url.endswith('irrelevant') else 'Authentication verifies identity and authorization governs permissions.'}
  with patch('app.mcp_search.brave_web_search',return_value=search),patch('app.research_sources.fetch_source',side_effect=fetch):
   links,ok=find_reading('authentication versus authorization')
   self.assertTrue(ok)
   self.assertEqual([link['url'] for link in links],['https://example.org/auth'])
   self.assertTrue(links[0]['verified'])
  with patch('app.mcp_search.brave_web_search',return_value='Error: unavailable'):
   self.assertEqual(find_reading('authentication'),([],False))

 async def test_permission_checked_deduplicated_recommendations_and_end_followups(self):
  link={'title':'Synthetic reading','url':'https://example.org/auth','why':'Synthetic concept reference','verified':True}
  with patch.dict(os.environ,{'BRAVE_API_KEY':'synthetic-test-key'}),patch('app.mcp_access.get_authorized_server',return_value={'command':'synthetic-search'}),patch('app.quiz_review.find_reading',return_value=([link],True)) as search:
   text=await finalize_review(response(),CONTEXT,'synthetic-owner')
   self.assertEqual(search.call_count,1)
   self.assertEqual(search.call_args.args[0],'authentication versus authorization')
   self.assertNotIn('My private learner response',str(search.call_args))
   self.assertIn('https://example.org/auth',text)
   self.assertLess(text.index('bobquizresult'),text.index('bobquestion'))
  with patch.dict(os.environ,{'BRAVE_API_KEY':'synthetic-test-key'}),patch('app.mcp_access.get_authorized_server',return_value=None),patch('app.quiz_review.find_reading') as search:
   text=await finalize_review(response(),CONTEXT,'synthetic-owner')
   search.assert_not_called()
   self.assertIn('unavailable for this account',text)
   self.assertNotIn('https://invented.invalid',text)

if __name__=='__main__': unittest.main()
