// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { StructuredDiagram } from '../../src/components/StructuredDiagram';

const api = vi.hoisted(() => ({ saveSessionFile: vi.fn() }));
vi.mock('../../src/api', () => api);

let host: HTMLDivElement;
let root: Root;
const spec = {
  id: 'my diagram', kind: 'sequence' as const, title: 'Request flow',
  nodes: [{ id: 'client', label: 'Client' }, { id: 'server', label: 'Server' }],
  edges: [{ id: 'request', source: 'client', target: 'server', label: 'Request', animated: true },
    { id: 'internal', source: 'server', target: 'server', label: 'Process' }],
};
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find(el => el.textContent === text);
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  api.saveSessionFile.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('sequence messages support keyboard selection and source disclosure', async () => {
  await act(async () => root.render(<StructuredDiagram spec={spec} source="sequence source" streaming={false} />));
  const messages = host.querySelectorAll('.sequence-message');
  expect(messages).toHaveLength(2);
  await act(async () => messages[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(messages[0].getAttribute('aria-pressed')).toBe('true');
  expect((messages[1] as SVGElement).style.opacity).toBe('0.25');
  await act(async () => messages[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  expect(messages[0].getAttribute('aria-pressed')).toBe('false');
  await act(async () => button('Source').click());
  expect(host.querySelector('.diagram-source')?.textContent).toBe('sequence source');
});

test('save reports failure and success and uses a safe filename', async () => {
  api.saveSessionFile.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  await act(async () => root.render(<StructuredDiagram spec={spec} source="source" sessionId="session-1" streaming={false} />));
  await act(async () => button('Save').click());
  expect(host.textContent).toContain('Could not save diagram.');
  await act(async () => button('Save').click());
  expect(host.textContent).toContain('Diagram saved.');
  expect(api.saveSessionFile).toHaveBeenLastCalledWith('session-1', 'my_diagram.diagram.json', JSON.stringify(spec, null, 2));
});

test('streaming prevents saves and animated exports', async () => {
  await act(async () => root.render(<StructuredDiagram spec={spec} source="source" sessionId="s" streaming />));
  expect(button('Save').disabled).toBe(true);
  expect(button('Animated SVG').disabled).toBe(true);
  expect(host.textContent).toContain('Drawing');
});
