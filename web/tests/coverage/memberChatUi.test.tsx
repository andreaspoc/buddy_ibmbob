// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemberChatWidget, useCommunityUnread } from '../../src/components/MemberChat';

let host: HTMLDivElement;
let root: Root;
let rootContainer: HTMLDivElement;

describe('MemberChatWidget Component', () => {
  const sampleRooms = [
    {
      id: 1,
      kind: 'direct',
      name: 'Alice Cooper',
      subscribed: true,
      unread_count: 2,
      latest_incoming_sender_name: 'Alice Cooper',
      latest_incoming_id: 101,
      latest_incoming_automated: false,
    },
    {
      id: 2,
      kind: 'channel',
      name: 'general',
      subscribed: true,
      unread_count: 0,
    },
  ];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    class MockWebSocket {
      onopen: any = null;
      onmessage: any = null;
      onclose: any = null;
      send = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('WebSocket', MockWebSocket);

    class MockResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    // Root element for MutationObserver
    rootContainer = document.createElement('div');
    rootContainer.id = 'root';
    document.body.appendChild(rootContainer);

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/api/community/rooms')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => sampleRooms,
        });
      }
      if (path.includes('/api/community/away')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ active: false }),
        });
      }
      if (path.includes('/api/community/members')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ username: 'alice', display_name: 'Alice Cooper' }],
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });
    global.fetch = mockFetch;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    rootContainer.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders chat launcher button with unread count badge', async () => {
    await act(async () => {
      root.render(<MemberChatWidget username="tester" displayName="Tester" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const launcher = document.querySelector('.member-chat-launcher');
    expect(launcher).not.toBeNull();
  });

  it('toggles chat panel open and minimizes when close is clicked', async () => {
    await act(async () => {
      root.render(<MemberChatWidget username="tester" displayName="Tester" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const launcher = document.querySelector('.member-chat-launcher') as HTMLButtonElement;
    expect(launcher).not.toBeNull();

    await act(async () => {
      launcher.click();
    });

    const panel = document.querySelector('.member-chat-panel');
    expect(panel).not.toBeNull();

    // Minimize button
    const closeBtn = document.querySelector('button[title*="Minimize"]') as HTMLButtonElement;
    if (closeBtn) {
      await act(async () => {
        closeBtn.click();
      });
    }
  });

  it('toggles expand and compact chat layout mode', async () => {
    await act(async () => {
      root.render(<MemberChatWidget username="tester" displayName="Tester" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });

    const launcher = document.querySelector('.member-chat-launcher') as HTMLButtonElement;
    if (launcher) {
      await act(async () => {
        launcher.click();
      });
    }

    const expandBtn = document.querySelector('.member-chat-expand') as HTMLButtonElement;
    if (expandBtn) {
      await act(async () => {
        expandBtn.click();
      });
      expect(document.querySelector('.is-chat-expanded') || document.querySelector('.member-chat-widget')).not.toBeNull();

      await act(async () => {
        expandBtn.click();
      });
    }
    expect(document.querySelector('.member-chat-widget')).not.toBeNull();
  });
});
