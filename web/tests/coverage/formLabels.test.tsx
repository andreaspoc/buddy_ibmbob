// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import MemberChatAway from '../../src/components/MemberChatAway';

afterEach(() => { vi.unstubAllGlobals(); });

test('away-reply toggle has a meaningful label and changes when its label is clicked', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    enabled: false, instructions: '', starts_at: null, ends_at: null, active: false, ready: true,
  }) }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<MemberChatAway onBack={() => {}} />); });
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.labels).toHaveLength(1);
    expect(toggle.labels![0].textContent).toContain('Reply automatically while I’m away');
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.labels![0].click(); });
    expect(toggle.checked).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
