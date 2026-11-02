import { brandText } from '../lib/brand';
import { Toolbar } from './Toolbar';
import { useEffect, useState } from 'react';
import './MemberChatAway.css';

type AwaySettings = { enabled: boolean; instructions: string; starts_at: string | null; ends_at: string | null; active: boolean; ready: boolean; error?: string | null };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/community/away${path}`, body === undefined ? undefined : { method: path ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : brandText('Unable to update People Buddy. Please try again.'));
  return data;
}
function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export default function MemberChatAway({ onBack, onSaved }: { onBack: () => void; onSaved?: (active: boolean) => void }) {
  const [saved, setSaved] = useState<AwaySettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState(localDate(new Date(Date.now() + 4 * 3600000).toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sample, setSample] = useState('');
  const [example, setExample] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    void request<AwaySettings>('').then(data => {
      if (cancelled) return;
      setSaved(data); setEnabled(data.enabled); setInstructions(data.instructions || '');
      setStart(localDate(data.starts_at));
      setEnd(localDate(data.ends_at) || localDate(new Date(Date.now() + 4 * 3600000).toISOString()));
    }).catch(() => { if (!cancelled) setError('Could not load your away settings. Please try again.'); });
    return () => { cancelled = true; };
  }, [loadVersion]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    const ends = end ? new Date(end) : null;
    const starts = start ? new Date(start) : null;
    if (enabled && (!instructions.trim() || !ends || !Number.isFinite(ends.getTime()) || ends.getTime() <= Date.now() || ends.getTime() > Date.now() + 7 * 86400000 || (starts && (!Number.isFinite(starts.getTime()) || starts >= ends)))) {
      setError('Add instructions and choose an end time in the next seven days, after the start time.'); return;
    }
    setBusy(true);
    try {
      const data = await request<AwaySettings>('', { enabled, instructions: instructions.trim(), starts_at: starts && Number.isFinite(starts.getTime()) ? starts.toISOString() : null, ends_at: ends && Number.isFinite(ends.getTime()) ? ends.toISOString() : null });
      setSaved(data); setEnabled(data.enabled); setNotice(data.active ? brandText('People Buddy is now replying while you are away.') : data.enabled && data.starts_at && new Date(data.starts_at).getTime() > Date.now() ? 'Your away schedule is saved.' : 'Saved. Automatic replies are off.'); onSaved?.(data.active);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save your settings.'); }
    finally { setBusy(false); }
  }
  async function preview() {
    setPreviewBusy(true); setError(''); setExample('');
    try { const data = await request<{ reply: string }>('/preview', { instructions: instructions.trim(), sample_message: sample.trim() }); setExample(data.reply); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create an example reply.'); }
    finally { setPreviewBusy(false); }
  }
  const status = !saved ? 'Loading…' : saved.active ? 'Active' : saved.enabled && saved.ends_at && new Date(saved.ends_at).getTime() <= Date.now() ? 'Expired' : saved.enabled && saved.starts_at && new Date(saved.starts_at).getTime() > Date.now() ? 'Scheduled' : 'Off';
  return <section className="member-chat-away" aria-label={brandText("People Buddy away assistant")}>
    <Toolbar as="header" className="member-chat-away-heading"><button type="button" onClick={onBack} aria-label="Back to messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg></button><div><h2>People {brandText("Buddy")} away assistant</h2><p>Let People {brandText("Buddy")} reply while you’re away</p></div><span className={saved?.active ? 'is-active' : ''}>{status}</span></Toolbar>
    <div className="member-chat-away-scroll">
      {error && <p className="member-chat-away-error" role="alert">{error}{!saved && <button type="button" onClick={() => setLoadVersion(value => value + 1)}>Retry</button>}</p>}
      {!saved && !error && <p role="status">Loading your settings…</p>}
      {saved && <form onSubmit={save}>
        {!saved.ready && <p className="member-chat-away-info">People {brandText("Buddy")}’s away replies are currently unavailable. You can still turn off an existing schedule.</p>}
        <label className="member-chat-away-toggle"><span className="sr-only">Away reply setting: </span><input type="checkbox" checked={enabled} disabled={busy || (!saved.ready && !enabled)} onChange={event => { setEnabled(event.target.checked); setNotice(''); }} /><span><strong>Reply automatically while I’m away</strong><small>Only enabled after you save.</small></span></label>
        <label className="member-chat-away-field">What should People {brandText("Buddy")} know?<textarea maxLength={4000} rows={5} value={instructions} disabled={busy} onChange={event => { setInstructions(event.target.value); setExample(''); setNotice(''); }} placeholder="I’m away until 4 pm. Let people know I’ll follow up tomorrow. For urgent requests, ask them to contact the service desk. Keep replies warm and concise." /><small>Only include information People {brandText("Buddy")} may share. Add your availability, tone and what it may say. {instructions.length}/4000</small></label>
        <div className="member-chat-away-dates"><label className="member-chat-away-field">Start <span>(blank = now)</span><input type="datetime-local" value={start} disabled={busy} onChange={event => { setStart(event.target.value); setNotice(''); }} /></label><label className="member-chat-away-field">End<input type="datetime-local" value={end} disabled={busy} onChange={event => { setEnd(event.target.value); setNotice(''); }} /></label></div>
        <div className="member-chat-away-presets"><span>End in</span>{[1, 4, 8].map(hours => <button key={hours} type="button" disabled={busy} onClick={() => { setEnd(localDate(new Date(Date.now() + hours * 3600000).toISOString())); setNotice(''); }}>{hours}h</button>)}</div>
        <p className="member-chat-away-help">Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}. Choose an end within seven days.</p>
        <div className="member-chat-away-info"><strong>Personal replies, with clear boundaries</strong><p>People {brandText("Buddy")} writes a fresh reply from the incoming direct message and your instructions. Wording can vary. Your notes, files and assistant history are not included.</p><p>Direct messages only. Every reply is labeled automatic. At most one reply per conversation each minute. Replies stop at the end time or when you reply yourself in that conversation.</p></div>
        <details className="member-chat-away-preview"><summary>Try an example reply</summary><label className="member-chat-away-field">Example incoming message<textarea rows={2} maxLength={2000} value={sample} onChange={event => { setSample(event.target.value); setExample(''); }} placeholder="Hi, are you available to discuss this today?" /></label><button className="member-chat-away-secondary" type="button" disabled={!saved.ready || !instructions.trim() || !sample.trim() || previewBusy || busy} onClick={preview}>{previewBusy ? 'Writing example…' : 'Generate example'}</button><small>This preview never sends a message or enables replies.</small>{example && <div className="member-chat-away-example"><strong>Example automatic reply</strong><p>{example}</p></div>}</details>
        {saved.error && <p className="member-chat-away-error" role="status">{saved.error}</p>}
        {notice && <p className="member-chat-away-success" role="status">{notice}</p>}
        <button className="member-chat-away-save" type="submit" disabled={busy || previewBusy || (enabled && !saved.ready)}>{busy ? 'Saving…' : enabled ? brandText('Enable People Buddy while away') : 'Save — replies off'}</button>
      </form>}
    </div>
  </section>;
}
