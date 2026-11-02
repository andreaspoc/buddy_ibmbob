// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StructuredDiagram } from '../../src/components/StructuredDiagram';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.matchMedia = vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  window.HTMLElement.prototype.scrollIntoView = vi.fn();

  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('StructuredDiagram Component', () => {
  const sampleSpec = {
    kind: 'flow' as const,
    direction: 'LR' as const,
    nodes: [
      { id: 'client', label: 'Client Browser', shape: 'rect' as const, tone: 'neutral' as const },
      { id: 'gateway', label: 'API Gateway', shape: 'rounded' as const, tone: 'primary' as const },
    ],
    edges: [
      { id: 'e1', source: 'client', target: 'gateway', label: 'POST /query' },
    ],
  };

  it('renders diagram canvas and node elements', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSpec}
          source="flowchart LR\nclient --> gateway"
          streaming={false}
        />
      );
    });

    expect(host.querySelector('.structured-diagram')).not.toBeNull();
  });

  it('displays error message when error prop is present', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          source="invalid diagram source"
          streaming={false}
          error="Failed to parse diagram syntax"
        />
      );
    });

    expect(host.textContent).toContain('Failed to parse diagram syntax');
  });

  it('handles streaming state without crashing', async () => {
    await act(async () => {
      root.render(
        <StructuredDiagram
          spec={sampleSpec}
          source="flowchart LR\nclient"
          streaming={true}
        />
      );
    });

    expect(host.querySelector('.structured-diagram')).not.toBeNull();
  });
});
