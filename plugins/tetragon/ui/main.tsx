import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, TextInput, TextArea, RadioButton, RadioButtonGroup, InlineNotification, InlineLoading, Tabs, TabList, Tab, TabPanels, TabPanel, Tag, Tile, Search, Modal, CodeSnippet, Accordion, AccordionItem, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, SkipToContent, Theme } from '@carbon/react';
import { Security, Renew, Add, Download, ArrowLeft, Document, Terminal, CheckmarkOutline } from '@carbon/icons-react';
import './style.scss';
import { startAppearance } from '../../../web/src/lib/appearance';

startAppearance();

type Kind = 'file' | 'exec';
type Rule = { id: string; name: string; kind: Kind; paths: string[]; binaries: string[]; revision: number; enabled: boolean; attempted?: boolean; last_error?: string; policy_name?: string };
type EnginePolicy = { name: string; state: string; mode?: string; error?: string };
type Status = { connected: boolean; message: string; policies: EnginePolicy[] };
type Audit = { actor?: string; action?: string; created_at?: string; timestamp?: string; outcome?: string; rule_id?: string; target?: string; [key: string]: unknown };
type Draft = { name: string; kind: Kind; paths: string; binaries: string };
const emptyDraft: Draft = { name: '', kind: 'file', paths: '', binaries: '' };
async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api/tetragon${path}`, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((e: {msg?: string}) => e.msg || 'Invalid field').join('; ') : 'The request failed. Refresh status and try again.');
  return data;
}
function lines(value: string) { return value.split('\n').map(s => s.trim()).filter(Boolean); }
function App() {
  const [rules, setRules] = useState<Rule[]>([]), [audit, setAudit] = useState<Audit[]>([]);
  const [status, setStatus] = useState<Status | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Rule | null>(null), [draft, setDraft] = useState<Draft>(emptyDraft);
  const [preview, setPreview] = useState<{ yaml: string; signature: string } | null>(null);
  const [confirmation, setConfirmation] = useState<'apply' | 'remove' | 'delete' | null>(null);
  const body = { name: draft.name.trim(), kind: draft.kind, paths: lines(draft.paths), binaries: lines(draft.binaries) };
  const signature = JSON.stringify(body), validPreview = preview?.signature === signature;
  async function refresh() {
    const results = await Promise.allSettled([request<Status>('/status'), request<{rules: Rule[]; audit?: Audit[]}>('/rules')]);
    if (results[0].status === 'fulfilled') setStatus(results[0].value);
    else { setStatus(null); throw results[0].reason; }
    if (results[1].status === 'fulfilled') { const data = results[1].value; setRules(data.rules); setAudit(data.audit || []); setSelected(previous => previous ? data.rules.find(rule => rule.id === previous.id) || null : null); }
    else throw results[1].reason;
  }
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'The request failed.'); } finally { setBusy(false); } }
  useEffect(() => { void run(refresh).finally(() => setLoading(false)); }, []);
  function select(rule: Rule | null) { setSelected(rule); setDraft(rule ? { name: rule.name, kind: rule.kind, paths: rule.paths.join('\n'), binaries: rule.binaries.join('\n') } : emptyDraft); setPreview(null); setNotice(''); }
  const enginePolicy = selected && status?.policies?.find(p => p.name === (selected.policy_name || `buddy-${selected.id}`) || p.name === selected.id);
  const engineState = enginePolicy?.state || (status?.connected ? 'Not loaded' : 'Unknown');
  const engineLoaded = !!enginePolicy && enginePolicy.state === 'enabled' && enginePolicy.mode === 'enforce' && !enginePolicy.error;
  async function previewRule() { await run(async () => { const data = selected ? await request<{yaml: string}>(`/rules/${encodeURIComponent(selected.id)}/policy`) : await request<{yaml: string}>('/preview', body); setPreview({ yaml: data.yaml, signature }); }); }
  async function save(event: React.FormEvent) { event.preventDefault(); if (!validPreview || selected) return; await run(async () => { const saved = await request<Rule>('/rules', body); await refresh(); setSelected(saved); setNotice('Draft saved. Apply it to load the blocking policy into Tetragon.'); }); }
  async function mutate() {
    if (!selected || !confirmation) return;
    const action = confirmation; setConfirmation(null);
    await run(async () => {
      if (action === 'delete') { await request(`/rules/${encodeURIComponent(selected.id)}?expected_revision=${selected.revision}`, undefined, 'DELETE'); select(null); }
      else { try { await request(`/rules/${encodeURIComponent(selected.id)}/${action}`, { expected_revision: selected.revision }); } catch (failure) { await refresh().catch(() => {}); throw failure; } }
      await refresh();
      const latest = await request<{rules: Rule[]}>('/rules');
      if (action !== 'delete') { const updated = latest.rules.find(r => r.id === selected.id); if (updated) setSelected(updated); }
      setNotice(action === 'apply' ? 'Policy application requested. Check the engine state below; a loaded policy still needs a blocking test.' : action === 'remove' ? 'Policy removal requested. Check the engine state before relying on removal.' : 'Draft deleted.');
    });
  }
  function download() { if (!preview) return; const url = URL.createObjectURL(new Blob([preview.yaml], {type: 'application/yaml'})); const a = document.createElement('a'); a.href = url; a.download = 'buddy-tetragon-policy.yaml'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  const filtered = rules.filter(r => `${r.name} ${r.paths.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return <Theme theme="white"><SkipToContent href="#main">Skip to rule management</SkipToContent><header className="topbar"><a className="brand" href="/"><Security size={24}/><span><strong>Buddy</strong></span></a><Tag type="purple">Security plugin</Tag><Button kind="ghost" size="sm" href="/" renderIcon={ArrowLeft}>Back to Buddy</Button></header><main id="main" tabIndex={-1}>
    <div className="page-heading"><div><p className="eyebrow">RUNTIME SECURITY / DOCKER HOST</p><h1>Tetragon rules</h1><p className="intro">Control what agent processes can open and execute.</p></div><Button kind="tertiary" size="md" renderIcon={Renew} disabled={busy} onClick={() => void run(refresh)}>Refresh status</Button></div>
    <Tile className="connection"><Security size={32}/><div><h2>{loading ? 'Checking Tetragon connection…' : status?.connected ? 'Connected to the host engine' : 'Tetragon is not connected'}</h2><p>{status?.message || (loading ? 'Reading engine status.' : 'Engine status is unavailable. Rules cannot be applied until the connection is restored.')}</p></div><Tag type={status?.connected ? 'green' : 'gray'}>{loading ? 'Checking' : status?.connected ? 'Connected' : 'Unavailable'}</Tag></Tile>
    {error && <InlineNotification kind="error" title="Request failed" subtitle={error} onCloseButtonClick={() => setError('')} lowContrast/>}{notice && <InlineNotification kind="info" title="Rule update" subtitle={notice} onCloseButtonClick={() => setNotice('')} lowContrast/>}
    <Tabs><TabList aria-label="Security views" contained><Tab>Rules</Tab><Tab>Change history</Tab><Tab>Supported controls</Tab></TabList><TabPanels><TabPanel><div className="workspace">
      <section className="rule-library" aria-labelledby="library-title"><div className="section-heading"><div><p className="eyebrow">POLICY LIBRARY</p><h2 id="library-title">Your rules <Tag type="gray">{rules.length}</Tag></h2></div><Button size="sm" kind="ghost" renderIcon={Add} disabled={busy} onClick={() => select(null)}>New rule</Button></div><Search id="rule-search" labelText="Find a rule" placeholder="Find a rule or target path" value={search} onChange={e => setSearch(e.target.value)} size="lg"/>
        {loading ? <InlineLoading description="Loading saved rules…"/> : filtered.length === 0 ? <div className="empty"><Document size={32}/><h3>{rules.length ? 'No matching rules' : 'No rules yet'}</h3><p>{rules.length ? 'Try a different search.' : 'Create a narrow rule, review its policy, then apply it to the host engine.'}</p></div> : <ul className="rule-cards">{filtered.map(rule => { const policy = status?.policies?.find(p => p.name === (rule.policy_name || `buddy-${rule.id}`) || p.name === rule.id); return <li key={rule.id}><button type="button" disabled={busy} className={`rule-card ${selected?.id === rule.id ? 'selected' : ''}`} aria-pressed={selected?.id === rule.id} onClick={() => select(rule)}><span className="rule-card-title">{rule.kind === 'file' ? <Document size={20}/> : <Terminal size={20}/>}<strong>{rule.name}</strong></span><span className="rule-card-meta">{rule.kind === 'file' ? 'File access' : 'Program execution'} · Revision {rule.revision}</span><code>{rule.paths[0]}{rule.paths.length > 1 ? ` +${rule.paths.length - 1}` : ''}</code><Tag type={policy ? 'blue' : 'gray'}>{!status?.connected ? 'Engine unknown' : policy?.state || 'Saved draft'}</Tag></button></li>; })}</ul>}
      </section>
      <Tile className="editor"><div className="section-heading"><div><p className="eyebrow">{selected ? 'REVIEW RULE' : 'CREATE A RULE'}</p><h2>{selected ? selected.name : 'Define the boundary'}</h2></div><Tag type="gray">{selected ? `Revision ${selected.revision}` : 'Not saved'}</Tag></div>
        <form onSubmit={save}><TextInput id="rule-name" labelText="Rule name" placeholder="Protect agent credentials" value={draft.name} maxLength={80} required disabled={!!selected || busy} onChange={e => setDraft({...draft, name: e.target.value})}/>
        <RadioButtonGroup legendText="What should be blocked?" name="kind" valueSelected={draft.kind} disabled={!!selected || busy} onChange={value => setDraft({...draft, kind: value as Kind})}><RadioButton id="kind-file" value="file" labelText="File access"/><RadioButton id="kind-exec" value="exec" labelText="Program execution"/></RadioButtonGroup>
        <TextArea id="target-paths" labelText={draft.kind === 'file' ? 'Protected file paths' : 'Blocked executable paths'} helperText="One absolute path per line. Exact matches; no wildcards." value={draft.paths} rows={4} required disabled={!!selected || busy} placeholder={draft.kind === 'file' ? '/run/secrets/agent-credential' : '/usr/bin/unwanted-program'} onChange={e => setDraft({...draft, paths: e.target.value})}/>
        <TextArea id="process-binaries" labelText="Process scope" helperText="Absolute executable paths of matching processes, one per line. Binary scope spans the host; it is not a Docker container selector." value={draft.binaries} rows={3} required disabled={!!selected || busy} placeholder="/usr/bin/python3.12" onChange={e => setDraft({...draft, binaries: e.target.value})}/>
        <InlineNotification kind="warning" title="Review the process scope" subtitle="Other host processes using the same executable may match. Blocking Buddy’s runtime or shell can interrupt legitimate work." hideCloseButton lowContrast/>
        <div className="form-actions"><Button kind="tertiary" size="md" disabled={busy} onClick={() => void previewRule()}>Preview policy</Button>{!selected && <Button type="submit" size="md" disabled={busy || !validPreview}>Save draft</Button>}</div>{!selected && <p className="field-note">Preview this configuration before saving. A saved draft does not block anything.</p>}
        </form>
        {selected && <div className="saved-actions"><div className="engine-state"><span>Reported engine state</span><Tag type={engineLoaded ? 'blue' : 'gray'}>{engineState}</Tag></div>{(enginePolicy?.error || selected.last_error) && <InlineNotification kind="error" title="Engine policy error" subtitle={enginePolicy?.error || selected.last_error} hideCloseButton lowContrast/>}<div className="form-actions"><Button size="md" disabled={busy || !status?.connected || engineLoaded} onClick={() => setConfirmation('apply')}>Apply blocking rule</Button><Button size="md" kind="tertiary" disabled={busy || !status?.connected || (!enginePolicy && !selected.enabled)} onClick={() => setConfirmation('remove')}>Remove from engine</Button><Button size="md" kind="danger--ghost" disabled={busy || selected.enabled || !!enginePolicy} onClick={() => setConfirmation('delete')}>Delete draft</Button></div><p className="field-note">Reported mode: {enginePolicy?.mode || 'Not reported'}. A loaded policy is not a verified block. Test the forbidden operation with synthetic data on the target host.</p><p className="field-note">To change targets, create and review a new rule. Remove the old rule only after validating its replacement.</p></div>}
        {busy && <InlineLoading description="Processing rule request…"/>}{preview && <Accordion><AccordionItem title="Generated Tetragon policy" open><CodeSnippet type="multi" hideCopyButton>{preview.yaml}</CodeSnippet><Button kind="ghost" size="sm" renderIcon={Download} onClick={download}>Download YAML</Button></AccordionItem></Accordion>}
      </Tile>
    </div></TabPanel><TabPanel><Tile className="history"><p className="eyebrow">ADMINISTRATIVE CHANGES</p><h2>Change history</h2><p className="intro">Recorded rule-management actions. This is not a stream of blocked operations.</p>{audit.length ? <div className="table-scroll"><Table aria-label="Rule change history"><TableHead><TableRow><TableHeader>When</TableHeader><TableHeader>Actor</TableHeader><TableHeader>Action</TableHeader><TableHeader>Outcome</TableHeader><TableHeader>Rule</TableHeader></TableRow></TableHead><TableBody>{audit.map((event, i) => <TableRow key={i}><TableCell>{String(event.created_at || event.timestamp || 'Not reported')}</TableCell><TableCell>{event.actor || 'Not reported'}</TableCell><TableCell>{event.action || 'Not reported'}</TableCell><TableCell>{event.outcome || 'Not reported'}</TableCell><TableCell>{event.rule_id || event.target || 'Not reported'}</TableCell></TableRow>)}</TableBody></Table></div> : <div className="empty"><CheckmarkOutline size={32}/><h3>No changes recorded</h3><p>Rule-management activity will appear here when returned by the service.</p></div>}</Tile></TabPanel><TabPanel><Tile className="guide"><p className="eyebrow">RULE DESIGN</p><h2>Start with narrow, testable controls</h2><div className="guide-grid">{[
          ['Available', 'Exact file access', 'Reject new opens of selected files for matching processes. Already-open descriptors, other paths to the same data and other access mechanisms need separate validation.'],
          ['Available', 'Exact executable launches', 'Reject launching the selected program for the configured process scope. Renamed binaries, interpreters and alternate execution paths need additional controls.'],
          ['Separate control', 'Network blocking', 'Use host or container egress firewall rules for destination IPs and ports. Domain allowlists need a suitable egress gateway. This screen does not apply network rules.'],
          ['Excluded', 'Arbitrary kernel hooks', 'No raw kernel-hook editor, blanket namespace blocking, or claim that runtime policies detect prompt injection. Action approvals stay in Buddy’s execution broker.'],
        ].map(([label, title, copy]) => <article key={title}><Tag type={label === 'Available' ? 'green' : 'gray'}>{label}</Tag><h3>{title}</h3><p>{copy}</p></article>)}</div><p className="field-note">Blocking returns an error from a supported hook rather than relying on killing a process. These rules require BPF LSM support and bpf in the host’s active LSM list (/sys/kernel/security/lsm). Kernel support and real engine status must be checked before trusting protection.</p><a href="https://tetragon.io/docs/concepts/enforcement/" target="_blank" rel="noreferrer">Tetragon blocking semantics ↗</a></Tile></TabPanel></TabPanels></Tabs>
    <Modal open={!!confirmation} modalHeading={confirmation === 'apply' ? 'Apply this blocking rule?' : confirmation === 'remove' ? 'Remove this rule from Tetragon?' : 'Delete this saved draft?'} primaryButtonText={confirmation === 'apply' ? 'Apply rule' : confirmation === 'remove' ? 'Remove rule' : 'Delete draft'} secondaryButtonText="Cancel" danger={confirmation !== 'apply'} onRequestClose={() => setConfirmation(null)} onRequestSubmit={() => void mutate()} selectorPrimaryFocus=".cds--btn--secondary"><p>{confirmation === 'apply' ? 'The host engine will reject matching operations. Review these exact targets and process paths before continuing.' : confirmation === 'remove' ? 'This removes the rule from the engine. Matching operations will no longer be blocked by this rule.' : 'The draft will be permanently deleted.'}</p><div className="confirm-scope"><strong>{selected?.name}</strong><p>Targets</p><pre>{selected?.paths.join('\n')}</pre><p>Process scope</p><pre>{selected?.binaries.join('\n')}</pre></div></Modal>
  </main></Theme>;
}
createRoot(document.getElementById('root')!).render(<App/>);
