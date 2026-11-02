import { brandText } from '../lib/brand';
import { themeColor } from '../lib/appearance';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DonutChartOptions, StackedBarChartOptions, ScaleTypes } from '@carbon/charts';
import '@carbon/charts/styles.css';
import './LearningQuizResults.css';
import { learningUserName } from '../lib/learningIdentity';
import { animateInterface, uiMotion } from '../lib/motion';
import type { create } from '../../carbon-charts';

export type ResultQuestion = { id: string; type: 'single' | 'multiple' | 'dropdown' | 'text'; question: string; options?: string[]; answer?: number[] | string; points: number; rubric?: string; explanation?: string; study_topic?: string; reading?: string };
export type QuizSubmission = { id: string; username: string; display_name?: string; submitted_at: string; score: number; max_score: number; pending_manual: boolean; quiz_version?: number; questions?: ResultQuestion[]; answers: Record<string, string | number[]>; grades: Record<string, { score: number | null; feedback?: string; method?: string; outcome?: string }>; source_book_id?: string | null; folder_id?: string; reading_recommendations?: { question_id: string; chapter_id: string; title: string; reason: string }[] };
const labels = ['Correct', 'Partially correct', 'Incorrect', 'Awaiting grading'];
const brandPalette = ['#6929c4', '#8a3ffc', '#491d8b', '#a56eff', '#b692f6', '#31135e'];
const colors = { Correct: '#198038', 'Partially correct': '#8a3800', Incorrect: '#da1e28', 'Awaiting grading': '#6f6f6f' };
function questionOutcome(submission: QuizSubmission, question: ResultQuestion) {
  const score = submission.grades[question.id]?.score;
  return score == null ? labels[3] : score === question.points ? labels[0] : score > 0 ? labels[1] : labels[2];
}
function outcomeTone(outcome: string) {
  if (outcome === 'Correct') return 'correct';
  if (outcome === 'Partially correct') return 'partial';
  if (outcome === 'Incorrect') return 'incorrect';
  return 'pending';
}
function outcomeIcon(outcome: string) {
  if (outcome === 'Correct') return '✓';
  if (outcome === 'Partially correct') return '◐';
  if (outcome === 'Incorrect') return '✕';
  return '⏳';
}
const answerText = (question: ResultQuestion, answer?: string | number[]) => typeof answer === 'string' ? (answer.trim() || 'No answer') : answer?.length ? answer.map(index => question.options?.[index] ?? String(index)).join('; ') : 'No answer';
type Datum = { group: string; value: number; key?: string };
const chartColors = (data: Datum[]) => ({ ...Object.fromEntries([...new Set(data.map(row => row.group))].map((group, index) => [group, themeColor(brandPalette[index % brandPalette.length])])), ...colors });

function CarbonChart({ title, type, data }: { title: string; type: 'donut' | 'bar' | 'stacked'; data: Datum[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const handle = useRef<ReturnType<typeof create> | null>(null);
  const latestData = useRef(data);
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    import('../../carbon-charts').then(module => {
      if (!active || !host.current) return;
      setError(false);
      const options: DonutChartOptions & StackedBarChartOptions = {
        title, height: '300px', resizable: true,
        color: { scale: chartColors(latestData.current) }, toolbar: { enabled: false },
        ...(type === 'donut' ? { donut: { center: { label: 'Questions' } } } : {
          axes: { left: { mapsTo: 'value', scaleType: 'linear' as ScaleTypes, title: type === 'stacked' ? 'Answers' : 'Learners' }, bottom: { mapsTo: type === 'stacked' ? 'key' : 'group', scaleType: 'labels' as ScaleTypes } },
        }),
      };
      const chart = module.create(host.current, { type: type === 'stacked' ? 'stackedbar' : type, data: latestData.current, options });
      handle.current = chart;
      dispose = () => { if (handle.current === chart) handle.current = null; chart.dispose(); };
    }).catch(error => { console.error('Unable to render Learning chart', error); if (active) setError(true); });
    return () => { active = false; dispose?.(); };
  }, [title, type]);
  useEffect(() => {
    latestData.current = data;
    handle.current?.update({ data, options: { color: { scale: chartColors(data) } } });
  }, [data]);
  return <figure className="learning-stat-chart">
    <div ref={host} aria-label={title} />
    {error && <p role="status">Chart unavailable. The statistics are listed below.</p>}
    <details><summary>View chart data: {title}</summary><table><thead><tr><th>Category</th><th>Value</th></tr></thead><tbody>{data.map((row, index) => <tr key={index}><td>{row.key ? `${row.key} · ` : ''}{row.group}</td><td>{row.value}</td></tr>)}</tbody></table></details>
  </figure>;
}

export function QuizGradingState({ saved = false }: { saved?: boolean }) {
  return <section className="learning-quiz-grading" role="status" aria-live="polite" aria-busy="true">
    <p className="learning-report-eyebrow">{saved ? 'ANSWERS SAVED' : 'FINISHING YOUR ATTEMPT'}</p>
    <h3>{saved ? 'Loading your results' : 'Preparing your results'}</h3>
    <progress aria-label={saved ? 'Loading your learning report' : 'Submitting and grading your answers'} />
    <p>{saved ? 'Your answers are saved. Your learning report will appear here automatically.' : 'Please stay on this screen while we save and grade your answers. Your results will appear here automatically.'}</p>
    <p className="learning-muted">Your score, explanations and study plan are also available to administrators.</p>
  </section>;
}

export function QuizReport({ submission, administrator = false }: { submission: QuizSubmission; administrator?: boolean }) {
  const report = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!report.current) return;
    const animation = animateInterface(report.current, [
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: uiMotion.enter, easing: uiMotion.entrance });
    return () => animation.cancel();
  }, [submission.id]);
  const questions = useMemo(() => submission.questions || [], [submission.questions]);
  const [filter, setFilter] = useState('all');
  const [index, setIndex] = useState(0);
  const missed = questions.filter(q => ['Incorrect', 'Partially correct'].includes(questionOutcome(submission, q)));
  const counts = useMemo(() => labels.map(group => ({ group, value: questions.filter(q => questionOutcome(submission, q) === group).length })), [submission, questions]);
  const shown = questions.filter(q => filter === 'all' || (filter === 'review' ? ['Incorrect', 'Partially correct'].includes(questionOutcome(submission, q)) : questionOutcome(submission, q) === filter));
  const visibleIndex = Math.min(index, Math.max(0, shown.length - 1));
  const current = shown[visibleIndex];
  const percent = submission.max_score ? Math.round(submission.score / submission.max_score * 100) : 0;
  const currentOutcome = current ? questionOutcome(submission, current) : '';
  const currentTone = outcomeTone(currentOutcome);

  return <section ref={report} className="learning-quiz-report" aria-label={administrator ? `Learning report for ${learningUserName(submission)}` : 'Your learning report'}>
    <div className="learning-report-hero">
      <div>
        <p className="learning-report-eyebrow">{administrator ? learningUserName(submission) : 'YOUR LEARNING REPORT'} · Version {submission.quiz_version}</p>
        <h3>{submission.pending_manual ? 'Your attempt is saved' : missed.length ? 'Keep building your understanding' : 'Excellent understanding'}</h3>
        <p>{submission.pending_manual ? 'Some written answers are awaiting grading. The score below is provisional.' : 'See what you understood, learn from mistakes, and choose what to study next.'}</p>
      </div>
      <div className="learning-report-score">
        <strong>{percent}%</strong>
        <span>{submission.score} / {submission.max_score} points</span>
        {submission.pending_manual && <small>Provisional score</small>}
      </div>
    </div>

    <div className="learning-report-metrics">
      {counts.map(row => (
        <div key={row.group} className={`learning-metric-tile tone-${outcomeTone(row.group)}`}>
          <strong>{row.value}</strong>
          <span>{row.group}</span>
        </div>
      ))}
    </div>

    <CarbonChart title="Answer outcomes" type="donut" data={counts} />

    <section className="learning-study-plan" aria-label="Personal improvement plan">
      <p className="learning-report-eyebrow">YOUR NEXT STEPS</p>
      <h3>{missed.length ? 'A study plan based on your answers' : submission.pending_manual ? 'While your answers are being graded' : 'Put your knowledge into practice'}</h3>
      {missed.length ? (
        <ol className="learning-improvement-list">
          {[...missed].sort((a, b) => (b.points - (submission.grades[b.id]?.score || 0)) - (a.points - (submission.grades[a.id]?.score || 0))).map(q => {
            const qNum = questions.indexOf(q) + 1;
            const outcome = questionOutcome(submission, q);
            const tone = outcomeTone(outcome);
            const earned = submission.grades[q.id]?.score ?? 0;
            return (
              <li key={q.id} className={`learning-improvement-item tone-${tone}`}>
                <div className="learning-improvement-item-head">
                  <div className="learning-improvement-badges">
                    <span className="learning-improvement-qbadge">Question {qNum}</span>
                    <span className={`learning-outcome-pill tone-${tone}`}>
                      {outcomeIcon(outcome)} {outcome} · {earned}/{q.points} pts
                    </span>
                    {q.study_topic && <span className="learning-topic-pill">Topic: {q.study_topic}</span>}
                  </div>
                  <button
                    type="button"
                    className="learning-improvement-jump-btn"
                    onClick={() => {
                      setFilter('all');
                      const targetIdx = questions.indexOf(q);
                      if (targetIdx >= 0) setIndex(targetIdx);
                    }}
                  >
                    Review question ↓
                  </button>
                </div>
                <strong className="learning-improvement-title">{q.study_topic || q.question}</strong>
                {q.study_topic && q.study_topic !== q.question && (
                  <p className="learning-improvement-question-prompt">{q.question}</p>
                )}
                <div className="learning-improvement-answers-row">
                  <div className="learning-improvement-answer-box is-learner">
                    <small>{administrator ? 'Submitted answer' : 'Your answer'}</small>
                    <span>{answerText(q, submission.answers[q.id])}</span>
                  </div>
                  <div className="learning-improvement-answer-box is-reference">
                    <small>Correct / reference answer</small>
                    <span>{answerText(q, q.answer)}</span>
                  </div>
                </div>
                <div className="learning-improvement-coaching">
                  <strong>How to improve:</strong>{' '}
                  <p>{submission.grades[q.id]?.feedback || q.explanation || 'Compare your answer with the correct answer below.'}</p>
                </div>
                <p className="learning-improvement-readnext">
                  <strong>Read next:</strong> {q.reading || (submission.source_book_id ? 'Revisit the section in the quiz source that covers this question.' : 'Review the correct answer and explanation in your answer review below.')}
                </p>
                {submission.source_book_id && submission.folder_id && submission.reading_recommendations?.filter(item => item.question_id === q.id).map(item => (
                  <p key={item.chapter_id}>
                    <a href={`/learning/folders/${encodeURIComponent(submission.folder_id!)}/books/${encodeURIComponent(submission.source_book_id!)}?chapter=${encodeURIComponent(item.chapter_id)}`}>Read: {item.title} →</a>
                    <small className="learning-reading-reason">{item.reason}</small>
                  </p>
                ))}
                <p className="learning-muted">Check your understanding: explain the concept in your own words, then compare it with the reference answer.</p>
              </li>
            );
          })}
        </ol>
      ) : (
        <p>{submission.pending_manual ? 'Review the feedback available below. Written answers will appear here once grading is complete.' : 'Use the concepts in a practical example and explain your reasoning without looking at the source.'}</p>
      )}
      {submission.source_book_id && submission.folder_id && <a className="learning-button" href={`/learning/folders/${encodeURIComponent(submission.folder_id)}/books/${encodeURIComponent(submission.source_book_id)}`}>Read the quiz source →</a>}
    </section>

    <section className="learning-answer-review" aria-label="Answer review">
      <div className="learning-answer-review-head">
        <h3>Learn from each answer</h3>
        <div className="learning-report-filters" role="group" aria-label="Filter answer review">
          {[['all', 'All questions'], ['review', 'Needs improvement'], ['Correct', 'Correct'], ['Awaiting grading', 'Awaiting grading']].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setIndex(0); }}>{label}</button>
          ))}
        </div>
      </div>

      {shown.length > 1 && (
        <div className="learning-question-jump-strip" role="navigation" aria-label="Jump to question">
          {shown.map((q, idx) => {
            const qOutcome = questionOutcome(submission, q);
            const qTone = outcomeTone(qOutcome);
            const qNumber = questions.indexOf(q) + 1;
            return (
              <button
                type="button"
                key={q.id}
                className={`learning-question-jump-pill tone-${qTone} ${idx === visibleIndex ? 'is-active' : ''}`}
                aria-current={idx === visibleIndex ? 'true' : undefined}
                onClick={() => setIndex(idx)}
              >
                <span className="jump-pill-icon">{outcomeIcon(qOutcome)}</span>
                <span>Q{qNumber}</span>
              </button>
            );
          })}
        </div>
      )}

      {current ? <article className="learning-feedback-card" data-outcome={currentTone} key={current.id}>
        <div className={`learning-feedback-heading tone-${currentTone}`}>
          <span className="learning-feedback-qnum">Question {questions.indexOf(current) + 1} of {questions.length}</span>
          <strong className={`learning-outcome-pill tone-${currentTone}`}>{outcomeIcon(currentOutcome)} {currentOutcome}</strong>
          <span className="learning-feedback-points">{submission.grades[current.id]?.score ?? '—'} / {current.points} points</span>
        </div>

        <h4>{current.question}</h4>

        <div className="learning-answer-comparison">
          <div className={`learning-comparison-box is-submitted tone-${currentTone}`}>
            <strong>{administrator ? 'Submitted answer' : 'Your answer'}</strong>
            <p>{answerText(current, submission.answers[current.id])}</p>
          </div>
          <div className="learning-comparison-box is-reference">
            <strong>{current.type === 'text' ? 'Reference answer' : 'Correct answer'}</strong>
            <p>{answerText(current, current.answer)}</p>
          </div>
        </div>

        {current.type !== 'text' && (
          <ul className="learning-reviewed-options">
            {current.options?.map((option, optionIndex) => {
              const selected = Array.isArray(submission.answers[current.id]) && (submission.answers[current.id] as number[]).includes(optionIndex);
              const correct = Array.isArray(current.answer) && current.answer.includes(optionIndex);
              const stateClass = correct && selected
                ? 'is-correct is-selected'
                : correct
                ? 'is-correct is-missed'
                : selected
                ? 'is-incorrect is-selected'
                : '';
              return (
                <li key={optionIndex} className={stateClass}>
                  <div className="learning-reviewed-option-main">
                    <span className="learning-reviewed-option-letter" aria-hidden="true">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    <span className="learning-reviewed-option-text">{option}</span>
                  </div>
                  <small className="learning-reviewed-option-badge">
                    {correct ? '✓ Correct answer' : selected ? '✕ Incorrect choice' : ''}
                    {selected ? ' · Selected' : correct ? ' · Not selected' : ''}
                  </small>
                </li>
              );
            })}
          </ul>
        )}

        <div className="learning-feedback-explanation">
          <strong>Why this answer</strong>
          <p>{submission.grades[current.id]?.feedback || current.explanation || 'Compare the selected answer with the published reference answer.'}</p>
          {current.type === 'text' && current.explanation && <p>{current.explanation}</p>}
          {current.study_topic && <p><strong>Study topic:</strong> {current.study_topic}</p>}
          {current.reading && <p><strong>Further reading:</strong> {current.reading}</p>}
        </div>

        <p className="learning-muted">{submission.grades[current.id]?.method === 'ai' ? brandText('Automatically graded by Buddy using the reference answer and rubric. An administrator can adjust this mark.') : submission.grades[current.id]?.method === 'administrator' ? 'Marked by an administrator.' : current.type === 'text' ? 'Written response' : 'Automatically scored against the published answer key.'}</p>

        <div className="learning-report-paging">
          <button type="button" disabled={visibleIndex === 0} onClick={() => setIndex(visibleIndex - 1)}>← Previous answer</button>
          <span aria-live="polite">{visibleIndex + 1} / {shown.length}</span>
          <button type="button" disabled={visibleIndex >= shown.length - 1} onClick={() => setIndex(visibleIndex + 1)}>Next answer →</button>
        </div>
      </article> : <p className="learning-empty">No answers in this category.</p>}
    </section>
  </section>;
}

export function QuizStatistics({ submissions }: { submissions: QuizSubmission[] }) {
  const versions = [...new Set(submissions.map(item => item.quiz_version || 1))].sort((a, b) => b - a);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [questionId, setQuestionId] = useState('');
  const version = selectedVersion ?? versions[0];
  const items = submissions.filter(item => (item.quiz_version || 1) === version);
  const questions = items[0]?.questions || [];
  const question = questions.find(q => q.id === questionId) || questions[0];
  const finalItems = items.filter(item => !item.pending_manual);
  const average = finalItems.length ? Math.round(finalItems.reduce((total, item) => total + item.score / (item.max_score || 1) * 100, 0) / finalItems.length) : null;
  const distribution = useMemo(() => ['0–24%', '25–49%', '50–74%', '75–100%'].map((group, index) => ({ group, value: finalItems.filter(item => Math.min(3, Math.floor(item.score / (item.max_score || 1) * 4)) === index).length })), [submissions, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const outcomes = useMemo(() => questions.flatMap((q, index) => labels.map(group => ({ group, key: `Q${index + 1}`, value: items.filter(item => questionOutcome(item, q) === group).length }))), [submissions, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const selections = useMemo(() => question?.options?.map((option, index) => ({ group: `${index + 1}. ${option}${Array.isArray(question.answer) && question.answer.includes(index) ? ' (correct)' : ''}`, value: items.filter(item => Array.isArray(item.answers[question.id]) && (item.answers[question.id] as number[]).includes(index)).length })) || [], [submissions, version, question]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null;
  return <section className="learning-quiz-statistics" aria-label="Quiz statistics"><div className="learning-stat-heading"><div><p className="learning-report-eyebrow">ASSESSMENT INSIGHTS</p><h3>Understand where learners need support</h3></div><label>Quiz version<select value={version} onChange={event => setSelectedVersion(Number(event.target.value))}>{versions.map(value => <option key={value} value={value}>Version {value}</option>)}</select></label></div>
    <div className="learning-report-metrics"><div><strong>{items.length}</strong><span>Submitted attempts</span></div><div><strong>{average === null ? '—' : `${average}%`}</strong><span>Average final score</span></div><div><strong>{items.length - finalItems.length}</strong><span>Awaiting grading</span></div></div>
    <div className="learning-stat-grid">{!!finalItems.length && <CarbonChart title="Score distribution · completed grading" type="bar" data={distribution} />}<CarbonChart title="Answer outcomes by question" type="stacked" data={outcomes} /></div>
    <label>Explore answer choices<select value={question?.id || ''} onChange={event => setQuestionId(event.target.value)}>{questions.map((q, index) => <option value={q.id} key={q.id}>Q{index + 1}: {q.question}</option>)}</select></label>
    {question && <p>{question.question}</p>}{selections.length ? <><CarbonChart title="Answer choice selections" type="bar" data={selections} /><p className="learning-muted">Counts show selections, not marks. Multiple-choice questions can have more than one selection per learner.</p></> : <p className="learning-muted">Written responses are shown in each learner’s report below.</p>}
  </section>;
}
