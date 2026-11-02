// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../decisions-buddy/src/components/AddWatsonxBoxModal.jsx', () => ({
  default: ({ isOpen, existingNode, onClose, onUpdateModel, model }: any) => (isOpen ? (
    <div data-testid="box" data-editing={existingNode?.id ?? ''}>
      <button onClick={onClose}>close box</button>
      <button onClick={() => onUpdateModel({ ...model, name: 'Box' })}>apply box</button>
    </div>
  ) : null),
}));

// @ts-expect-error plain JS JSX component outside web tsconfig
import DecisionTableTab from '../../../decisions-buddy/src/components/DecisionTableTab.jsx';

const content = () => ({ hitPolicy: 'first', inputs: [{ id: 'age', field: 'customer.age', name: 'Age' }, { id: 'tier', field: 'tier' }],
  outputs: [{ id: 'out', field: 'score', name: 'Score' }, { id: 'band', field: 'band' }],
  rules: [{ _id: 'r1', _description: 'First', age: '> 1', tier: '-', out: '1', band: 'A' },
    { _id: 'r2', age: '< 1', out: 0 }, { _id: 'r3', _description: 'Third', age: '-', out: '3' }] });

function model(overrides: Record<string, any> = {}) {
  return { id: 'm/1', name: 'Table decision', version: 2, graph: { nodes: [
    { id: 't1', name: 'Primary', type: 'decisionTableNode', content: content() },
    { id: 't2', type: 'decisionTableNode', content: { ...content(), hitPolicy: 'collect', rules: [] } },
    { id: 'ai', name: 'AI scorer', type: 'watsonxAiNode', content: { modelId: 'granite', outputField: 'aiOut', endpoint: 'https://wx.synthetic.invalid' } },
    { id: 'ml', type: 'watsonxMlNode' },
  ], edges: [{ id: 'e1', sourceId: 'ai', targetId: 't1' }, { id: 'e2', sourceId: 't1', targetId: 't2' }] }, ...overrides };
}

function response(body: any, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe('DecisionTableTab behaviour', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onUpdateModel: any;
  let fetchMock: any;

  const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(label)) as HTMLButtonElement;
  const click = (label: string) => act(async () => { button(label).click(); });
  const render = (props: Record<string, any> = {}) => act(async () => {
    root.render(<DecisionTableTab model={model()} editable onUpdateModel={onUpdateModel} {...props} />);
  });
  const updated = () => onUpdateModel.mock.calls.at(-1)[0];
  const rules = () => updated().graph.nodes[0].content.rules;
  const type = (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const select = (id: string, value: string) => act(async () => {
    const element = document.querySelector(`#${id}`) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const iconButtons = (label: string) => Array.from(document.querySelectorAll('button')).filter(b => b.closest('.cds--tooltip, .cds--popover-container')?.textContent?.includes(label)) as HTMLButtonElement[];
  const errorText = () => document.querySelector('.cds--inline-notification')?.textContent ?? '';

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onUpdateModel = vi.fn();
    fetchMock = vi.fn(async () => response({}));
    vi.stubGlobal('fetch', fetchMock);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  });

  describe('empty states', () => {
    it('renders nothing without a model', async () => {
      await render({ model: null });
      expect(host.textContent).toBe('');
    });

    it('explains when no table exists', async () => {
      await render({ model: { id: 'x', graph: { nodes: [{ id: 'a', type: 'inputNode' }] } } });
      expect(host.textContent).toContain('No Decision Table node found');
    });

    it('handles a model without graph', async () => {
      await render({ model: { id: 'x' } });
      expect(host.textContent).toContain('No Decision Table node found');
    });
  });

  describe('rule editing', () => {
    it('renders rows with fallback headers and values', async () => {
      await render();
      expect(host.textContent).toContain('IN: Age');
      expect(host.textContent).toContain('IN: tier');
      expect(host.textContent).toContain('OUT: band');
      expect((host.querySelector('[aria-label="Rule 2 tier"]') as HTMLInputElement).value).toBe('');
      expect((host.querySelector('[aria-label="Rule 2 out"]') as HTMLInputElement).value).toBe('0');
    });

    it('edits descriptions and cells', async () => {
      await render();
      await type(host.querySelector('[aria-label="Rule 1 description"]')!, 'Renamed');
      expect(rules()[0]._description).toBe('Renamed');
      await type(host.querySelector('[aria-label="Rule 2 age"]')!, '>= 9');
      expect(rules()[1].age).toBe('>= 9');
    });

    it('moves rules within bounds', async () => {
      await render();
      const down = iconButtons('Move rule 1 down')[0];
      await act(async () => { down.click(); });
      expect(rules().map((rule: any) => rule._id)).toEqual(['r2', 'r1', 'r3']);
      const up = iconButtons('Move rule 3 up')[0];
      await act(async () => { up.click(); });
      expect(rules().map((rule: any) => rule._id)).toEqual(['r1', 'r3', 'r2']);
      expect(iconButtons('Move rule 1 up')[0].disabled).toBe(true);
      expect(iconButtons('Move rule 3 down')[0].disabled).toBe(true);
    });

    it('deletes a rule', async () => {
      await render();
      await act(async () => { iconButtons('Delete Rule')[1].click(); });
      expect(rules().map((rule: any) => rule._id)).toEqual(['r1', 'r3']);
    });

    it('changes the hit policy', async () => {
      await render();
      await select('hit-policy-select', 'ruleOrder');
      expect(updated().graph.nodes[0].content.hitPolicy).toBe('ruleOrder');
    });

    it.each([
      ['first', 'FIRST policy'], ['ruleOrder', 'RULE ORDER policy'], ['collect', 'COLLECT'],
    ])('describes hit policy %s', async (hitPolicy, text) => {
      const source = model();
      source.graph.nodes[0].content.hitPolicy = hitPolicy;
      await render({ model: source });
      expect(host.textContent).toContain(text);
    });

    it('adds a rule from the modal with typed values', async () => {
      await render();
      await click('Add Rule');
      const modal = () => Array.from(document.querySelectorAll('.cds--modal')).find(el => el.classList.contains('is-visible')) as HTMLElement;
      const inputs = () => Array.from(modal().querySelectorAll('input[type="text"]')) as HTMLInputElement[];
      expect(inputs().length).toBe(5);
      await type(inputs()[0], 'Added');
      await type(inputs()[1], '> 5');
      await type(inputs()[3], '9');
      const submit = Array.from(modal().querySelectorAll('button')).find(b => b.textContent === 'Add Rule') as HTMLButtonElement;
      await act(async () => { submit.click(); });
      expect(rules().at(-1)).toMatchObject({ _description: 'Added', age: '> 5', out: '9' });
    });

    it('uses a numbered default description and closes on cancel', async () => {
      await render();
      await click('Add Rule');
      const modal = () => Array.from(document.querySelectorAll('.cds--modal')).find(el => el.classList.contains('is-visible')) as HTMLElement;
      const secondary = Array.from(modal().querySelectorAll('button')).find(b => b.classList.contains('cds--btn--secondary')) as HTMLButtonElement;
      await act(async () => { secondary.click(); });
      expect(document.querySelector('.cds--modal.is-visible')).toBeNull();
      await click('Add Rule');
      const submit = Array.from(modal().querySelectorAll('button')).find(b => b.textContent === 'Add Rule') as HTMLButtonElement;
      await act(async () => { submit.click(); });
      expect(rules().at(-1)._description).toBe('Custom Rule 4');
    });

    it('read-only mode disables every edit', async () => {
      await render({ editable: false });
      expect(host.textContent).toContain('Read-only decision.');
      expect((host.querySelector('[aria-label="Rule 1 age"]') as HTMLInputElement).readOnly).toBe(true);
      expect(iconButtons('Delete Rule')[0].disabled).toBe(true);
      expect((host.querySelector('#hit-policy-select') as HTMLSelectElement).disabled).toBe(true);
      expect(onUpdateModel).not.toHaveBeenCalled();
    });

    it('switches between tables', async () => {
      await render();
      await select('decision-table-select', 't2');
      expect(host.textContent).toContain('COLLECT');
      expect(host.querySelector('[aria-label="Rule 1 age"]')).toBeNull();
    });

    it('highlights rules matched by the evaluation', async () => {
      await render({ evaluationResult: { trace: [{ id: 't1', ruleTrace: [{ ruleId: 'r1', passed: true }, { ruleId: 'r2', passed: false }] }] } });
      const rows = host.querySelectorAll('tbody tr');
      expect(rows[0].outerHTML).not.toBe(rows[1].outerHTML);
      expect(rows[0].textContent).toContain('1');
    });
  });

  describe('policy view', () => {
    it('renders a readable summary with fallbacks', async () => {
      await render();
      await click('.policy View');
      const text = document.body.textContent ?? '';
      expect(text).toContain('# Decision: Table decision');
      expect(text).toContain('# Hit Policy: FIRST');
      expect(text).toContain('field: "tier" as "tier"');
      expect(text).toContain('[Rule 2] "Rule 2"');
      expect(text).toContain('when tier is -');
      expect(text).toContain('then band = "-"');
      expect(text).toContain('then score = 0');
      const close = Array.from(document.querySelectorAll('.cds--modal.is-visible button')).find(b => b.classList.contains('cds--modal-close')) as HTMLElement;
      await act(async () => { close.click(); });
      expect(document.querySelector('.cds--modal.is-visible')).toBeNull();
    });
  });

  describe('heatmap', () => {
    it('shows frequencies, labels unavailable rows and hides again', async () => {
      fetchMock.mockResolvedValue(response({ ruleHeatmap: { r1: { hitCount: 8, hitPercentage: 80 }, r2: { hitCount: 2, hitPercentage: 20 }, r3: { hitCount: 'x', hitPercentage: 0 } } }));
      await render();
      await click('Rule Heatmap');
      expect(fetchMock.mock.calls[0][0]).toContain('/models/m%2F1/analytics');
      expect(host.textContent).toContain('8 hits (80%)');
      expect(host.textContent).toContain('2 hits (20%)');
      expect(host.textContent).toContain('Unavailable');
      await click('Hide Heatmap');
      expect(host.textContent).not.toContain('8 hits');
    });

    it.each([
      ['service failure', response({}, 500), 'Analytics unavailable (HTTP 500).'],
      ['invalid body', response({ ruleHeatmap: 'x' }), 'no rule frequencies'],
      ['empty body', response(null), 'no rule frequencies'],
    ])('reports %s and can be dismissed', async (_label, reply, message) => {
      fetchMock.mockResolvedValue(reply);
      await render();
      await click('Rule Heatmap');
      expect(errorText()).toContain(message);
      await act(async () => { (document.querySelector('.cds--inline-notification__close-button') as HTMLElement).click(); });
      expect(errorText()).toBe('');
    });

    it('is disabled for unsaved drafts', async () => {
      await render({ model: model({ _dirty: true }) });
      expect(button('Rule Heatmap').disabled).toBe(true);
      await render({ model: model({ version: 0 }) });
      expect(button('Rule Heatmap').disabled).toBe(true);
    });
  });

  describe('diagnostics', () => {
    const run = () => click('Check Rule Conflicts');

    it('reports a clean result and dismisses it', async () => {
      fetchMock.mockResolvedValue(response({ diagnostics: [] }));
      await render();
      await run();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).graph.nodes).toHaveLength(4);
      expect(host.textContent).toContain('Static Analysis Passed');
      await click('Dismiss');
      expect(host.textContent).not.toContain('Static Analysis Passed');
    });

    it('lists findings by severity', async () => {
      fetchMock.mockResolvedValue(response({ diagnostics: [
        { severity: 'error', message: 'Bad error', ruleId: 'r1' }, { severity: 'warning', message: 'Bad warning' }, { severity: 'info', message: 'Just info' },
      ] }));
      await render();
      await run();
      for (const message of ['Bad error', 'Bad warning', 'Just info', 'Found 3']) expect(host.textContent).toContain(message);
    });

    it.each([
      ['service failure', response({}, 502), 'Static analysis unavailable (HTTP 502).'],
      ['invalid body', response({ diagnostics: 'none' }), 'invalid response'],
    ])('reports %s', async (_label, reply, message) => {
      fetchMock.mockResolvedValue(reply);
      await render();
      await run();
      expect(errorText()).toContain(message);
    });

    it('ignores a late answer after the model changed', async () => {
      let release: any;
      fetchMock.mockReturnValue(new Promise(resolve => { release = () => resolve(response({ diagnostics: [] })); }));
      await render();
      await run();
      const changed = model();
      changed.graph.nodes[0].content.rules = [];
      await render({ model: changed });
      await act(async () => { release(); await Promise.resolve(); });
      expect(host.textContent).not.toContain('Static Analysis Passed');
    });
  });

  describe('watsonx panel', () => {
    it('lists nodes with fallbacks', async () => {
      await render();
      const text = host.textContent ?? '';
      expect(text).toContain('AI scorer');
      expect(text).toContain('granite');
      expect(text).toContain('aiOut');
      expect(text).toContain('ml');
      expect(text).toContain('ML deployment');
      expect(text).toContain('mlScore');
      expect(text).toContain('watsonx SaaS / CP4D');
    });

    it('opens create and edit, applies updates and closes', async () => {
      await render();
      const box = () => document.querySelector('[data-testid="box"]') as HTMLElement;
      await click('+ watsonx');
      expect(box().dataset.editing).toBe('');
      await click('apply box');
      expect(updated().name).toBe('Box');
      await click('close box');
      expect(box()).toBeNull();
      const edits = Array.from(host.querySelectorAll('button')).filter(b => /configure|edit/i.test(b.textContent ?? ''));
      await act(async () => { edits[0].click(); });
      expect(box().dataset.editing).toBe('ai');
    });

    it('deletes a node with its edges', async () => {
      await render();
      const remove = Array.from(host.querySelectorAll('button')).filter(b => /remove|delete/i.test(b.textContent ?? '') || /remove|delete/i.test(b.closest('.cds--tooltip, .cds--popover-container')?.textContent ?? ''))
        .find(b => !b.closest('tbody')) as HTMLButtonElement;
      await act(async () => { remove.click(); });
      expect(updated().graph.nodes.map((node: any) => node.id)).toEqual(['t1', 't2', 'ml']);
      expect(updated().graph.edges.map((edge: any) => edge.id)).toEqual(['e2']);
    });

    it('the add control is disabled when read-only', async () => {
      await render({ editable: false });
      expect(button('+ watsonx').disabled).toBe(true);
      expect(onUpdateModel).not.toHaveBeenCalled();
    });
  });
});
