import { Toolbar } from './Toolbar';
import { useEffect, useId, useState } from 'react';
import { t } from '../lib/i18n';
import type { QuizResult } from '../lib/quiz';

export function QuizResultsCard({result,sessionId,disabled,onPractice}:{result:QuizResult;sessionId?:string;disabled:boolean;onPractice:(prompt:string)=>void}) {
  const [filter,setFilter]=useState('all');
  const resultId=useId();
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(result.questions.filter(q=>q.score!==1).map(q=>q.id)));
  const storageKey=`buddy-quiz-reading:${sessionId || 'new'}:${result.quiz_key}`;
  const [read,setRead]=useState<string[]>(()=>{try {const value=JSON.parse(localStorage.getItem(storageKey)||'[]');return Array.isArray(value)?value.filter(item=>typeof item==='string'):[];}catch{return [];}});
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(read));}catch{/* Optional reading checklist. */}},[read,storageKey]);
  const counts={correct:result.questions.filter(q=>q.score===1).length,partial:result.questions.filter(q=>q.score===0.5).length,wrong:result.questions.filter(q=>q.score===0).length,review:result.questions.filter(q=>q.score===null).length};
  const missed=result.questions.filter(q=>q.score!==null && q.score<1);
  const resources=[...new Set(missed.flatMap(q=>q.resources.map(resource=>resource.url)))];
  const shown=result.questions.filter(q=>filter==='all' || (filter==='missed' && q.score!==null && q.score<1) || (filter==='correct' && q.score===1) || (filter==='review' && q.score===null));
  const answer=(value:string|string[])=>Array.isArray(value)?value.join('; '):value;
  return <section className="quiz-results" aria-label={t('Test results')}>
    <Toolbar className="quiz-header"><h3>{result.title} · {t('Results')}</h3><strong className="quiz-score">{result.percentage===null?t('Needs review'):`${result.total_points}/${result.eligible_questions} · ${result.percentage}%`}</strong></Toolbar>
    <div className="quiz-score-track" aria-hidden="true"><span style={{width:`${result.percentage || 0}%`}} /></div>
    <p className="quiz-instructions">{t('{0} correct · {1} partially correct · {2} incorrect · {3} need review',[String(counts.correct),String(counts.partial),String(counts.wrong),String(counts.review)])}</p>
    <Toolbar className="quiz-review-toolbar" role="group" aria-label={t('Filter test results')}>
      {[['all','All questions'],['missed','Missed questions'],['correct','Correct answers'],['review','Needs review']].map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{t(label)}</button>)}
      <button type="button" onClick={()=>setExpanded(new Set(shown.map(q=>q.id)))}>{t('Expand explanations')}</button>
      <button type="button" onClick={()=>setExpanded(new Set())}>{t('Collapse explanations')}</button>
    </Toolbar>
    <p className="quiz-reading-status">{t(result.reading_status)}</p>
    {resources.length>0 && <p className="quiz-reading-status">{t('{0} of {1} resources marked as read',[String(resources.filter(url=>read.includes(url)).length),String(resources.length)])}</p>}
    <div className="quiz-review-questions">
      {shown.map(q=><article key={q.id} className={`quiz-review-question ${q.score===1?'is-correct':q.score===null?'needs-review':'is-missed'}`}>
        <div className="quiz-review-heading"><strong>{result.questions.indexOf(q)+1}. {q.question}</strong><span>{q.score===1?t('Correct'):q.score===0.5?t('Partially correct'):q.score===0?t('Incorrect'):t('Needs review')}</span></div>
        <p><strong>{t('Your answer:')}</strong> {answer(q.submitted_answer)}</p>
        <button type="button" className="quiz-explanation-toggle" aria-expanded={expanded.has(q.id)} aria-controls={`${resultId}-${q.id}`} onClick={()=>setExpanded(previous=>{const next=new Set(previous);next.has(q.id)?next.delete(q.id):next.add(q.id);return next;})}>{expanded.has(q.id)?t('Hide explanation'):t('Show correct answer and explanation')}</button>
        <div id={`${resultId}-${q.id}`} hidden={!expanded.has(q.id)}>
          <p><strong>{q.score===null?t('Reference answer:'):t('Correct answer:')}</strong> {answer(q.correct_answer)}</p><p>{q.explanation}</p>
          {q.review_reason && <p className="quiz-question-note">{q.review_reason}</p>}
          {q.source && <p className="quiz-question-note"><strong>{t('Source:')}</strong> {q.source}</p>}
          {q.resources.length>0 && <div className="quiz-reading-list"><strong>{t('Read to improve')}</strong>{q.resources.map(resource=><div key={resource.url} className="quiz-reading-item"><a href={resource.url} target="_blank" rel="noopener noreferrer">{resource.title} ↗</a><p>{resource.why}</p><label><input type="checkbox" checked={read.includes(resource.url)} onChange={()=>setRead(previous=>previous.includes(resource.url)?previous.filter(url=>url!==resource.url):[...previous,resource.url])} /> {t('Mark as read')}</label></div>)}</div>}
          {q.score!==null && q.score<1 && !q.resources.length && <p className="quiz-question-note">{t('No verified online reading resource was available for this concept. Review the source explanation above.')}</p>}
        </div>
      </article>)}
      {!shown.length && <p>{t('No questions in this category.')}</p>}
    </div>
    {missed.length>0 && <div className="quiz-actions"><span>{t('Build confidence with targeted practice.')}</span><button type="button" disabled={disabled} onClick={()=>onPractice('Create a new interactive practice quiz on these missed concepts from the same original source: '+[...new Set(missed.map(q=>q.study_topic || q.question))].join('; ')+'. Use a bobquiz form. Show answers and explanations only after the whole test is submitted; do not add follow-up forms before results.')}>{t('Practice missed topics')}</button></div>}
  </section>;
}
