import { useMemo, useState } from 'react';
import type { ChatMessage } from '../types';
import { answerLinks } from '../lib/answerContext';
import { answerTaskState } from '../lib/taskState';
import { skillDisplayName } from '../lib/skillNames';
import { t } from '../lib/i18n';
import './AiTransparency.css';
import { AnswerSteps } from './AnswerSteps';
import { answerActivityLabel, answerActivities } from '../lib/answerSteps';
import { redactActivity } from '../lib/redaction';
import { AnswerActionLabel } from './AnswerActionLabel';

/** One disclosure owns progress, recorded activity, and retrieval references. */
export function AnswerContext({ answer, request, progressSummary = '', compact = false }: { answer: ChatMessage; request?: ChatMessage; progressSummary?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const links = useMemo(() => answerLinks(answer.content, window.location.origin), [answer.content]);
  const notes = request?.noteReferences || [];
  const files = request?.officeReferences || [];
  const tools = [...new Set((answer.toolsUsed || []).map(tool => tool.name).filter((name): name is string => typeof name === 'string' && Boolean(name.trim())))];
  const skills = [...new Set((answer.skillsUsed || []).filter((name): name is string => typeof name === 'string' && Boolean(name.trim())))];
  const status = answerTaskState(answer);
  const retrieval = [...tools, ...skills, request?.mode || '', answer.mode || '', ...(answer.workLog || []).map(step => step.text)].some(name => /rag|knowledge|retriev|web.?search|brave.?search|search.?web|research.sources/i.test(name));
  const sources = links.filter(link => {
    const url = new URL(link.href);
    const knowledge = url.origin === window.location.origin && /^\/(?:sessions\/(?:legacy|[a-f0-9]{32})\/)?knowledge\/[a-f0-9-]{36}\/file$/.test(url.pathname);
    const business = url.protocol === 'https:' && (url.hostname.endsWith('.sharepoint.com') || url.hostname === 'teams.microsoft.com');
    return knowledge || business || (retrieval && url.origin !== window.location.origin);
  });
  const reportedActivity = redactActivity(answerActivityLabel(answer, status));
  const skillActivity = /^Using skill (.+?)(?:…|\.\.\.)?$/.exec(reportedActivity);
  const activityLabel = skillActivity ? t('Using skill {0}…', [skillDisplayName(skillActivity[1])]) : t(reportedActivity);
  const recordedSteps = answerActivities(answer.workLog).length;
  const exceptional = ['failed', 'stopped', 'waiting', 'stopping'].includes(status.state);
  return <details className={`answer-context answer-details${compact ? ' answer-details-compact' : ''}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      {(answer.isStreaming || exceptional) && <span className={`ai-task-badge ai-task-${status.state}`} role="status" aria-live="polite" aria-atomic="true"><span className={`ai-task-mark${status.active ? ' is-active' : ''}`} aria-hidden="true" /><span className="answer-current-activity" title={activityLabel}>{activityLabel}</span></span>}
      {answer.isStreaming && recordedSteps > 0 && <span className="answer-recorded-step-count">{t(recordedSteps === 1 ? '1 recorded step' : '{0} recorded steps', [recordedSteps])}</span>}
      {compact ? <AnswerActionLabel icon="details" label={t('Answer details')} /> : <span>{t('Answer details')}</span>}
    </summary>
    {open && <div className="answer-context-body">
      <p className="answer-context-intro">{t('AI-generated answer. Review the linked material and recorded context when assessing this response.')}</p>
      <p className="answer-detail-status"><strong>{t(status.label)}</strong>{exceptional && <> · {t(status.detail)}</>}</p>
      <AnswerSteps answer={answer} progressSummary={progressSummary} />
      {sources.length > 0 && <section className="answer-detail-sources"><h3>{t('Sources')}</h3><ul>{sources.map(link => <li key={link.href}><a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a><small>{new URL(link.href).hostname}</small></li>)}</ul></section>}
      {Boolean(notes.length || files.length || tools.length || skills.length || request?.agentName || request?.agentSlugs?.length) && <section><h3>{t('Recorded context')}</h3>
        {notes.length > 0 && <><h4>{t('Notes supplied with the request')}</h4><ul>{notes.map(note => <li key={note.id}>{note.title}{note.truncated && <small>{t('Excerpt supplied')}</small>}</li>)}</ul></>}
        {files.length > 0 && <><h4>{t('Office files supplied with the request')}</h4><ul>{files.map(file => <li key={file.id}>{file.name}{file.revision !== undefined && <small>{t('Revision {0}', [file.revision])}</small>}{file.truncated && <small>{t('Excerpt supplied')}</small>}</li>)}</ul></>}
        <dl>{request?.agentName && <div><dt>{t('Agent')}</dt><dd>{request.agentName}</dd></div>}
          {!!request?.agentSlugs?.length && <div><dt>{t('Selected agents')}</dt><dd>{request.agentSlugs.join(', ')}</dd></div>}
          {skills.length > 0 && <div><dt>{t('Skills reported')}</dt><dd>{skills.map(skillDisplayName).join(', ')}</dd></div>}
          {tools.length > 0 && <div><dt>{t('Tools reported')}</dt><dd>{tools.map(tool => tool.replace(/_/g, ' ')).join(', ')}</dd></div>}
        </dl>
      </section>}
    </div>}
  </details>;
}
