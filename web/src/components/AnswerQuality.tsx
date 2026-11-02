import { Toolbar } from './Toolbar';
import { useEffect, useState } from 'react';
import { t, getLocale } from '../lib/i18n';
import { feedbackRequest } from './AnswerFeedback';
import './AnswerQuality.css';

interface Quality {
  days: number;
  totals: { reports: number; open: number; reviewed: number; resolved: number; reporters: number };
  categories: { category: string; reports: number }[];
  sources: { source_document_id: string; source_filename: string; reports: number; unresolved: number }[];
  trend: { day: string; reports: number; resolved: number }[];
}
const names: Record<string, string> = { incorrect_answer: 'Incorrect answer', outdated_policy: 'Outdated policy', other: 'Other issue' };

export function AnswerQuality({ revision = 0 }: { revision?: number }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Quality | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setData(null);
    feedbackRequest<Quality>(`/admin/feedback/quality?days=${days}`)
      .then(result => { if (active) setData(result); })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : 'Could not load answer quality.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, revision, refresh]);
  return <section className="answer-quality" aria-labelledby="answer-quality-title">
    <Toolbar as="header"><h3 id="answer-quality-title">{t('Answer quality')}</h3><label>{t('Reporting period')} <select value={days} onChange={event => setDays(Number(event.target.value))}>{[7, 30, 90, 365].map(value => <option key={value} value={value}>{t('Last {0} days', [value])}</option>)}</select></label><button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('Refresh')}</button></Toolbar>
    <p>{t('Based on submitted feedback. Unreported answers have not been rated for accuracy. Counts use the report creation date and current review status.')}</p>
    {loading && <p role="status">{t('Loading answer quality…')}</p>}
    {error && <p role="alert" className="administration-error">{t(error)}</p>}
    {data && <>
      <dl className="answer-quality-metrics">{([['Reports', data.totals.reports], ['Open', data.totals.open], ['Reviewed', data.totals.reviewed], ['Resolved', data.totals.resolved], ['Reporters', data.totals.reporters]] as const).map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value.toLocaleString(getLocale())}</dd></div>)}</dl>
      {data.totals.reports === 0 ? <p>{t('No feedback was submitted in this period.')}</p> : <div className="answer-quality-tables">
        <div><h4>{t('Reported issues')}</h4><table><thead><tr><th>{t('Category')}</th><th>{t('Reports')}</th></tr></thead><tbody>{data.categories.map(item => <tr key={item.category}><td>{t(names[item.category] || item.category)}</td><td>{item.reports}</td></tr>)}</tbody></table></div>
        <div><h4>{t('Recurring sources')}</h4>{data.sources.length ? <table><thead><tr><th>{t('Related source')}</th><th>{t('Reports')}</th><th>{t('Unresolved')}</th></tr></thead><tbody>{data.sources.map(item => <tr key={`${item.source_document_id}:${item.source_filename}`}><td>{item.source_filename}</td><td>{item.reports}</td><td>{item.unresolved}</td></tr>)}</tbody></table> : <p>{t('No source-linked feedback in this period.')}</p>}</div>
        <div><h4>{t('Daily feedback trend')}</h4><div className="answer-quality-trend"><table><thead><tr><th>{t('Date')}</th><th>{t('Reports')}</th><th>{t('Resolved')}</th></tr></thead><tbody>{data.trend.map(item => <tr key={item.day}><td>{new Date(`${item.day}T12:00:00`).toLocaleDateString(getLocale())}</td><td>{item.reports}</td><td>{item.resolved}</td></tr>)}</tbody></table></div></div>
      </div>}
    </>}
  </section>;
}
