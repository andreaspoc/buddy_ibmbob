"""Validated quiz results and permission-checked, fetched reading recommendations."""
import asyncio
import json
import os
import re
from urllib.parse import urlsplit


def _review_block(response):
    fence, body, offset = '', [], 0
    lines = response.split('\n')
    for index, content in enumerate(lines):
        line = content + ('\n' if index < len(lines) - 1 else '')
        offset += len(line)
        candidate = content.lstrip(' ')
        if len(content) - len(candidate) > 3:
            if fence:
                body.append(line)
            continue
        if not fence and candidate.startswith(('```', '~~~')):
            end = 3
            while end < len(candidate) and candidate[end] == candidate[0]:
                end += 1
            if candidate[end:].rstrip(' \t').lower() == 'bobquizresult' and line.endswith('\n'):
                fence = candidate[:end]
        elif fence and candidate.rstrip(' \t') == fence:
            return ''.join(body), offset - int(line.endswith('\n'))
        elif fence:
            body.append(line)
    return None


def _reading_candidates(text):
    """Read the search renderer's bold Markdown links without rescanning titles."""
    for line in text.split('\n'):
        opening, separator, offset = None, None, 0
        while offset < len(line):
            if opening is None:
                if line.startswith('**[', offset):
                    opening = offset
                    offset += 3
                    continue
            elif separator is None:
                if offset > opening + 3 and line.startswith(('](http://', '](https://'), offset):
                    separator = offset
                    offset += 2
                    continue
            elif line[offset].isspace() or line[offset] == ')':
                # Require a URL character beyond the recognized scheme delimiter.
                minimum = line.index('://', separator + 2, separator + 10) + 3
                if line.startswith(')**', offset) and offset > minimum:
                    yield line[opening + 3:separator], line[separator + 2:offset]
                    opening, separator = None, None
                    offset += 3
                    continue
                separator = None
            offset += 1


def _private_reading_topic(topic):
    return (any('@' in word[1:-1] for word in topic.split())
            or bool(re.search(r'https?://|\b\d{6,}\b|\.(?:pdf|docx|txt)\b', topic, re.I)))


def graded_result(response, context):
    data = json.loads(context.split('QUIZ SUBMITTED — END-ONLY GRADING:\n', 1)[1].split('\n', 1)[0])
    response = response.replace('\r\n', '\n')
    block = _review_block(response)
    if not block: raise ValueError('Bob did not return a complete quiz review. Submit again to retry grading.')
    try: value = json.loads(block[0])
    except ValueError as exc: raise ValueError('Bob returned an incomplete quiz review. Submit again to retry grading.') from exc
    items = value.get('questions') if isinstance(value,dict) else None
    if not isinstance(items,list) or len(items) != len(data['questions']): raise ValueError('Every submitted question must be reviewed')
    mapped = {}
    for item in items:
        if not isinstance(item,dict) or not isinstance(item.get('id'),str) or item['id'] in mapped: raise ValueError('Invalid question review')
        mapped[item['id']] = item
    if set(mapped) != {q['id'] for q in data['questions']}: raise ValueError('Quiz review does not match the submitted test')
    questions = []
    for q in data['questions']:
        item = mapped[q['id']]
        score = item.get('score')
        review_reason = item.get('review_reason','')
        if review_reason is None: review_reason = ''
        if not isinstance(review_reason,str) or len(review_reason)>2000: raise ValueError('Invalid review reason')
        if score is None:
            if not isinstance(review_reason,str) or not 1 <= len(review_reason.strip()) <= 2000: raise ValueError('Excluded questions need a review reason')
        elif type(score) not in {int,float} or score not in {0,0.5,1}: raise ValueError('Invalid quiz mark')
        mismatch = score is not None and q['type'] != 'text' and score != q['score']
        if score is not None and q['type'] != 'text': score = q['score']  # The model cannot rewrite fixed choice marks.
        explanation = item.get('explanation')
        if not isinstance(explanation,str) or not 1 <= len(explanation.strip()) <= 4000: raise ValueError('Every answer needs feedback')
        if mismatch: explanation = q['explanation']
        topic = item.get('study_topic','')
        if not isinstance(topic,str) or len(topic) > 160: raise ValueError('Invalid study topic')
        questions.append({'id':q['id'], 'question':q['question'], 'submitted_answer':q['submitted_answer'],
                          'correct_answer':q['correct_answer'], 'source':q.get('source'),
                          'score':score, 'explanation':explanation, 'review_reason':review_reason,
                          'study_topic':topic.strip(), 'resources':[]})
    eligible = sum(q['score'] is not None for q in questions)
    points = sum(q['score'] or 0 for q in questions)
    result = {'quiz_key':data['quiz_key'], 'title':data['title'], 'questions':questions,
              'total_points':points, 'eligible_questions':eligible,
              'percentage':round(points / eligible * 100, 1) if eligible else None,
              'reading_status':''}
    # Only validated follow-up cards after the results survive finalization.
    from app.clarification import clarification_questions
    followups = clarification_questions(response[block[1]:])
    return result, followups

def find_reading(topic):
    from app.mcp_search import brave_web_search
    from app.research_sources import fetch_source
    text = brave_web_search(topic + ' explanation official documentation university tutorial', count=5)
    if text.startswith('Error'): return [], False
    candidates = list(_reading_candidates(text))
    primary_roots=('ibm.com','microsoft.com','microsoft.net','amazon.com','aws.amazon.com','google.com','cloudflare.com','mozilla.org','python.org','oracle.com','apache.org','postgresql.org','ietf.org','w3.org','nist.gov','nih.gov','who.int')
    def priority(candidate):
        host=urlsplit(candidate[1]).hostname or ''
        primary=host.endswith(('.edu','.gov')) or host.startswith(('docs.','developer.','developers.','learn.')) or any(host==root or host.endswith('.'+root) for root in primary_roots)
        return 0 if primary else 1
    candidates.sort(key=priority)
    tokens = {word for word in re.findall(r'[a-z]{4,}',topic.lower()) if word not in {'what','which','between','difference','concept','understanding','explain','introduction','versus'}}
    resources = []
    for _, url in candidates[:4]:
        try:
            page = fetch_source(url)
            if tokens and not any(word in (page['title']+' '+page['text']).lower() for word in tokens): continue
            resources.append({'title':page['title'][:200], 'url':page['url'],
                              'why':'Focus on '+topic+'.', 'verified':True})
            if len(resources) == 2: break
        except Exception:
            continue  # A search snippet alone never becomes a recommended reading link.
    return resources, True

async def add_reading(result, username):
    missed = [q for q in result['questions'] if q['score'] is not None and q['score'] < 1]
    if not missed:
        result['reading_status'] = 'No missed concepts require additional reading.'
        return result
    from app.mcp_access import get_authorized_server
    try: allowed = await asyncio.to_thread(get_authorized_server, username, 'brave_search')
    except Exception: allowed = None
    if not allowed or not os.getenv('BRAVE_API_KEY','').strip():
        result['reading_status'] = 'Online reading search is unavailable for this account. Review the source sections in your feedback.'
        return result
    topics = list(dict.fromkeys(q['study_topic'] for q in missed if q['study_topic']))[:8]
    semaphore = asyncio.Semaphore(3)
    async def search(topic):
        if _private_reading_topic(topic): return topic, [], False
        async with semaphore:
            try:
                resources, success = await asyncio.to_thread(find_reading, topic)
                return topic, resources, success
            except Exception: return topic, [], False
    found = await asyncio.gather(*(search(topic) for topic in topics))
    by_topic = {topic:resources for topic,resources,_ in found}
    for q in missed: q['resources'] = by_topic.get(q['study_topic'],[])
    result['reading_status'] = ('Verified reading links are matched to your missed concepts.' if any(by_topic.values()) else
                                'No suitable online reading pages could be verified. Review the original source sections instead.')
    if any(not success for _,_,success in found) or len({q['study_topic'] for q in missed if q['study_topic']}) > 8:
        result['reading_status'] += ' Some reading searches could not be completed.'
    return result

async def finalize_review(response, context, username):
    result, followups = graded_result(response,context)
    result = await add_reading(result,username)
    if not followups:
        followups = [{'question':'What would you like to do after reviewing your results?', 'options':
                      ['Practice the missed concepts' if any(q['score'] is not None and q['score'] < 1 for q in result['questions']) else 'Try a more challenging test',
                       'Explain an answer in more detail', 'Create another test from the same source']}]
    text = '```bobquizresult\n'+json.dumps(result,ensure_ascii=False)+'\n```'
    if followups: text += '\n\n```bobquestion\n'+json.dumps(followups,ensure_ascii=False)+'\n```'
    return text
