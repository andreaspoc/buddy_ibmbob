// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOfficeHtmlBridge } from '../../src/lib/officeHtmlBridge';
import type { OfficeBridge, OfficeContext, OfficePlan } from '../../src/lib/officeBridge';

let hostDiv: HTMLDivElement;
let root: Root;

function TestBridgeHarness({
  fileId,
  readOnly = false,
  onBridge,
}: {
  fileId: string;
  readOnly?: boolean;
  onBridge: (b: OfficeBridge) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bridge = useOfficeHtmlBridge(containerRef, fileId, readOnly);
  onBridge(bridge);

  return (
    <div ref={containerRef} id="bridge-container">
      <iframe title="Test Slide Frame" />
    </div>
  );
}

describe('officeHtmlBridge useOfficeHtmlBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hostDiv = document.createElement('div');
    document.body.appendChild(hostDiv);
    root = createRoot(hostDiv);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    hostDiv.remove();
  });

  it('initializes bridge, checks ready, extracts context, and applies valid edit plan', async () => {
    let bridgeInstance!: OfficeBridge;

    await act(async () => {
      root.render(
        <TestBridgeHarness
          fileId="slide-123"
          readOnly={false}
          onBridge={(b) => {
            bridgeInstance = b;
          }}
        />
      );
    });

    const iframe = hostDiv.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    const doc = iframe.contentDocument;
    expect(doc).not.toBeNull();

    if (doc) {
      doc.body.innerHTML = `
        <div id="content">
          <h1>Original Title</h1>
          <p>Key architecture points</p>
          <button>Ignored Button</button>
        </div>
      `;
    }

    // Advance timer so interval detects document body
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(bridgeInstance.ready).toBe(true);

    // Extract context
    let ctx!: OfficeContext;
    await act(async () => {
      ctx = await bridgeInstance.context();
    });

    expect(ctx.kind).toBe('html');
    expect(ctx.text).toContain('Original Title');
    expect(ctx.text).toContain('Key architecture points');
    expect(ctx.html_nodes.length).toBe(2);
    expect(ctx.html_nodes[0].text).toBe('Original Title');

    // Apply valid plan
    const plan: OfficePlan = {
      kind: 'html',
      actions: [
        {
          type: 'html_update_text',
          index: 1,
          old_text: 'Original Title',
          text: 'Modernized Core Network Architecture',
        },
      ],
    };

    let result: any;
    await act(async () => {
      result = await bridgeInstance.apply(plan, ctx);
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(doc?.querySelector('h1')?.textContent).toBe('Modernized Core Network Architecture');
  });

  it('rejects read only modifications, invalid fingerprints, and mismatched old_text', async () => {
    let bridgeInstance!: OfficeBridge;

    await act(async () => {
      root.render(
        <TestBridgeHarness
          fileId="slide-ro"
          readOnly={true}
          onBridge={(b) => {
            bridgeInstance = b;
          }}
        />
      );
    });

    const iframe = hostDiv.querySelector('iframe') as HTMLIFrameElement;
    const doc = iframe.contentDocument;
    if (doc) {
      doc.body.innerHTML = '<h2>Title</h2>';
    }

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const dummyCtx: OfficeContext = {
      kind: 'html',
      text: 'Title',
      truncated: false,
      selection: '',
      html_nodes: [{ index: 1, text: 'Title', tag: 'h2' }],
      html_fingerprint: doc?.documentElement.outerHTML || '',
    };

    const plan: OfficePlan = {
      kind: 'html',
      actions: [
        {
          type: 'html_update_text',
          index: 1,
          old_text: 'Title',
          text: 'New Title',
        },
      ],
    };

    // 1. Read only error
    await expect(bridgeInstance.apply(plan, dummyCtx)).rejects.toThrow('This presentation is read only.');

    // Switch to writable
    await act(async () => {
      root.render(
        <TestBridgeHarness
          fileId="slide-ro"
          readOnly={false}
          onBridge={(b) => {
            bridgeInstance = b;
          }}
        />
      );
    });

    // 2. Fingerprint mismatch
    const badCtx = { ...dummyCtx, html_fingerprint: '<html>different</html>' };
    await expect(bridgeInstance.apply(plan, badCtx)).rejects.toThrow('The presentation changed');

    // 3. Invalid action old_text mismatch
    const badPlan: OfficePlan = {
      kind: 'html',
      actions: [
        {
          type: 'html_update_text',
          index: 1,
          old_text: 'Wrong text',
          text: 'New',
        },
      ],
    };
    await expect(bridgeInstance.apply(badPlan, dummyCtx)).rejects.toThrow('The HTML edit could not be applied safely');
  });
});
