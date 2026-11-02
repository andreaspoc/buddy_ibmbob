import { brandText } from '../lib/brand';
import { Toolbar } from './Toolbar';
import { usePluginCapabilities } from '../lib/pluginCapabilities';
import { t, getLanguage, getLocale } from "../lib/i18n";
import { useEffect, useState } from 'react';
import { ResearchReport } from './ResearchReport';
import { appConfirm } from './AppDialog';

interface ResearchSummary { session_id: string; title: string; job_id: string; status: string; updated_at: string }
interface Evidence { id?: string; title?: string; url?: string; source?: string; excerpt?: string; text?: string; fetched_at?: string }
interface ResearchDetail { job_id?: string; can_resume?: boolean; visuals?: Array<{path:string;url:string;title:string;captured_at:string;source_id?:string}>; usage?: {bobcoins:number|null;tokens:number|null;phases:Array<{phase:string;cost:number|null;tokens:number|null}>}; progress?: string; activity?: Array<{phase:string;message:string;status:string;query:string;url:string;timestamp:string}>; title: string; status: string; report: string; plan: Record<string, unknown> | null; evidence: Evidence[]; review: Record<string, unknown> | null; files: unknown[] }
async function request(path = '', body?: unknown) {
  const response = await fetch('/research' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify({ ...(body as Record<string, unknown>), ui_language: getLanguage() }) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Research could not be loaded');
  return data;
}
async function stopJob(jobId: string) {
  const response = await fetch('/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' });
  if (!response.ok) throw new Error('Research could not be stopped');
}
function safeUrl(url?: string) { if (/^\/knowledge\/[a-f0-9-]{36}\/file$/i.test(url || '')) return url; try { const parsed = new URL(url || ''); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } }
export function ResearchManager({ onClose, onTask, onOpenConversation, initialSessionId }: { onClose: () => void; onTask: (jobId: string) => void; onOpenConversation?: (sessionId: string) => void; initialSessionId?: string }) {
  const plugins = usePluginCapabilities(true);
  const [tab, setTab] = useState<'new' | 'reports'>(initialSessionId ? 'reports' : 'new');
  const [topic, setTopic] = useState('');
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState('executive');
  const [web, setWeb] = useState(false);
  const [webAvailable, setWebAvailable] = useState(false);
  const [knowledgeAvailable, setKnowledgeAvailable] = useState(false);
  const [knowledge, setKnowledge] = useState(false);
  const [officeAvailable, setOfficeAvailable] = useState(false);
  const [office, setOffice] = useState(false);
  const [diagrams,setDiagrams] = useState(true);
  const [screenshots,setScreenshots] = useState(false);
  const [rounds, setRounds] = useState(1);
  const [timeout, setTimeoutBudget] = useState(300);
  const [reports, setReports] = useState<ResearchSummary[]>([]);
  const [selected, setSelected] = useState(initialSessionId || '');
  const [detail, setDetail] = useState<ResearchDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);
  const load = async () => setReports(await request());
  const act = async (action: () => Promise<unknown>) => {
    setActing(true); setError('');
    try { await action(); await load(); } catch (e) { setError((e as Error).message); } finally { setActing(false); }
  };
  const stop = async (jobId: string) => {
    if (await appConfirm(t("Stop this research? You can resume it later from the work already saved."))) await act(() => stopJob(jobId));
  };
  const resume = () => act(async () => { setDetail(await request('/' + encodeURIComponent(selected) + '/resume', {}).then(() => request('/' + encodeURIComponent(selected)))); });
  const detailStatus = detail?.status;
  useEffect(() => { if (detailStatus) load().catch(e => setError(e.message)); }, [detailStatus]);
  useEffect(() => {
    let active = true;
    Promise.all([request('/capabilities'), request()]).then(([capabilities, items]) => {
      if (active) {
        setOfficeAvailable(Boolean(capabilities.office));
        setKnowledgeAvailable(Boolean(capabilities.knowledge));
        setWebAvailable(Boolean(capabilities.web_search));
        setWeb(Boolean(capabilities.web_search));
        setReports(items);
        if (initialSessionId) {
          setSelected(initialSessionId);
          setTab('reports');
        }
      }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [initialSessionId]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const update = () => request('/' + encodeURIComponent(selected)).then(value => { if (active) setDetail(value); }).catch(e => { if (active) setError(e.message); });
    void update();
    const interval = window.setInterval(update, 3000);
    return () => { active = false; window.clearInterval(interval); };
  }, [selected]);
  const start = async () => {
    setBusy(true); setError('');
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    try {
      const job = await request('', { topic: topic.trim(), title: title.trim() || topic.trim().slice(0, 100), style, diagrams, screenshots, web_search: web, knowledge, office, max_rounds: rounds, timeout_seconds: timeout });
      setSelected(job.session_id); setDetail(null); setTab('reports'); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="feature-overlay"><section className="feature-dialog research-dialog" role="dialog" aria-modal="true" aria-label={t("Research reports")}>
    <Toolbar as="header" className="research-page-header"><Toolbar embedded className="knowledge-hero research-hero">
      <div className="knowledge-hero-copy"><span className="knowledge-hero-brand">{brandText("Buddy")}</span><span className="feature-eyebrow">{t("EVIDENCE INTO DECISIONS")}</span><h2>{t("Research reports")}</h2><p>{t("Turn a question into an executive report with evidence, comparisons, recommendations, and citations. Buddy plans the investigation, gathers sources, and reviews the report for gaps.")}</p></div>
      <div className="knowledge-hero-art research-hero-art" aria-hidden="true"><svg width="112" height="112" viewBox="0 0 112 112" fill="none"><rect x="12" y="12" width="88" height="88" rx="24" fill="white" fillOpacity=".06" stroke="#d8aeff" strokeOpacity=".3" /><path d="M36 30h28l12 12v39H36V30Z" stroke="#e6cbff" strokeWidth="2.5" strokeLinejoin="round" /><path d="M64 30v12h12M45 49h12M45 58h9" stroke="#d8aeff" strokeWidth="2.5" strokeLinecap="round" /><circle cx="65" cy="67" r="10" fill="#4a1d70" stroke="#e6cbff" strokeWidth="2.5" /><path d="m72 74 9 9" stroke="#e6cbff" strokeWidth="3" strokeLinecap="round" /><circle cx="88" cy="25" r="5" fill="#a847ff" /><circle cx="24" cy="88" r="3" fill="#47bfff" /></svg></div>
      <button type="button" className="feature-close" onClick={onClose}>{t("Close")}</button>
    </Toolbar></Toolbar>
    <Toolbar as="nav" aria-label={t("Research")}><button aria-pressed={tab === 'new'} onClick={() => setTab('new')}>{t("New research")}</button><button aria-pressed={tab === 'reports'} onClick={() => { setTab('reports'); load().catch(e => setError(e.message)); }}>{t("Your reports")}</button></Toolbar>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {tab === 'new' ? <>
      <form onSubmit={e => { e.preventDefault(); void start(); }}>
        <label>{t("What decision should this research support?")}<textarea required minLength={10} maxLength={12000} value={topic} onChange={e => setTopic(e.target.value)} placeholder={t("Compare private 5G and Wi-Fi 7 for enterprise campuses in Example Region. Assess costs, security, deployment trade-offs, and recommend an approach for a software operator.")} /></label>
        <label>{t("Report title")}<span className="research-optional">{t("Optional")}</span><input maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder={t("Enterprise connectivity strategy")} /></label>
        <div className="research-settings"><label>{t("Report format")}<select value={style} onChange={e => setStyle(e.target.value)}><option value="executive">{t("Executive · findings and recommendations")}</option><option value="analyst">{t("Analyst · detailed evidence and methods")}</option></select></label><label>{t("Time budget")}<select value={timeout} onChange={e => setTimeoutBudget(Number(e.target.value))}><option value={120}>{t("2 minutes (Fast)")}</option><option value={300}>{t("5 minutes")}</option><option value={900}>{t("15 minutes")}</option><option value={1800}>{t("30 minutes")}</option><option value={3600}>{t("60 minutes")}</option></select></label></div>
        <fieldset className="research-sources"><legend>{t("Sources to investigate")}</legend><label className="feature-checkbox"><input type="checkbox" checked={web} disabled={!webAvailable} onChange={e => setWeb(e.target.checked)} />{t("Public web")}{!webAvailable && <span className="research-optional">{t("Search provider unavailable")}</span>}</label><label className="feature-checkbox"><input type="checkbox" checked={knowledge} disabled={!knowledgeAvailable} onChange={e => setKnowledge(e.target.checked)} />{t("Knowledge base")}</label><label className="feature-checkbox"><input type="checkbox" checked={office} disabled={!officeAvailable} onChange={e => setOffice(e.target.checked)} />{t("My connected Office documents")}</label><small>{t("Combine public webpages and PDFs with authorized internal passages and connected OneDrive documents (up to six files, 2 MB each). Connect Microsoft 365 to enable Office research.")}</small></fieldset>
        <fieldset className="research-sources"><legend>{t("Report visuals")}</legend><label className="feature-checkbox"><input type="checkbox" checked={diagrams} onChange={e => setDiagrams(e.target.checked)} />{t("Carbon charts where useful")}</label><label className="feature-checkbox"><input type="checkbox" checked={screenshots} onChange={e => setScreenshots(e.target.checked)} />{t("Website screenshots · up to three public pages")}</label></fieldset><label>{t("Investigation depth")}<select value={rounds} onChange={e => setRounds(Number(e.target.value))}><option value={1}>{t("Focused · one research round")}</option><option value={2}>{t("Standard · research and gap follow-up")}</option><option value={3}>{t("Thorough · up to three research rounds")}</option></select></label>
        <button type="submit" className="feature-primary" disabled={busy || !(web || knowledge || office)}>{busy ? t("Starting research…") : t("Start research report")}</button>
        <small className="research-note">{t("The default is a focused five-minute report. Additional rounds and screenshots increase work and spending.")}<br />{t("You can close this tab: research keeps running until you stop it, and Buddy notifies you when it ends.")}<br />{t("Research continues in Tasks. Reports distinguish supported findings from uncertainty; review sources before acting.")}</small>
      </form></> : <div className="research-library"><aside className="research-list"><button onClick={() => load().catch(e => setError(e.message))}>{t("Refresh reports")}</button>{reports.length === 0 && <p>{t("No reports yet. Start an investigation to build your research library.")}</p>}{reports.map(report => <button className="research-report-item" aria-pressed={selected === report.session_id} key={report.session_id} onClick={() => { setSelected(report.session_id); setDetail(null); setError(''); }}><strong>{report.title}</strong><span>{t(report.status || "")} · {new Date(report.updated_at).toLocaleDateString(getLocale())}</span></button>)}</aside>
        <section className="research-detail" aria-label={t("Research report")}>{!selected ? <p>{t("Select a report to see findings and sources.")}</p> : !detail ? <p role="status">{t("Loading report…")}</p> : <><div className="research-report-heading"><h3>{detail.title}</h3><span className="research-status">{t(detail.status.replaceAll('_', ' '))}</span></div>{detail.usage && <section className="research-usage" aria-label={t("Research spending")}><strong>🪙 {detail.usage.bobcoins === null ? t("Bobcoin usage not reported yet") : `${detail.usage.bobcoins.toLocaleString(getLocale(),{maximumFractionDigits:4})} Bobcoins`}</strong>{detail.usage.tokens !== null && <span>{detail.usage.tokens.toLocaleString(getLocale())} {t("context tokens")}</span>}<small>{['running','queued'].includes(detail.status) ? t("Reported spending so far · updates after each phase") : t("Total reported spending, including previous attempts")}</small>{detail.usage.phases.length > 0 && <details><summary>{t("Spending by phase")}</summary><ul>{detail.usage.phases.map((phase,i)=><li key={i}>{t(phase.phase || "")}: {phase.cost === null ? t("not reported") : `${phase.cost.toLocaleString(getLocale(),{maximumFractionDigits:4})} Bobcoins`}</li>)}</ul></details>}</section>}<div className="research-actions">{detail.job_id && ['running','queued'].includes(detail.status) && <button type="button" disabled={acting} onClick={() => void stop(detail.job_id!)}>{t("Stop research")}</button>}{detail.can_resume && <button type="button" disabled={acting} onClick={() => void resume()}>{t(acting ? "Resuming…" : "Resume research")}</button>}{detail.job_id && <button onClick={() => {onClose(); onTask(detail.job_id!);}}>{t("View task progress")}</button>}{onOpenConversation && <button onClick={() => onOpenConversation(selected)}>{t("Open conversation")}</button>}{detail.report && <a href={'/research/' + encodeURIComponent(selected) + '/export?format=markdown'} download>{t("Download Markdown")}</a>}</div>{detail.activity && <section className="research-live-activity" aria-label={t("Live research activity")}><h4>{['running','queued'].includes(detail.status) ? t("Live research activity") : t("Research activity")}</h4><p role="status">{t(detail.progress || "")}</p><ol>{detail.activity.slice(-12).map((item,i) => <li key={`${item.timestamp}-${i}`}><time>{new Date(item.timestamp).toLocaleTimeString(getLocale())}</time><strong>{item.phase ? `${item.phase} · ` : ''}{t(item.message || "")}{item.status ? ` · ${item.status}` : ''}</strong>{item.query && <span>{t("Search:")}{item.query}</span>}{safeUrl(item.url) && <a href={safeUrl(item.url)} target="_blank" rel="noopener noreferrer">{item.url}</a>}</li>)}</ol></section>}{detail.review && <details className="research-evidence"><summary>{t("Evidence review")}</summary><pre>{JSON.stringify(detail.review, null, 2)}</pre></details>}{detail.report ? <ResearchReport key={selected} title={detail.title} content={detail.report} sources={detail.evidence} visuals={detail.visuals} sessionId={selected} canSaveToOffice={plugins.office && detail.status === 'completed'} /> : <p role="status">{t("The final report is not ready yet. Follow searches and page reads in the activity log above.")}</p>}{detail.plan && <details className="research-evidence"><summary>{t("Research plan")}</summary><pre>{JSON.stringify(detail.plan, null, 2)}</pre></details>}<details className="research-evidence"><summary>{t("Saved verified evidence (")}{detail.evidence?.length || 0})</summary>{['running','queued'].includes(detail.status) && <p>{t("Evidence files are saved when the task finishes. Page reads appear in the live activity log.")}</p>}{detail.evidence?.map((source, i) => <article key={source.id || i}><strong>{source.title || source.source || t("Source {0}", [i + 1])}</strong>{safeUrl(source.url) && <a href={safeUrl(source.url)} target="_blank" rel="noopener noreferrer">{t("Open source ↗")}</a>}<details><summary>{t("View collected text")}</summary><p>{source.text || source.excerpt || t("No collected text available.")}</p></details></article>)}</details></>}</section></div>}
  </section></div>;
}
