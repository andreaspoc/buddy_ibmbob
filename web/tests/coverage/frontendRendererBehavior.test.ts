// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
import '../../../frontend/renderer.js';

const renderer = (window as any).BobRenderer;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mermaid.render.mockReset();
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

test('streaming deck is hidden until completed, and valid deck is navigable by keyboard', () => {
  const target = document.createElement('div');
  document.body.append(target);
  const deck = { title: 'Plan', slides: [{ title: 'First' }, { title: 'Second' }] };
  const markdown = `Before\n\n\`\`\`bobdeck\n${JSON.stringify(deck)}\n\`\`\``;
  renderer.renderMarkdown(target, markdown, false);
  expect(target.textContent).toContain('Generating presentation');
  expect(target.querySelector('.bobdeck-viewer')).toBeNull();
  renderer.renderMarkdown(target, markdown, true);
  expect(target.querySelector('.bobdeck-counter')?.textContent).toBe('Slide 1 of 2');
  const thumbs = target.querySelectorAll('.bobdeck-thumb');
  thumbs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(target.querySelector('.bobdeck-counter')?.textContent).toBe('Slide 2 of 2');
  expect((target.querySelector('.bobdeck-nav-next') as HTMLButtonElement).disabled).toBe(true);
});

test('sanitizes unsafe links and preserves invalid chart and deck source', () => {
  const target = document.createElement('div');
  renderer.renderMarkdown(target, '[safe](https://example.com) [bad](javascript:alert(1))\n\n```chart\n{invalid}\n```\n\n```bobdeck\n{"slides":[]}\n```', true);
  const link = target.querySelector('a[href]') as HTMLAnchorElement;
  expect(link.href).toBe('https://example.com/');
  expect(link.rel).toBe('noopener noreferrer');
  expect(target.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(target.querySelector('code.language-chart')?.textContent).toContain('{invalid}');
  expect(target.querySelector('code.language-bobdeck')).not.toBeNull();
});

test('mermaid failure exposes the original diagram for recovery', async () => {
  mermaid.render.mockRejectedValue(new Error('invalid diagram'));
  const target = document.createElement('div');
  renderer.renderMarkdown(target, '```mermaid\ninvalid diagram\n```', true);
  await vi.waitFor(() => expect(target.querySelector('.mermaid-caption')?.textContent).toBe('Diagram could not be rendered'));
  expect((target.querySelector('.mermaid-source') as HTMLDetailsElement).open).toBe(true);
  expect(target.querySelector('.mermaid-source')?.textContent).toContain('invalid diagram');
});

test('renders valid chart blocks while leaving malformed chart data visible', () => {
  const target = document.createElement('div');
  renderer.renderMarkdown(target, '```chart\n{"type":"bar","title":"Sales","labels":["Q1"],"data":[10]}\n```\n\n```chart\nnot json\n```', true);
  expect(target.querySelector('.interactive-chart-card')?.textContent).toContain('Sales');
  expect(target.querySelectorAll('code.language-chart')).toHaveLength(1);
  expect(target.querySelector('code.language-chart')?.textContent).toContain('not json');
});

test('slide viewer returns to the first slide and supports fullscreen controls', () => {
  const viewer = renderer.createBobDeckViewer({ slides: [{ title: 'One' }, { title: 'Two' }] });
  document.body.append(viewer);
  const request = vi.fn().mockResolvedValue(undefined);
  viewer.requestFullscreen = request;
  (viewer.querySelector('.bobdeck-nav-next') as HTMLButtonElement).click();
  expect(viewer.querySelector('.bobdeck-counter')?.textContent).toBe('Slide 2 of 2');
  (viewer.querySelector('.bobdeck-nav-prev') as HTMLButtonElement).click();
  expect(viewer.querySelector('.bobdeck-counter')?.textContent).toBe('Slide 1 of 2');
  expect((viewer.querySelector('.bobdeck-nav-prev') as HTMLButtonElement).disabled).toBe(true);
  (viewer.querySelector('.bobdeck-btn-sm') as HTMLButtonElement).click();
  expect(request).toHaveBeenCalledOnce();
});
