import { Toolbar } from './Toolbar';
import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { quizSubmission, type Quiz, type QuizAnswers } from '../lib/quiz';

export function QuizCard({ quiz, sessionId, disabled, submittedAnswers, onSubmit, onViewResults }: {
  quiz: Quiz; sessionId?: string; disabled: boolean; submittedAnswers?: QuizAnswers; onSubmit: (prompt: string) => void; onViewResults?:()=>void;
}) {
  const storageKey = `buddy-quiz:${sessionId || 'new'}:${quiz.key}`;
  const [draft, setDraft] = useState<QuizAnswers>(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const [pending, setPending] = useState(false);
  const sent = useRef(false);
  const id = useId();
  const [view,setView]=useState<'all'|'unanswered'|'flagged'>('all');
  const [filteredIds,setFilteredIds]=useState<string[]|null>(null);
  const [flagged,setFlagged]=useState<string[]>(()=>{try {const value=JSON.parse(localStorage.getItem(storageKey+':flags')||'[]');return Array.isArray(value)?value.filter(item=>typeof item==='string'):[];}catch{return [];}});
  const [questionIndex, setQuestionIndex] = useState(0);
  const submitted = Boolean(submittedAnswers);
  const answers = submittedAnswers || draft;
  const hasAnswer = (question: Quiz['questions'][number]) => {
    const value = answers[question.id];
    return question.type === 'text' ? typeof value === 'string' && Boolean(value.trim()) && value.length <= 4000
      : Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every(index => Number.isInteger(index) && index >= 0 && index < (question.options?.length || 0)) && (question.type !== 'single' || value.length === 1);
  };
  const count = quiz.questions.filter(hasAnswer).length;
  const shown=quiz.questions.filter(question=>filteredIds===null || filteredIds.includes(question.id));
  useEffect(()=>{try {localStorage.setItem(storageKey+':flags',JSON.stringify(flagged));}catch{/* Optional review flags. */}},[flagged,storageKey]);
  const currentQuestion = shown[Math.min(questionIndex, Math.max(0, shown.length - 1))];
  const lastQuestion = questionIndex >= shown.length - 1;
  const tooLong = quizSubmission(quiz.key, draft).length > 20000;
  useEffect(() => {
    if (!disabled && !submitted) { sent.current = false; setPending(false); }
  }, [disabled, submitted]);
  useEffect(() => {
    if (submitted) return;
    try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Draft saving is optional. */ }
  }, [draft, storageKey, submitted]);
  useEffect(() => {
    if (!pending || submitted) return;
    const timer = setTimeout(() => { sent.current = false; setPending(false); }, 5000);
    return () => clearTimeout(timer);
  }, [pending, submitted]);
  const locked = disabled || submitted || pending;
  return <form className="quiz-card" aria-label={quiz.title} onSubmit={event => {
    event.preventDefault();
    if (locked || sent.current) return;
    if (!lastQuestion) {
      if (currentQuestion && hasAnswer(currentQuestion)) setQuestionIndex(previous => previous + 1);
      return;
    }
    if (tooLong || count !== quiz.questions.length) return;
    sent.current = true; setPending(true);
    onSubmit(quizSubmission(quiz.key, draft));
  }}>
    <Toolbar className="quiz-header"><h3>{quiz.title}</h3><span>{submitted ? t('Submitted') : t('{0} of {1} answered', [String(count), String(quiz.questions.length)])}</span></Toolbar>
    <p className="quiz-instructions">{submitted
      ? t('Your answers have been submitted. Bob’s results and explanations appear below when grading finishes.')
      : t('Answer each question, then select Next. Submit the completed test at the end to see your score and explanations.')}</p>
    {Boolean(quiz.learning_objectives?.length) && <details className="quiz-objectives"><summary>{t('Learning objectives')}</summary><ul>{quiz.learning_objectives?.map((objective, index) => <li key={index}>{objective}</li>)}</ul></details>}
    {Boolean(quiz.sections?.length) && <Toolbar as="nav" className="quiz-section-nav" aria-label={t('Quiz sections')}>{quiz.sections?.map(section => {
      const questions = quiz.questions.filter(q => q.section_id === section.id);
      const active = currentQuestion?.section_id === section.id;
      return <button key={section.id} type="button" disabled={!questions.length} aria-current={active ? 'step' : undefined} onClick={() => { setView('all'); setFilteredIds(null); setQuestionIndex(quiz.questions.findIndex(q => q.section_id === section.id)); }}>{section.title} · {questions.filter(hasAnswer).length}/{questions.length}</button>;
    })}</Toolbar>}
    <progress className="quiz-progress" value={count} max={quiz.questions.length} aria-label={t('Test progress')} />
    <div className="quiz-question-nav" role="group" aria-label={t('Question navigator')}>{quiz.questions.map((question,index)=><button key={question.id} type="button" className={hasAnswer(question)?'is-answered':''} aria-label={t('Go to question {0}',[String(index+1)])} aria-current={currentQuestion?.id===question.id ? 'step' : undefined} onClick={()=>{setView('all');setFilteredIds(null);setQuestionIndex(index);}}>{index+1}{flagged.includes(question.id)?' ⚑':''}</button>)}</div>
    <Toolbar className="quiz-review-toolbar" role="group" aria-label={t('Filter test questions')}>{[['all','All questions'],['unanswered','Unanswered'],['flagged','Marked for review']].map(([value,label])=><button key={value} type="button" aria-pressed={view===value} onClick={()=>{setView(value as typeof view);setQuestionIndex(0);setFilteredIds(value==='all'?null:quiz.questions.filter(q=>value==='unanswered'?!hasAnswer(q):flagged.includes(q.id)).map(q=>q.id));}}>{t(label)}</button>)}</Toolbar>
    <div className="quiz-questions">
      {(currentQuestion ? [currentQuestion] : []).map(question => <fieldset key={question.id} disabled={locked}>
        <legend><span className="clarification-step-num">{quiz.questions.indexOf(question) + 1}</span> {question.question}</legend>
        {(question.section_id || question.topic || question.difficulty) && <p className="quiz-question-note">{[quiz.sections?.find(section => section.id === question.section_id)?.title, question.topic, question.difficulty ? t({easy: 'Easy', medium: 'Medium', hard: 'Hard'}[question.difficulty]) : undefined].filter(Boolean).join(' · ')}</p>}
        {question.learning_objective && <p className="quiz-question-note"><strong>{t('Learning objective:')}</strong> {question.learning_objective}</p>}
        <button className="quiz-flag-button" type="button" aria-pressed={flagged.includes(question.id)} onClick={()=>setFlagged(previous=>previous.includes(question.id)?previous.filter(id=>id!==question.id):[...previous,question.id])}>{flagged.includes(question.id)?t('Marked for review ⚑'):t('Mark for review')}</button>
        {question.type === 'multiple' && <p className="quiz-question-note">{t('Select all correct answers. All selections must match for full credit.')}</p>}
        {question.type === 'text' ? <textarea
          aria-label={t('Your answer to: {0}', [question.question])}
          value={typeof answers[question.id] === 'string' ? String(answers[question.id]) : ''}
          maxLength={4000} rows={4} placeholder={t('Write your answer…')}
          onChange={event => setDraft(previous => ({ ...previous, [question.id]: event.target.value }))}
        /> : <div className="quiz-options">{question.options?.map((option, optionIndex) => {
          const selected = Array.isArray(answers[question.id]) ? answers[question.id] as number[] : [];
          return <label key={optionIndex} className={selected.includes(optionIndex) ? 'is-selected' : ''}>
            <input type={question.type === 'single' ? 'radio' : 'checkbox'} name={`${id}-${question.id}`} checked={selected.includes(optionIndex)} onChange={() => setDraft(previous => {
              const values = Array.isArray(previous[question.id]) ? previous[question.id] as number[] : [];
              return { ...previous, [question.id]: question.type === 'single' ? [optionIndex] : values.includes(optionIndex) ? values.filter(value => value !== optionIndex) : [...values, optionIndex].sort((a, b) => a - b) };
            })} /><span>{option}</span>
          </label>;
        })}</div>}
      </fieldset>)}
      {!shown.length && <p>{t('No questions in this category.')}</p>}
    </div>
    {!submitted && <div className="quiz-actions"><span>{tooLong ? t('Your combined answers are too long. Shorten them to submit.') : t('Answers are revealed after submission.')}</span><button type="button" disabled={locked || questionIndex === 0} onClick={()=>setQuestionIndex(previous=>Math.max(0,previous-1))}>{t('Previous')}</button>{!lastQuestion ? <button type="button" disabled={locked || !currentQuestion || !hasAnswer(currentQuestion)} onClick={()=>setQuestionIndex(previous=>previous+1)}>{t('Next')}</button> : <button type="submit" disabled={locked || tooLong || count !== quiz.questions.length}>{pending ? t('Submitting…') : t('Submit test')}</button>}</div>}
    {submitted && onViewResults && <div className="quiz-actions"><span>{t('Your results are ready.')}</span><button type="button" onClick={onViewResults}>{t('View results')}</button></div>}
  </form>;
}
