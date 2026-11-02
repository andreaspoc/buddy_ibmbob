// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectForm } from '../../src/components/ProjectForm';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); });
function mount(project: any) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const callbacks = { onSave: vi.fn(e => e.preventDefault()), onCancel: vi.fn(), onAsk: vi.fn(), onPreviewChange: vi.fn() };
  act(() => root.render(<ProjectForm project={project} busy={false} {...callbacks} />)); return callbacks;
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  expect(button, `button ${text}`).toBeTruthy(); act(() => button!.click());
}
function field(name: string) { return (host.querySelector(`input[type=hidden][name="${name}"]`) as HTMLInputElement).value; }

test('project schedule presets, lifecycle actions and discard preserve the saved values', () => {
  const callbacks = mount({ id: 'p1', name: 'Example', revision: 3, status: 'planned', stage: 'planning', start_date: '2026-01-31', due_date: '2026-03-01', tolerance_days: 7 });
  expect((host.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
  click('Schedule & Tolerances'); click('+1m'); click('±14d (2w)');
  expect(field('due_date')).toBe('2026-02-28'); expect(field('tolerance_days')).toBe('14');
  expect((host.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(false);
  click('Lifecycle & Actions'); click('Activate Project'); click('Preview Project Change');
  expect(field('status')).toBe('active'); expect(callbacks.onPreviewChange).toHaveBeenCalledOnce();
  click('Discard changes'); expect(field('status')).toBe('planned'); expect(field('due_date')).toBe('2026-03-01'); expect(field('tolerance_days')).toBe('7');
  expect((host.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
});

test('new project starts with creation disabled and can request planning help', () => {
  const callbacks = mount(null);
  expect((host.querySelector('button[type=submit]') as HTMLButtonElement).disabled).toBe(true);
  click('✨ Plan with Project Buddy'); expect(callbacks.onAsk).toHaveBeenCalledOnce();
  click('Stages & Governance'); click('Delivery'); expect(field('stage')).toBe('delivery');
  click('Schedule & Tolerances'); click('+1w'); expect(field('start_date')).not.toBe(''); expect(field('due_date')).not.toBe('');
});
