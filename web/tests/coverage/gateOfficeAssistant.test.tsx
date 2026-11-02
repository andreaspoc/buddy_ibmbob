// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OfficeAssistant } from '../../src/components/OfficeAssistant';
import { appConfirm } from '../../src/components/AppDialog';
import { navigateOffice } from '../../src/lib/officeUrl';

vi.mock('../../src/components/AppDialog', () => ({ appConfirm: vi.fn() }));
vi.mock('../../src/lib/officeUrl', () => ({ navigateOffice: vi.fn() }));
vi.mock('../../src/components/MarkdownView', () => ({
  MarkdownView: ({ content, onPrompt }: { content: string; onPrompt: (p: string) => void }) => (
    <div data-testid="reply">{content}<button type="button" onClick={() => onPrompt('Follow up prompt')}>follow-up</button></div>
  ),
}));

let host: HTMLDivElement;
let root: Root;
const onBusy = vi.fn();
const onApplied = vi.fn();
const encoder = new TextEncoder();

type Bridge = React.ComponentProps<typeof OfficeAssistant>['bridge'];
const makeBridge = (over: Partial<Bridge> = {}): Bridge => ({
  ready: true,
  context: vi.fn().mockResolvedValue({ kind: 'word', text: 'Doc text', selection: 'Sel' }),
  apply: vi.fn().mockResolvedValue({ ok: true }),
  ...over,
} as Bridge);

function streamResponse(events: unknown[], status = 200) {
  const chunks = events.map(e => encoder.encode((typeof e === 'string' ? e : JSON.stringify(e)) + '\n'));
  return {
    ok: status < 400,
    status,
    body: {
      getReader: () => ({
        read: () => Promise.resolve(chunks.length ? { value: chunks.shift(), done: false } : { value: undefined, done: true }),
        releaseLock: () => undefined,
      }),
    },
  };
}
const planEvent = (actions: unknown[], extra: object = {}) => ({ type: 'plan', plan: { kind: 'word', reply: 'Here is the plan', actions, ...extra } });
const respondWith = (...events: unknown[]) => { vi.mocked(fetch).mockResolvedValueOnce(streamResponse(events) as never); };
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

async function render(extension = 'docx', bridge = makeBridge()) {
  await act(async () => {
    root.render(<OfficeAssistant fileId="f1" extension={extension} bridge={bridge} onBusy={onBusy} onApplied={onApplied} />);
  });
  return bridge;
}
const textarea = () => host.querySelector('textarea')!;
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
const select = () => host.querySelector<HTMLSelectElement>('.office-assistant-context select')!;
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
function type(value: string) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function chooseContext(value: string) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select(), value);
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function ask(text = 'Do it') {
  await type(text);
  await click(button('Send to Buddy')!);
  await flush();
}
const sentBody = (call = 0) => JSON.parse(vi.mocked(fetch).mock.calls[call][1]!.body as string);
const proposals = () => Array.from(host.querySelectorAll('.office-assistant-preview li')).map(li => li.textContent);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn());
  vi.mocked(appConfirm).mockReset();
  vi.mocked(navigateOffice).mockReset();
  onBusy.mockReset();
  onApplied.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OfficeAssistant intro per editor', () => {
  it.each([
    ['html', 'HTML', 'Improve the slide headings', 'Ask about these slides', 'Current document', 'Improve the slide headings and keep their meaning.'],
    ['htm', 'HTML', 'Rewrite the presentation text professionally', 'Ask about these slides', 'Current document', 'Improve the slide headings and keep their meaning.'],
    ['pdf', 'PDF', 'Rotate page 1 to 90 degrees', 'Ask about this PDF', 'Current document', 'Add a text box on page 1 saying Draft for review.'],
    ['docx', 'Word', 'Create an invoice', 'Describe what you want in this document', 'Current document', 'Draft a short report with a title, headings, a page header, and page numbers in the footer.'],
    ['pptx', 'PowerPoint', 'Edit selected object', 'Describe slides', 'Current presentation', 'Create a 4-slide project status presentation with executive summary, milestones, risks, and next steps.'],
    ['xlsx', 'Excel', 'Add selectable dropdowns', 'Ask a question', 'Current workbook', 'Create a small budget table with totals and formulas.'],
    ['csv', 'CSV', 'Organize selected data', 'Ask a question', 'Current workbook', 'Create a small budget table with totals and formulas.'],
    ['weird', 'WEIRD', 'Create an invoice', 'Ask a question', 'Current document', 'Create a small budget table with totals and formulas.'],
  ])('%s shows %s tailoring', async (extension, editor, chip, placeholder, contextLabel, example) => {
    await render(extension);
    expect(host.querySelector('.office-assistant-subtitle')!.textContent).toContain(editor);
    expect(button(chip)).toBeDefined();
    expect(textarea().placeholder).toContain(placeholder);
    expect(select().options[0].textContent).toBe(contextLabel);
    await click(button('Try an example')!);
    expect(textarea().value).toBe(example);
  });
  it('fills the prompt from string and labelled quick chips', async () => {
    await render('xlsx');
    await click(button('Add selectable dropdowns')!);
    expect(textarea().value).toContain('native dropdown choices');
    await click(button('Build a summary sheet with formulas and insert a bar chart')!);
    expect(textarea().value).toBe('Build a summary sheet with formulas and insert a bar chart');
  });
  it('disables sending and chips until the editor connects', async () => {
    await render('docx', makeBridge({ ready: false }));
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Connecting…');
    expect(button('Create an invoice')!.disabled).toBe(true);
    await type('Hi');
    expect(button('Send to Buddy')!.disabled).toBe(true);
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('OfficeAssistant plan preview descriptions', () => {
  const cases: Array<[string, object, string]> = [
    ['chart with column', { type: 'add_chart', sheet: 'S1', range: 'A1:B2', from_col: 1 }, 'Insert chart · Destination: S1 · Source: A1:B2 · Column: 2'],
    ['chart without sheet', { type: 'add_chart', range: 'A1:B2' }, 'Insert chart · Destination: current worksheet · Source: A1:B2'],
    ['slide chart edit', { type: 'edit_chart', slide_index: 2, chart_index: 1, title: 'Rev' }, 'Update native chart · Slide 2 · Chart 1 · Rev'],
    ['sheet chart edit', { type: 'edit_chart', sheet: 'S1', chart_index: 0 }, 'Update native chart · S1 · Chart 0'],
    ['document chart edit', { type: 'edit_chart', chart_index: 3 }, 'Update native chart · Current document · Chart 3'],
    ['slide move', { type: 'slide_operation', slide_index: 1, operation: 'move', position: 3 }, 'Slide 1 · move → 3'],
    ['slide delete', { type: 'slide_operation', slide_index: 1, operation: 'delete' }, 'Slide 1 · delete'],
    ['slide object', { type: 'slide_object', slide_index: 4, shape_index: 2, operation: 'delete' }, 'Slide 4 · Object 2 · delete'],
    ['validation options', { type: 'set_validation', sheet: 'S', range: 'A1', options: ['x', 'y'] }, 'Set input validation · S A1 · x, y'],
    ['validation rule', { type: 'set_validation', range: 'A1', rule: 'whole' }, 'Set input validation · current worksheet A1 · Whole numbers'],
    ['custom validation rule', { type: 'set_validation', range: 'A1', rule: 'mystery', options: [] }, 'Set input validation · current worksheet A1 · mystery'],
    ['freeze', { type: 'freeze_panes', sheet: 'S', rows: 1, columns: 2 }, 'S · Freeze panes: 1 rows, 2 columns'],
    ['unfreeze', { type: 'freeze_panes', unfreeze: true }, 'current worksheet · Unfreeze panes'],
    ['pdf text', { type: 'pdf_add_text', page: 2, text: 'Hello' }, 'Add PDF text box · Page 2: Hello'],
    ['pdf rotate', { type: 'pdf_rotate_page', page: 3, angle: 90 }, 'Rotate PDF page · Page 3: 90°'],
    ['pdf bare page', { type: 'pdf_update_text', page: 5 }, 'Update PDF text box · Page 5'],
    ['titled range', { type: 'create_table', title: 'Sales', range: 'A1:B2' }, 'Create native table · Sales (A1:B2)'],
    ['titled slide', { type: 'update_slide', title: 'Intro', slide_index: 1 }, 'Update slide · Slide 1: Intro'],
    ['plain title', { type: 'add_slide', title: 'Agenda' }, 'Add slide · Agenda'],
    ['replace selection', { type: 'insert_blocks', position: 'replace_selection', text: 'New' }, 'Replace selected text · New'],
    ['insert with sheet not in details', { type: 'format_range', range: 'A1', sheet: 'Data' }, 'Format cells · A1 · Data'],
    ['name only', { type: 'add_sheet', name: 'Extra' }, 'Add worksheet · Extra'],
    ['slide only', { type: 'add_slide_shape', slide_index: 7 }, 'Insert slide object · Slide 7'],
    ['unknown type', { type: 'custom_thing' }, 'custom_thing'],
    ['sheet already in details', { type: 'add_sheet', name: 'Data', sheet: 'Data' }, 'Add worksheet · Data'],
  ];
  it.each(cases)('describes %s', async (_name, action, text) => {
    respondWith(planEvent([action]));
    await render();
    await ask();
    expect(proposals()[0]).toBe(text);
  });
  it('truncates long details to 100 characters', async () => {
    respondWith(planEvent([{ type: 'set_header', text: 'x'.repeat(150) }]));
    await render();
    await ask();
    expect(proposals()[0]).toBe(`Set page header · ${'x'.repeat(100)}`);
  });
});

describe('OfficeAssistant plan content preview', () => {
  async function previewOf(actions: unknown[]) {
    respondWith(planEvent(actions));
    await render();
    await ask();
    return host.querySelector('.office-assistant-plan-content')!;
  }
  it('renders word paragraphs with colour', async () => {
    const preview = await previewOf([{ type: 'insert_blocks', blocks: [{ text: 'Para', font_color: 'rgb(1, 2, 3)', fill: 'rgb(4, 5, 6)' }] }]);
    const p = preview.querySelector('p')!;
    expect(p.textContent).toBe('Para');
    expect(p.style.color).toBe('rgb(1, 2, 3)');
    expect(p.style.backgroundColor).toBe('rgb(4, 5, 6)');
  });
  it('renders tables with header, banding and fallbacks', async () => {
    const preview = await previewOf([{ type: 'insert_blocks', blocks: [{
      rows: [['H1'], ['r1'], ['r2']], header_fill: 'rgb(9, 9, 9)', header_font_color: 'rgb(8, 8, 8)', alternate_fill: 'rgb(7, 7, 7)', fill: 'rgb(6, 6, 6)', font_color: 'rgb(5, 5, 5)',
    }] }]);
    const th = preview.querySelector('th')!;
    expect(th.style.backgroundColor).toBe('rgb(9, 9, 9)');
    expect(th.style.color).toBe('rgb(8, 8, 8)');
    const cells = preview.querySelectorAll('td');
    expect(cells[0].style.backgroundColor).toBe('rgb(6, 6, 6)');
    expect(cells[1].style.backgroundColor).toBe('rgb(7, 7, 7)');
  });
  it('renders headerless tables, falling back to the plain fill', async () => {
    const preview = await previewOf([{ type: 'insert_blocks', blocks: [{ rows: [['a'], ['b']], header: false, fill: 'rgb(3, 3, 3)' }] }]);
    expect(preview.querySelector('th')).toBeNull();
    expect(Array.from(preview.querySelectorAll('td')).map(c => c.style.backgroundColor)).toEqual(['rgb(3, 3, 3)', 'rgb(3, 3, 3)']);
  });
  it('uses plain fill and font colour for a header with no overrides', async () => {
    const preview = await previewOf([{ type: 'insert_blocks', blocks: [{ rows: [['h'], ['a'], ['b']], fill: 'rgb(2, 2, 2)', font_color: 'rgb(1, 1, 1)' }] }]);
    const th = preview.querySelector('th')!;
    expect(th.style.backgroundColor).toBe('rgb(2, 2, 2)');
    expect(th.style.color).toBe('rgb(1, 1, 1)');
    expect(preview.querySelectorAll('td')[1].style.backgroundColor).toBe('rgb(2, 2, 2)');
  });
  it('renders slide bullets, cell values, text and descriptions', async () => {
    const preview = await previewOf([
      { type: 'add_slide', title: 'Slide A', subtitle: 'Sub', bullets: ['one', 'two'] },
      { type: 'add_slide', bullets: ['solo'] },
      { type: 'set_cells', values: [[1, 2]] },
      { type: 'set_header', text: 'Header text' },
      { type: 'add_sheet', name: 'Sheet9' },
    ]);
    const parts = Array.from(preview.children).map(c => c.textContent);
    expect(parts[0]).toBe('Slide ASub• one• two');
    expect(parts[1]).toBe('• solo');
    expect(parts[2]).toBe('[[1,2]]');
    expect(parts[3]).toBe('Header text');
    expect(parts[4]).toBe('Add worksheet · Sheet9');
  });
  it.each(['replace_document', 'clear_slides'])('warns before %s', async type => {
    respondWith(planEvent([{ type }]));
    await render();
    await ask();
    expect(host.querySelector('.office-assistant-replace-warning')!.textContent).toContain('replaces the existing');
    expect(button('Replace document')).toBeDefined();
  });
});

describe('OfficeAssistant context sent to the server', () => {
  const rich = {
    kind: 'cell', text: 'all', selection: 'sel', truncated: true, sheets: ['S'], workbook: [{ name: 'S' }], header: 'H', footer: 'F',
    sheet: 'S', range: 'A1', values: [[1]], charts: [{ selected: true, i: 1 }, { selected: false, i: 2 }], editor_capabilities: ['x'],
    slide_shapes: [{ selected: true, s: 1 }, { selected: false, s: 2 }], slide_count: 3, current_slide: 2, slide_width: 100, slide_height: 50,
  };
  it('sends the full snapshot for document context', async () => {
    respondWith(planEvent([]));
    await render('xlsx', makeBridge({ context: vi.fn().mockResolvedValue(rich) }));
    await ask();
    const { context, context_mode, prompt } = sentBody();
    expect(prompt).toBe('Do it');
    expect(context_mode).toBe('document');
    expect(context).toMatchObject({ text: 'all', selection: 'sel', truncated: true, workbook: rich.workbook, header: 'H', footer: 'F', values: [[1]], sheet: 'S', range: 'A1', slide_count: 3, current_slide: 2, slide_width: 100, slide_height: 50, editor_capabilities: ['x'] });
    expect(context.charts).toHaveLength(2);
    expect(context.slide_shapes).toHaveLength(2);
    expect(host.querySelector('.office-assistant-context-used')!.textContent).toContain('S · A1');
  });
  it('narrows charts and shapes for selection context and omits whole-document fields', async () => {
    respondWith(planEvent([]));
    await render('xlsx', makeBridge({ context: vi.fn().mockResolvedValue(rich) }));
    await chooseContext('selection');
    await ask();
    const { context } = sentBody();
    expect(context.text).toBe('');
    expect(context.selection).toBe('sel');
    expect(context.workbook).toBeUndefined();
    expect(context.header).toBeUndefined();
    expect(context.footer).toBeUndefined();
    expect(context.charts).toEqual([rich.charts[0]]);
    expect(context.slide_shapes).toEqual([rich.slide_shapes[0]]);
  });
  it('withholds all content for no-context requests and sends no history', async () => {
    respondWith(planEvent([{ type: 'add_sheet', name: 'A' }]));
    respondWith(planEvent([]));
    await render('xlsx', makeBridge({ context: vi.fn().mockResolvedValue(rich) }));
    await ask();
    await chooseContext('none');
    await ask('Second');
    const { context, history } = sentBody(1);
    expect(history).toEqual([]);
    expect(context.selection).toBe('');
    expect(context.values).toBeUndefined();
    expect(context.charts).toBeUndefined();
    expect(context.slide_shapes).toBeUndefined();
    expect(host.querySelector('.office-assistant-context-used')!.textContent).toContain('No document content');
  });
  it.each([
    ['html document', 'document', { kind: 'html', text: 't', selection: '', html_nodes: [{ index: 1 }] }, { html_nodes: [{ index: 1 }] }],
    ['html with no nodes', 'document', { kind: 'html', text: 't', selection: '' }, { html_nodes: [] }],
    ['html selection', 'selection', { kind: 'html', text: 't', selection: '', html_nodes: [{ index: 1 }] }, { html_nodes: [] }],
    ['pdf document', 'document', { kind: 'pdf', text: 't', selection: '', page_count: 2, pages: [{ page: 1, objects: [1], extra: 'x' }], capabilities: ['c'], text_available: false, truncated: true }, { page_count: 2, pages: [{ page: 1, objects: [1] }], capabilities: ['c'], text_available: false, truncated: true }],
    ['pdf defaults', 'document', { kind: 'pdf', text: 't', selection: '' }, { pages: [], capabilities: [], text_available: true, truncated: false }],
    ['pdf selection', 'selection', { kind: 'pdf', text: 't', selection: '', pages: [{ page: 1 }] }, { pages: [] }],
  ])('shapes %s context', async (_n, mode, snapshot, expected) => {
    respondWith(planEvent([]));
    await render('pdf', makeBridge({ context: vi.fn().mockResolvedValue(snapshot) }));
    await chooseContext(mode);
    await ask();
    expect(sentBody().context).toMatchObject(expected);
  });
  it.each([
    [{ kind: 'slide', text: '', selection: '', current_slide: 3 }, 'Slide 3'],
    [{ kind: 'slide', text: '', selection: '', current_slide: 3, slide_shapes: [{ selected: true }, { selected: true }, { selected: false }] }, 'Slide 3 · 2 selected objects'],
    [{ kind: 'slide', text: '', selection: '', current_slide: 3, slide_shapes: [{ selected: false }] }, 'Slide 3'],
    [{ kind: 'cell', text: '', selection: '', sheet: 'Only' }, 'Only ·'],
    [{ kind: 'word', text: '', selection: 'x' }, 'Selected text'],
    [{ kind: 'word', text: '', selection: '' }, 'Current document'],
  ])('labels the context that was used', async (snapshot, label) => {
    respondWith(planEvent([]));
    await render('docx', makeBridge({ context: vi.fn().mockResolvedValue(snapshot) }));
    await ask();
    expect(host.querySelector('.office-assistant-context-used')!.textContent).toContain(label);
  });
  it('sends bounded history of finished turns, marking applied ones', async () => {
    respondWith(planEvent([{ type: 'add_sheet', name: 'A' }]));
    respondWith(planEvent([]));
    respondWith(planEvent([]));
    await render();
    await ask('First');
    await ask('Second');
    await ask('Third');
    const { history } = sentBody(2);
    expect(history).toEqual([
      { prompt: 'First', reply: 'Here is the plan', state: 'discarded' },
      { prompt: 'Second', reply: 'Here is the plan', state: 'applied' },
    ]);
  });
});

describe('OfficeAssistant streaming', () => {
  it('shows a reply with no actions as already complete, and flushes deltas', async () => {
    respondWith({ type: 'delta', text: 'Partial' }, planEvent([], { reply: 'Answer' }));
    await render();
    await ask();
    expect(host.querySelector('[data-testid="reply"]')!.textContent).toContain('Answer');
    expect(host.querySelector('.office-assistant-turn.state-applied')).not.toBeNull();
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });
  it('parses a final line without a trailing newline and ignores blanks', async () => {
    const line = encoder.encode(`\n${JSON.stringify(planEvent([]))}`);
    let sent = false;
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({
      read: async () => { if (sent) return { value: undefined, done: true }; sent = true; return { value: line, done: false }; },
      releaseLock: () => undefined,
    }) } } as never);
    await render();
    await ask();
    expect(host.querySelector('.office-assistant-turn.state-applied')).not.toBeNull();
  });
  it.each([
    ['a stream with no plan', [{ type: 'delta', text: 'half' }], 'Bob stopped before completing the draft. Please retry.'],
    ['an error event', [{ type: 'error', message: 'Quota reached' }], 'Quota reached'],
    ['a bare error event', [{ type: 'error' }], 'Buddy could not complete this request.'],
    ['unparseable output', ['not json'], /JSON/],
  ])('reports %s and clears the partial reply', async (_n, events, message) => {
    respondWith(...events);
    await render();
    await ask();
    const alert = host.querySelector('.office-assistant-error')!.textContent!;
    if (typeof message === 'string') expect(alert).toBe(message);
    else expect(alert).toMatch(message);
    expect(host.querySelector('[data-testid="reply"]')).toBeNull();
  });
  it('keeps the plan if the stream fails after delivering it', async () => {
    respondWith(planEvent([{ type: 'add_sheet', name: 'A' }]), { type: 'error', message: 'Late failure' });
    await render();
    await ask();
    expect(host.querySelector('[data-testid="reply"]')!.textContent).toContain('Here is the plan');
    expect(host.querySelector('.office-assistant-error')!.textContent).toBe('Late failure');
  });
  it('resets the partial reply on status events and surfaces progress', async () => {
    let release: (v: unknown) => void = () => undefined;
    const chunks = [
      { type: 'delta', text: 'draft A' },
      { type: 'status', message: 'Retrying with care', reset_reply: true },
      { type: 'status', message: 'Still thinking' },
    ].map(e => encoder.encode(JSON.stringify(e) + '\n'));
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({
      read: () => chunks.length ? Promise.resolve({ value: chunks.shift(), done: false }) : new Promise(resolve => { release = resolve; }),
      releaseLock: () => undefined,
    }) } } as never);
    await render();
    await ask();
    expect(host.querySelector('.office-assistant-progress')!.textContent).toBe('Still thinking');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 90)); });
    expect(host.querySelector('[data-testid="reply"]')).toBeNull();
    await act(async () => { release({ value: encoder.encode(JSON.stringify(planEvent([])) + '\n'), done: true }); });
    await flush();
    expect(host.querySelector('[data-testid="reply"]')!.textContent).toContain('Here is the plan');
  });
  it('flushes queued deltas on a timer while streaming', async () => {
    let release: (v: unknown) => void = () => undefined;
    const chunks = [encoder.encode(JSON.stringify({ type: 'delta', text: 'Live words' }) + '\n')];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({
      read: () => chunks.length ? Promise.resolve({ value: chunks.shift(), done: false }) : new Promise(resolve => { release = resolve; }),
      releaseLock: () => undefined,
    }) } } as never);
    await render();
    await ask();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 90)); });
    expect(host.querySelector('[data-testid="reply"]')!.textContent).toContain('Live words');
    await act(async () => { release({ value: encoder.encode(JSON.stringify(planEvent([])) + '\n'), done: true }); });
    await flush();
    expect(host.querySelector('[data-testid="reply"]')!.textContent).toContain('Here is the plan');
  });
  const started = { version: 1, call_id: 'c1', agent_id: 'a', agent_name: 'Research', stage: 'started', message: 'Research is working' };
  it('tracks collaborations, replacing updates to the same call', async () => {
    respondWith({ collaboration: started }, { collaboration: { ...started, stage: 'completed', message: 'Research finished', task: 'Dig' } }, planEvent([]));
    await render();
    await ask();
    const items = host.querySelectorAll('.app-collaboration-activity li');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Research finished');
    expect(items[0].textContent).toContain('Dig');
  });
  it('marks a running collaboration as failed when the turn fails', async () => {
    respondWith({ collaboration: started }, { type: 'error', message: 'Nope' });
    await render();
    await ask();
    expect(host.querySelector('.app-collaboration-activity li')!.textContent).toContain('Research could not complete the task');
    expect(host.querySelector('.app-collaboration-activity li')!.getAttribute('data-stage')).toBe('failed');
  });
  it('sends a follow-up from reply content without touching the draft', async () => {
    respondWith(planEvent([]));
    respondWith(planEvent([]));
    await render();
    await ask();
    await type('Half-written');
    await click(button('follow-up')!);
    await flush();
    expect(sentBody(1).prompt).toBe('Follow up prompt');
    expect(textarea().value).toBe('Half-written');
  });
});

describe('OfficeAssistant request failures', () => {
  it.each([
    ['a server detail', { detail: 'Too large' }, 400, 'Too large'],
    ['a non-string detail', { detail: { x: 1 } }, 500, 'Bob could not start this request. Please retry.'],
  ])('reports %s', async (_n, body, status, message) => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status, json: async () => body } as never);
    await render();
    await ask();
    expect(host.querySelector('.office-assistant-error')!.textContent).toBe(message);
  });
  it('announces expired sessions and tolerates unparseable errors', async () => {
    const expired = vi.fn();
    window.addEventListener('buddy-auth-expired', expired);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401, json: async () => { throw new Error('bad'); } } as never);
    await render();
    await ask();
    window.removeEventListener('buddy-auth-expired', expired);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.office-assistant-error')!.textContent).toBe('Bob could not start this request. Please retry.');
  });
  it('reports a missing response stream', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: null } as never);
    await render();
    await ask();
    expect(host.querySelector('.office-assistant-error')!.textContent).toBe('Bob did not return a response stream.');
  });
  it('reports context read failures', async () => {
    await render('docx', makeBridge({ context: vi.fn().mockRejectedValue(new Error('Editor gone')) }));
    await ask();
    expect(host.querySelector('.office-assistant-error')!.textContent).toBe('Editor gone');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('OfficeAssistant cancel', () => {
  it('cancels while reading context without calling the server', async () => {
    let resolveContext: (v: unknown) => void = () => undefined;
    const context = vi.fn(() => new Promise(resolve => { resolveContext = resolve; }));
    await render('docx', makeBridge({ context: context as never }));
    await ask();
    await click(button('Cancel')!);
    await act(async () => { resolveContext({ kind: 'word', text: '', selection: '' }); });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Request cancelled');
    expect(host.querySelector('.office-assistant-error')).toBeNull();
  });
  it('marks a running collaboration cancelled', async () => {
    const started = { version: 1, call_id: 'c1', agent_id: 'a', agent_name: 'Research', stage: 'started', message: 'Working' };
    let fail: (e: Error) => void = () => undefined;
    const chunks = [encoder.encode(JSON.stringify({ collaboration: started }) + '\n')];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({
      read: () => chunks.length ? Promise.resolve({ value: chunks.shift(), done: false }) : new Promise((_, reject) => { fail = reject; }),
      releaseLock: () => undefined,
    }) } } as never);
    await render();
    await ask();
    expect(host.querySelector('.office-assistant-progress')!.textContent).toBe('Working');
    await click(button('Cancel')!);
    await act(async () => { fail(new DOMException('Aborted', 'AbortError')); });
    await flush();
    expect(host.querySelector('.app-collaboration-activity li')!.textContent).toContain('Research was cancelled');
    expect(host.querySelector('.app-collaboration-activity li')!.getAttribute('data-stage')).toBe('cancelled');
  });
});

describe('OfficeAssistant apply', () => {
  async function withPlan(bridge = makeBridge(), actions: unknown[] = [{ type: 'add_sheet', name: 'A' }]) {
    respondWith(planEvent(actions));
    await render('docx', bridge);
    await ask();
    return bridge;
  }
  it('applies the plan with the captured context and reports back', async () => {
    const bridge = await withPlan();
    await click(button('Apply to document')!);
    await flush();
    expect(bridge.apply).toHaveBeenCalledWith(expect.objectContaining({ actions: [{ type: 'add_sheet', name: 'A' }] }), expect.objectContaining({ kind: 'word' }));
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.office-assistant-applied')).not.toBeNull();
  });
  it.each([
    ['an editor error', { error: 'Locked' }, 'Locked'],
    ['ok false', { ok: false }, 'The editor could not apply this draft.'],
  ])('shows %s and keeps the plan reviewable', async (_n, result, message) => {
    await withPlan(makeBridge({ apply: vi.fn().mockResolvedValue(result) }));
    await click(button('Apply to document')!);
    await flush();
    expect(host.querySelector('.office-assistant-error')!.textContent).toBe(message);
    expect(onApplied).not.toHaveBeenCalled();
    expect(button('Apply to document')).toBeDefined();
  });
  it('discards a plan', async () => {
    await withPlan();
    await click(button('Discard')!);
    expect(host.textContent).toContain('Draft discarded');
    expect(button('Apply to document')).toBeUndefined();
  });
  it('shows progress while applying and blocks other actions', async () => {
    let finish: (v: unknown) => void = () => undefined;
    await withPlan(makeBridge({ apply: vi.fn(() => new Promise(resolve => { finish = resolve; })) as never }));
    await click(button('Apply to document')!);
    expect(button('Applying…')!.disabled).toBe(true);
    expect(onBusy).toHaveBeenLastCalledWith(true);
    await act(async () => { finish({ ok: true }); });
    await flush();
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });
  it('discards an open preview when a new request is sent', async () => {
    await withPlan();
    respondWith(planEvent([]));
    await ask('Another');
    expect(host.querySelector('.office-assistant-turn.state-discarded')).not.toBeNull();
    expect(host.textContent).toContain('Draft discarded');
  });

  describe('forms', () => {
    const form = { create_form: { title: 'Survey', description: 'Tell us', fields: [
      { name: 'a', label: 'Name', required: true },
      { name: 'b', label: 'Pick', type: 'select', options: ['x', 'y'] },
    ] } };
    async function withForm() {
      respondWith(planEvent([], form));
      await render();
      await ask();
    }
    it('previews the form and creates it, navigating to the saved file', async () => {
      await withForm();
      expect(proposals()).toEqual(['Name * — text', 'Pick — select: x, y']);
      const changed = vi.fn();
      window.addEventListener('buddy-office-changed', changed);
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'new/id' }) } as never);
      await click(button('Create form')!);
      await flush();
      window.removeEventListener('buddy-office-changed', changed);
      expect(changed).toHaveBeenCalled();
      expect(navigateOffice).toHaveBeenCalledWith('/office/files/new%2Fid');
      expect(host.querySelector('[data-testid="reply"]')!.textContent).toContain('[Open saved form](/office/files/new%2Fid)');
      expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).title).toBe('Survey');
    });
    it.each([
      [{ detail: 'Duplicate form' }, 400, 'Duplicate form'],
      [{}, 500, 'Could not create the form.'],
    ])('reports creation failure %#', async (body, status, message) => {
      await withForm();
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status, json: async () => body } as never);
      await click(button('Create form')!);
      await flush();
      expect(host.querySelector('.office-assistant-error')!.textContent).toBe(message);
    });
    it('announces an expired session during creation', async () => {
      await withForm();
      const expired = vi.fn();
      window.addEventListener('buddy-auth-expired', expired);
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as never);
      await click(button('Create form')!);
      await flush();
      window.removeEventListener('buddy-auth-expired', expired);
      expect(expired).toHaveBeenCalledTimes(1);
    });
    it('discards a form preview', async () => {
      await withForm();
      await click(button('Discard')!);
      expect(button('Create form')).toBeUndefined();
    });
  });
});

describe('OfficeAssistant message deletion', () => {
  const deleteQuestion = () => host.querySelector<HTMLButtonElement>('.question-delete-icon')!;
  async function withTurn() {
    respondWith(planEvent([{ type: 'add_sheet', name: 'A' }]));
    await render();
    await ask('Question text');
  }
  it('keeps everything if deletion is declined', async () => {
    vi.mocked(appConfirm).mockResolvedValueOnce(false);
    await withTurn();
    await click(deleteQuestion());
    await flush();
    expect(host.querySelector('.office-assistant-user')!.textContent).toContain('Question text');
    expect(deleteQuestion().disabled).toBe(false);
  });
  it('removes the question then the answer, then the whole turn', async () => {
    vi.mocked(appConfirm).mockResolvedValue(true);
    await withTurn();
    await click(deleteQuestion());
    await flush();
    expect(host.querySelector('.office-assistant-user')).toBeNull();
    expect(host.querySelector('.office-assistant-turn')).not.toBeNull();
    await click(button('Delete answer')!);
    await flush();
    expect(host.querySelector('.office-assistant-turn')).toBeNull();
    expect(host.querySelector('.office-assistant-intro')).not.toBeNull();
  });
  it('removing only the answer keeps the question', async () => {
    vi.mocked(appConfirm).mockResolvedValue(true);
    await withTurn();
    await click(button('Delete answer')!);
    await flush();
    expect(host.querySelector('.office-assistant-user')!.textContent).toContain('Question text');
    expect(host.querySelector('.office-assistant-reply')).toBeNull();
  });
  it('ignores repeat clicks while confirmation is open and blocks sending', async () => {
    let answer: (v: boolean) => void = () => undefined;
    vi.mocked(appConfirm).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await withTurn();
    await click(deleteQuestion());
    expect(deleteQuestion().disabled).toBe(true);
    expect(button('Delete answer')!.disabled).toBe(true);
    await type('Blocked');
    expect(button('Send to Buddy')!.disabled).toBe(true);
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(appConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { answer(false); });
    await flush();
    expect(deleteQuestion().disabled).toBe(false);
  });
  it('does not delete after unmount during confirmation', async () => {
    let answer: (v: boolean) => void = () => undefined;
    vi.mocked(appConfirm).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await withTurn();
    await click(deleteQuestion());
    await act(async () => root.unmount());
    await act(async () => { answer(true); });
    expect(host.textContent).toBe('');
    root = createRoot(host);
  });
});

describe('OfficeAssistant composer', () => {
  const key = (init: KeyboardEventInit) => act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  it('sends on Enter but not on Shift+Enter, IME or auto-repeat', async () => {
    respondWith(planEvent([]));
    await render();
    await type('Go');
    await key({ key: 'Enter', shiftKey: true });
    await key({ key: 'Enter', isComposing: true });
    await key({ key: 'Enter', keyCode: 229 } as KeyboardEventInit);
    await key({ key: 'Enter', repeat: true });
    await key({ key: 'a' });
    expect(fetch).not.toHaveBeenCalled();
    await key({ key: 'Enter' });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('');
  });
  it('ignores empty prompts', async () => {
    await render();
    await type('   ');
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('offers jump to latest when scrolled away and returns on click', async () => {
    await render();
    const log = host.querySelector<HTMLDivElement>('.office-assistant-log')!;
    log.scrollTo = vi.fn();
    Object.defineProperties(log, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 100, configurable: true } });
    log.scrollTop = 0;
    await act(async () => { log.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await click(host.querySelector('.office-assistant-latest')!);
    expect(log.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'instant' });
    expect(host.querySelector('.office-assistant-latest')).toBeNull();
  });
  it('aborts in-flight work and releases busy state on unmount', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementationOnce(((_u: string, init: RequestInit) => { signal = init.signal!; return new Promise(() => undefined); }) as never);
    await render();
    await ask();
    await act(async () => root.unmount());
    expect(signal!.aborted).toBe(true);
    expect(onBusy).toHaveBeenLastCalledWith(false);
    root = createRoot(host);
  });
});
