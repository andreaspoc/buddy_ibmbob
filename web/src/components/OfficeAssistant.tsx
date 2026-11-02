import { brandText } from '../lib/brand';
import { AppCollaborationActivity, readAppCollaboration, type AppCollaboration } from './AppCollaborationActivity';
import { DeleteQuestionButton } from './DeleteQuestionButton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLanguage, t, useLanguage } from '../lib/i18n';
import type { OfficeAction, OfficeBridge, OfficeContext, OfficePlan } from '../lib/officeBridge';
import { appConfirm } from './AppDialog';
import { navigateOffice } from '../lib/officeUrl';
import { MarkdownView } from './MarkdownView';
import { TaskTools } from '@carbon/icons-react';
import './OfficeAssistant.css';

type PreviewBlock = { text?: string; rows?: string[][]; header?: boolean; font_color?: string; fill?: string; header_font_color?: string; header_fill?: string; alternate_fill?: string };
function WordBlockPreview({ block }: { block: PreviewBlock }) {
  if (!block.rows) return <p style={{ color: block.font_color, backgroundColor: block.fill }}>{block.text}</p>;
  return <table className="office-assistant-preview-table"><tbody>{block.rows.map((row, r) => {
    const header = r === 0 && block.header !== false;
    const bodyIndex = r - (block.header !== false ? 1 : 0);
    const fill = header ? block.header_fill || block.fill : bodyIndex % 2 === 1 ? block.alternate_fill || block.fill : block.fill;
    return <tr key={r}>{row.map((value, c) => header
      ? <th key={c} style={{ color: block.header_font_color || block.font_color, backgroundColor: fill }}>{value}</th>
      : <td key={c} style={{ color: block.font_color, backgroundColor: fill }}>{value}</td>)}</tr>;
  })}</tbody></table>;
}
type Turn = { collaborations?: AppCollaboration[]; id: string; prompt: string; reply: string; plan?: OfficePlan; context?: OfficeContext; state: 'working' | 'preview' | 'applied' | 'discarded' | 'cancelled' | 'error'; error?: string };
const editorNames: Record<string, string> = { docx: 'Word', xlsx: 'Excel', csv: 'CSV', pptx: 'PowerPoint', pdf: 'PDF', html: 'HTML', htm: 'HTML' };
const actionNames: Record<string, string> = {
  insert_blocks: 'Insert content', replace_document: 'Replace document content', set_header: 'Set page header',
  set_footer: 'Set footer and page numbers', set_page_layout: 'Set page layout', set_cells: 'Write cells and formulas',
  format_range: 'Format cells', add_sheet: 'Add worksheet', set_print_header_footer: 'Set print header and footer',
  edit_chart: 'Update native chart', sort_range: 'Sort rows', filter_range: 'Filter rows', create_table: 'Create native table', set_validation: 'Set input validation', conditional_format: 'Add conditional rule', freeze_panes: 'Freeze panes', range_dimensions: 'Resize rows and columns', sheet_options: 'Set worksheet options',
  slide_operation: 'Manage slide', add_slide_table: 'Insert slide table', add_slide_chart: 'Insert slide chart', add_slide_shape: 'Insert slide object', replace_slide_text: 'Replace object text', slide_object: 'Change slide object', add_word_chart: 'Insert Word chart',
  add_chart: 'Insert chart', autofit_columns: 'Auto-fit columns',
  html_update_text: 'Update presentation text', pdf_update_text: 'Update PDF text box', pdf_add_text: 'Add PDF text box', pdf_rotate_page: 'Rotate PDF page',
  add_slide: 'Add slide', update_slide: 'Update slide', clear_slides: 'Clear existing slides',
};
function describe(action: OfficeAction) {
  const worksheet = typeof action.sheet === 'string' ? action.sheet : 'current worksheet';
  const slide = typeof action.slide_index === 'number' ? `Slide ${action.slide_index}` : '';
  if (action.type === 'add_chart') return `${t('Insert chart')} · ${t('Destination')}: ${worksheet} · ${t('Source')}: ${action.range}${typeof action.from_col === 'number' ? ` · ${t('Column')}: ${action.from_col + 1}` : ''}`;
  if (action.type === 'edit_chart') return `${t('Update native chart')} · ${slide || (action.sheet ? worksheet : t('Current document'))} · ${t('Chart')} ${action.chart_index}${action.title ? ` · ${action.title}` : ''}`;
  if (action.type === 'slide_operation') return `${slide} · ${action.operation}${action.position ? ` → ${action.position}` : ''}`;
  if (action.type === 'slide_object') return `${slide} · ${t('Object')} ${action.shape_index} · ${action.operation}`;
  if (action.type === 'set_validation') return `${t('Set input validation')} · ${worksheet} ${action.range} · ${Array.isArray(action.options) && action.options.length ? action.options.join(', ') : t(({list:'Dropdown choices',whole:'Whole numbers',decimal:'Decimal values',date:'Dates',text_length:'Text length',custom:'Formula rule',remove:'Remove validation'} as Record<string,string>)[String(action.rule)] || String(action.rule))}`;
  if (action.type === 'freeze_panes') return `${worksheet} · ${action.unfreeze ? t('Unfreeze panes') : `${t('Freeze panes')}: ${action.rows} ${t('rows')}, ${action.columns} ${t('columns')}`}`;

  const details = typeof action.page === 'number' ? `Page ${action.page}${typeof action.text === 'string' ? ': ' + action.text : typeof action.angle === 'number' ? ': ' + action.angle + '°' : ''}` : typeof action.title === 'string' && action.title
    ? (action.range ? `${action.title} (${action.range})` : typeof action.slide_index === 'number' ? `Slide ${action.slide_index}: ${action.title}` : action.title)
    : typeof action.text === 'string' ? action.text : typeof action.range === 'string' ? action.range : typeof action.name === 'string' ? action.name : typeof action.slide_index === 'number' ? `Slide ${action.slide_index}` : '';
  const label = action.type === 'insert_blocks' && action.position === 'replace_selection' ? 'Replace selected text' : actionNames[action.type] || action.type;
  return `${t(label)}${details ? ` · ${details.slice(0, 100)}` : ''}${action.sheet && !details.includes(String(action.sheet)) ? ` · ${action.sheet}` : ''}`;
}
function ContextChoice({ selected, change, extension }: { extension: string; selected: 'document' | 'selection' | 'none'; change: (value: 'document' | 'selection' | 'none') => void }) {
  return <label className="office-assistant-context">{t('Include context')}<select value={selected} onChange={event => change(event.target.value as typeof selected)}>
    <option value="document">{t(extension === 'pptx' ? 'Current presentation' : ['xlsx','csv'].includes(extension) ? 'Current workbook' : 'Current document')}</option><option value="selection">{t(extension === 'pptx' ? 'Selected slide objects' : ['xlsx','csv'].includes(extension) ? 'Selected cells or chart' : 'Selected text')}</option><option value="none">{t('No document content')}</option>
  </select></label>;
}

export function OfficeAssistant({ fileId, extension, bridge, onBusy, onApplied }: {
  fileId: string; extension: string; bridge: OfficeBridge; onBusy: (busy: boolean) => void; onApplied: () => void;
}) {
  useLanguage();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [showLatest, setShowLatest] = useState(false);
  const [contextUsed, setContextUsed] = useState('');
  const [contextChoice, setContextChoice] = useState<'document' | 'selection' | 'none'>('document');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState('');
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [progress, setProgress] = useState('');
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);
  const callbacks = useRef({ onBusy, onApplied }); callbacks.current = { onBusy, onApplied };
  useEffect(() => { live.current = true; return () => { live.current = false; abort.current?.abort(); callbacks.current.onBusy(false); }; }, []);
  useEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns, progress]);
  const update = useCallback((id: string, value: Partial<Turn>) => {
    if (live.current) setTurns(current => current.map(turn => turn.id === id ? { ...turn, ...value } : turn));
  }, []);

  const deleteMessage = async (id: string, role: 'user' | 'assistant') => {
    if (busy || applying || deletingRef.current) return;
    deletingRef.current = true; setDeleting(true);
    try {
      if (!await appConfirm(t('Permanently delete this message from this chat and future follow-up context? This cannot be undone. Independently saved or exported copies remain.')) || !live.current) return;
      setTurns(current => current.flatMap(turn => {
        if (turn.id !== id) return [turn];
        const remaining: Turn = role === 'user' ? { ...turn, prompt: '' } : { ...turn, reply: '', plan: undefined, context: undefined, error: undefined, state: 'discarded' };
        return remaining.prompt || remaining.reply || remaining.plan || remaining.error ? [remaining] : [];
      }));
     
    } finally {
      deletingRef.current = false;
      if (live.current) setDeleting(false);
    }
  };

  const send = async (overridePrompt?: string) => {
    const instruction = (overridePrompt ?? prompt).trim();
    if (!instruction || busy || applying || deletingRef.current || !bridge.ready) return;
    const id = crypto.randomUUID();
    const controller = new AbortController(); abort.current = controller;
    setTurns(current => [...current.map(turn => turn.state === 'preview' ? { ...turn, state: 'discarded' as const } : turn), { id, prompt: instruction, reply: '', state: 'working' }]);
    if (!overridePrompt) setPrompt('');
    setBusy(true); callbacks.current.onBusy(true); setProgress('Reading document context…'); pinned.current = true;
    let receivedPlan = false;
    let snapshot: OfficeContext | undefined;
    let streamedReply = '';
    let queued = '';
    let flushTimer: number | undefined;
    const flush = () => { if (queued) { streamedReply += queued; queued = ''; update(id, { reply: streamedReply }); } flushTimer = undefined; };
    try {
      snapshot = await bridge.context();
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      setContextUsed(contextChoice === 'none' ? t('No document content') : snapshot.sheet ? `${snapshot.sheet} · ${snapshot.range || ''}` : snapshot.current_slide ? `${t('Slide')} ${snapshot.current_slide}${snapshot.slide_shapes?.some(shape => shape.selected) ? ` · ${snapshot.slide_shapes.filter(shape => shape.selected).length} ${t('selected objects')}` : ''}` : snapshot.selection ? t('Selected text') : t('Current document'));
      const context = {
        kind: snapshot.kind, truncated: snapshot.truncated === true, text: contextChoice === 'document' ? snapshot.text : '',
        selection: contextChoice !== 'none' ? snapshot.selection : '',
        ...(snapshot.sheets ? { sheets: snapshot.sheets } : {}),
        ...(Array.isArray(snapshot.workbook) && contextChoice === 'document' ? { workbook: snapshot.workbook } : {}),
        ...(typeof snapshot.header === 'string' && contextChoice === 'document' ? { header: snapshot.header } : {}),
        ...(typeof snapshot.footer === 'string' && contextChoice === 'document' ? { footer: snapshot.footer } : {}),
        ...(typeof snapshot.sheet === 'string' ? { sheet: snapshot.sheet } : {}),
        ...(snapshot.range ? { range: snapshot.range } : {}),
        ...(snapshot.values && contextChoice !== 'none' ? { values: snapshot.values } : {}),
        ...(snapshot.kind === 'html' ? {html_nodes: contextChoice === 'document' ? snapshot.html_nodes || [] : []} : {}),
        ...(snapshot.kind === 'pdf' ? { page_count: snapshot.page_count, pages: contextChoice === 'document' ? (snapshot.pages || []).map(page => ({ page: page.page, objects: page.objects })) : [], capabilities: snapshot.capabilities || [], text_available: snapshot.text_available !== false, truncated: snapshot.truncated === true } : {}),
        ...(typeof snapshot.slide_count === 'number' ? { slide_count: snapshot.slide_count } : {}),
        ...(typeof snapshot.current_slide === 'number' ? { current_slide: snapshot.current_slide } : {}),
        ...(Array.isArray(snapshot.charts) && contextChoice !== 'none' ? {charts: contextChoice === 'selection' ? snapshot.charts.filter(chart => chart.selected) : snapshot.charts} : {}),
        ...(Array.isArray(snapshot.editor_capabilities) ? {editor_capabilities: snapshot.editor_capabilities} : {}),
        ...(Array.isArray(snapshot.slide_shapes) && contextChoice !== 'none' ? {slide_shapes: contextChoice === 'selection' ? snapshot.slide_shapes.filter(shape => shape.selected) : snapshot.slide_shapes} : {}),
        ...(typeof snapshot.slide_width === 'number' ? {slide_width: snapshot.slide_width} : {}),
        ...(typeof snapshot.slide_height === 'number' ? {slide_height: snapshot.slide_height} : {}),
      };
      setProgress(brandText('Buddy is drafting…'));
      const response = await fetch(`/api/office/assistant/files/${fileId}/draft`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ prompt: instruction, ui_language: getLanguage(), context, context_mode: contextChoice,
          history: contextChoice === 'document' ? turns.filter(turn => (turn.prompt || turn.reply) && ['preview', 'applied', 'discarded'].includes(turn.state)).slice(-4).map(turn => ({ prompt: turn.prompt.slice(0, 2000), reply: turn.reply.slice(0, 4000), state: turn.state === 'applied' ? 'applied' : 'discarded' })) : [] }),
      });
      if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(typeof error.detail === 'string' ? error.detail : 'Bob could not start this request. Please retry.');
      }
      if (!response.body) throw new Error('Bob did not return a response stream.');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n'); buffer = lines.pop() || '';
          if (done && buffer.trim()) { lines.push(buffer); buffer = ''; }
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            const collaboration = readAppCollaboration(event);
            if (collaboration) {
              setTurns(current => current.map(turn => turn.id === id ? { ...turn, collaborations: [...(turn.collaborations || []).filter(item => item.call_id !== collaboration.call_id), collaboration] } : turn));
              setProgress(collaboration.message);
            } else if (event.type === 'delta' && typeof event.text === 'string') {
              queued += event.text;
              if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 70);
            } else if (event.type === 'plan') {
              if (flushTimer !== undefined) window.clearTimeout(flushTimer); flush();
              receivedPlan = true; const plan = event.plan as OfficePlan;
              update(id, { plan, context: snapshot, reply: plan.reply, state: plan.actions.length || plan.create_form ? 'preview' : 'applied' });
              setProgress('');
            } else if (event.type === 'status' && typeof event.message === 'string') {
              if (event.reset_reply === true) {
                queued = ''; streamedReply = '';
                if (flushTimer !== undefined) window.clearTimeout(flushTimer);
                flushTimer = undefined; update(id, { reply: '' });
              }
              setProgress(event.message);
            } else if (event.type === 'error') throw new Error(event.message || brandText('Buddy could not complete this request.'));
          }
          if (done) break;
        }
      } finally { reader.releaseLock(); }
      if (!receivedPlan) throw new Error('Bob stopped before completing the draft. Please retry.');
    } catch (failure) {
      const cancelled = controller.signal.aborted;
      if (!receivedPlan) {
        queued = ''; streamedReply = '';
        if (flushTimer !== undefined) window.clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      update(id, { state: cancelled ? 'cancelled' : 'error', ...(!receivedPlan ? { reply: '' } : {}), error: cancelled ? undefined : (failure as Error).message });
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, collaborations: turn.collaborations?.map(activity => activity.stage === 'started' ? { ...activity, stage: cancelled ? 'cancelled' : 'failed', message: `${activity.agent_name} ${cancelled ? 'was cancelled' : 'could not complete the task'}` } : activity) } : turn));
    } finally {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer); flush();
      if (abort.current === controller) abort.current = null;
      if (live.current) { setBusy(false); setProgress(''); callbacks.current.onBusy(false); }
    }
  };

  const apply = async (turn: Turn) => {
    if (!turn.plan || !turn.context || applying || busy || deletingRef.current || !bridge.ready) return;
    setApplying(turn.id); callbacks.current.onBusy(true);
    update(turn.id, { error: undefined });
    try {
      if (turn.plan.create_form) {
        const response = await fetch(`/api/office/assistant/files/${fileId}/create-form`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...turn.plan.create_form, request_id: turn.id }),
        });
        if (response.status === 401) window.dispatchEvent(new Event('buddy-auth-expired'));
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not create the form.');
        update(turn.id, { state: 'applied', reply: `${turn.reply}\n\n[Open saved form](/office/files/${encodeURIComponent(result.id)})` });
        window.dispatchEvent(new Event('buddy-office-changed'));
        navigateOffice(`/office/files/${encodeURIComponent(result.id)}`);
        return;
      }
      const result = await bridge.apply(turn.plan, turn.context);
      if (result.error || result.ok === false) throw new Error(result.error || 'The editor could not apply this draft.');
      update(turn.id, { state: 'applied' }); callbacks.current.onApplied();
    } catch (failure) { update(turn.id, { error: (failure as Error).message }); }
    finally { if (live.current) { setApplying(''); callbacks.current.onBusy(false); } }
  };

  const quickChips = ['html', 'htm'].includes(extension)
    ? [t('Summarize this presentation and suggest improvements'), t('Improve the slide headings'), t('Rewrite the presentation text professionally')]
    : extension === 'pdf'
    ? [t('Summarize this PDF and its key takeaways'), t('Add a text box on page 1 with a short summary'), t('Rotate page 1 to 90 degrees')]
    : ['docx', 'html', 'htm'].includes(extension)
    ? [
        { label: t('Create an invoice'), prompt: t('Help me create a custom invoice in this document. Ask me for the missing seller and customer details, invoice number, dates, currency, line items, quantities, prices, tax rates, and payment instructions. Use only the details I provide, calculate totals, and prepare an invoice table for review before applying.') },
        t('Summarize this document and key takeaways'),
        t('Draft a short report with a title, headings, a page header, and page numbers in the footer.'),
        t('Rewrite the selected text professionally'),
      ]
    : extension === 'pptx'
    ? [
        {label: t('Edit selected object'), prompt: t('Review the currently selected slide object. Ask what change I want if unclear, then edit only that object and preserve every other slide object.')},
        {label: t('Add a chart or table'), prompt: t('Help me add a native editable chart or table to the current slide. Use the supplied context, ask for missing source data, and preserve all existing slide objects.')},
        t('Create a 5-slide executive presentation with title, agenda, key metrics, and next steps'),
        t('Summarize the slides in this deck and suggest improvements'),
        t('Add a slide with key takeaways and action items'),
      ]
    : [
        {label: t('Add selectable dropdowns'), prompt: t('Help me add native dropdown choices to the currently selected cells. Ask what choices are needed if I have not supplied them, and preserve the current data and formulas.')},
        {label: t('Organize selected data'), prompt: t('Review the current worksheet and selected cells. Help me sort or filter the complete related rows and freeze the header without changing data or formulas. Ask what result I want if unclear.')},
        { label: t('Create an invoice'), prompt: t('Help me create a custom invoice worksheet with formulas for line totals, subtotal, supplied tax rates, and amount due. Ask for missing billing details and amounts first. Do not invent invoice numbers, tax rates, or payment details.') },
        t('Analyze this dataset: show key insights, top categories, and a bar chart'),
        t('Build a summary sheet with formulas and insert a bar chart'),
        t('What are the trends over time in this data? Include a line chart'),
      ];

  return <aside className="office-assistant" aria-label={t('Ask Buddy')}>
    <header className="office-assistant-header"><div className="office-assistant-brand"><span className="office-assistant-avatar" aria-hidden="true"><TaskTools size={24} /></span><div><strong className="office-assistant-title">{t('Buddy')}</strong><small className="office-assistant-subtitle">{editorNames[extension] || extension.toUpperCase()} · {t('Ask Buddy')}</small></div></div><span className={`office-assistant-connection ${bridge.ready ? 'is-ready' : ''}`} role="status">{t(bridge.ready ? 'Connected' : 'Connecting…')}</span></header>
    <div ref={log} className="office-assistant-log" role="log" aria-live="off" onScroll={() => { if (log.current) { pinned.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 40; setShowLatest(!pinned.current); } }}>
      {!turns.length && <div className="office-assistant-intro"><span>{t('Your document, your instructions.')}</span><p>{t(['html', 'htm'].includes(extension) ? 'Ask Buddy about your slides or request text edits. Layout, scripts, and charts are preserved.' : extension === 'pdf' ? 'Ask Buddy about your PDF, draft improved text, add text boxes, or rotate pages. Review edits before applying.' : ['docx', 'html', 'htm'].includes(extension) ? 'Ask Buddy to draft a report, add page headers and numbers, create tables, or improve selected text.' : extension === 'pptx' ? 'Ask Buddy to build a slide deck, update slide titles and bullet points, add speaker notes, or summarize your presentation.' : 'Ask Buddy questions about your data, generate interactive charts, write formulas, organize cells, format ranges, or add summary worksheets.')}</p>
        <div className="office-assistant-chips">
          <button onClick={() => { setPrompt(t(['html', 'htm'].includes(extension) ? 'Improve the slide headings and keep their meaning.' : extension === 'pdf' ? 'Add a text box on page 1 saying Draft for review.' : ['docx', 'html', 'htm'].includes(extension) ? 'Draft a short report with a title, headings, a page header, and page numbers in the footer.' : extension === 'pptx' ? 'Create a 4-slide project status presentation with executive summary, milestones, risks, and next steps.' : 'Create a small budget table with totals and formulas.')); input.current?.focus(); }}>{t('Try an example')}</button>
          {quickChips.map((chip, idx) => <button key={idx} className="office-assistant-chip" disabled={busy || !bridge.ready} onClick={() => { setPrompt(typeof chip === 'string' ? chip : chip.prompt); input.current?.focus(); }}>{typeof chip === 'string' ? chip : chip.label}</button>)}
        </div>
      </div>}
      {turns.map(turn => <article key={turn.id} className={`office-assistant-turn state-${turn.state}`}>{turn.prompt && <div className="office-assistant-user">{turn.prompt}<DeleteQuestionButton disabled={busy || !!applying || deleting} onClick={() => void deleteMessage(turn.id, 'user')} /></div>}{(turn.reply || turn.plan || turn.error || turn.state === 'working' || turn.state === 'cancelled') && <div className="office-assistant-reply"><strong>{t('Buddy')}</strong><AppCollaborationActivity activities={turn.collaborations || []} />{turn.reply ? <div className="office-assistant-text"><MarkdownView content={turn.reply} isStreaming={turn.state === 'working'} compactDiagrams onPrompt={p => void send(p)} /></div> : turn.state === 'working' ? <div className="office-assistant-skeleton" aria-hidden="true"><i/><i/><i/></div> : null}
        {turn.plan?.create_form && <div className="office-assistant-preview"><strong>{turn.plan.create_form.title}</strong><p>{turn.plan.create_form.description}</p><ul>{turn.plan.create_form.fields.map(field => <li key={field.name}>{field.label}{field.required ? ' *' : ''} — {field.type || 'text'}{field.options?.length ? `: ${field.options.join(', ')}` : ''}</li>)}</ul>{turn.state === 'preview' && <div className="office-assistant-actions"><button className="office-primary feature-primary" disabled={!!applying || busy || deleting} onClick={() => void apply(turn)}>{applying === turn.id ? t('Creating…') : t('Create form')}</button><button disabled={!!applying || deleting} onClick={() => update(turn.id, { state: 'discarded' })}>{t('Discard')}</button></div>}</div>}
        {turn.plan && !!turn.plan.actions.length && <div className="office-assistant-preview"><span>{t('Proposed edits')}</span><ul>{turn.plan.actions.map((action, index) => <li key={index}>{describe(action)}</li>)}</ul>
          {turn.state === 'preview' && <><details><summary>{t('Preview document content')}</summary><div className="office-assistant-plan-content">{turn.plan.actions.map((action, index) => <div key={index}>{Array.isArray(action.blocks) ? (action.blocks as PreviewBlock[]).map((block, blockIndex) => <WordBlockPreview key={blockIndex} block={block} />) : Array.isArray(action.bullets) ? <div><strong>{String(action.title || '')}</strong>{action.subtitle ? <div><em>{String(action.subtitle)}</em></div> : null}{(action.bullets as string[]).map((b, bi) => <p key={bi}>• {b}</p>)}</div> : Array.isArray(action.values) ? JSON.stringify(action.values) : typeof action.text === 'string' ? action.text : describe(action)}</div>)}</div></details>
          {turn.plan.actions.some(action => action.type === 'replace_document' || action.type === 'clear_slides') && <p className="office-assistant-replace-warning" role="alert">{t('This draft replaces the existing document or slide content.')}</p>}
          <div className="office-assistant-actions"><button className="office-primary feature-primary" disabled={!!applying || busy || deleting || !bridge.ready} onClick={() => void apply(turn)}>{t(applying === turn.id ? 'Applying…' : turn.plan.actions.some(action => action.type === 'replace_document' || action.type === 'clear_slides') ? 'Replace document' : 'Apply to document')}</button><button disabled={!!applying || deleting} onClick={() => { update(turn.id, { state: 'discarded' }); }}>{t('Discard')}</button></div></>}
          {turn.state === 'applied' && <span className="office-assistant-applied">{t('Applied in the editor · Save to Office Suite to keep these changes')}</span>}
          {turn.state === 'discarded' && <span>{t('Draft discarded')}</span>}
        </div>}
        {turn.state === 'cancelled' && <p>{t('Request cancelled')}</p>}{turn.error && <div className="office-assistant-error" role="alert">{t(turn.error)}</div>}
        <div className="office-assistant-actions"><button type="button" disabled={busy || !!applying || deleting} onClick={() => void deleteMessage(turn.id, 'assistant')}>{t('Delete answer')}</button></div>
      </div>}</article>)}
      {busy && <div className="office-assistant-progress" role="status"><span/>{t(progress || 'Buddy is drafting…')}</div>}
    </div>
    {showLatest && <button type="button" className="office-assistant-latest" onClick={() => { pinned.current = true; setShowLatest(false); log.current?.scrollTo({top:log.current.scrollHeight,behavior:'instant'}); }}>{t('Jump to latest')} ↓</button>}
    <form className="office-assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}><ContextChoice selected={contextChoice} change={setContextChoice} extension={extension}/>{contextUsed && <p className="office-assistant-context-used">{t('Last request context')}: {contextUsed}</p>}<textarea ref={input} aria-label={t('Instructions for Buddy')} value={prompt} maxLength={12000} rows={2} placeholder={t(['html', 'htm'].includes(extension) ? 'Ask about these slides or describe a text edit…' : extension === 'pdf' ? 'Ask about this PDF or describe an edit…' : ['docx', 'html', 'htm'].includes(extension) ? 'Describe what you want in this document…' : extension === 'pptx' ? 'Describe slides to add, edit, or summarize…' : 'Ask a question, request a chart, or describe spreadsheet edits…')} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void send(); } }}/><div><small>{t('Review edits before applying. Your file stays open.')}</small>{busy ? <button type="button" onClick={() => abort.current?.abort()}>{t('Cancel')}</button> : <button className="office-primary feature-primary" disabled={!prompt.trim() || !!applying || deleting || !bridge.ready} type="submit">{t('Send to Buddy')}</button>}</div></form>
  </aside>;
}
