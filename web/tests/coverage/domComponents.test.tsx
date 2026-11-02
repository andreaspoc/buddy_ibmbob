// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatView } from '../../src/components/ChatView';
import { HtmlDeckViewer } from '../../src/components/HtmlDeckViewer';
// @ts-expect-error plain JS JSX component outside web tsconfig
import DecisionTableTab from '../../../decisions-buddy/src/components/DecisionTableTab.jsx';

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

describe('DecisionTableTab', () => {
  it('returns null when model is absent', async () => {
    await act(async () => {
      root.render(<DecisionTableTab model={null} />);
    });
    expect(host.innerHTML).toBe('');
  });

  it('renders tile when no decisionTableNode is present in model', async () => {
    const model = {
      id: 'm1',
      version: 1,
      graph: { nodes: [] },
    };
    await act(async () => {
      root.render(<DecisionTableTab model={model} />);
    });
    expect(host.textContent).toContain('No Decision Table node found in this model.');
  });

  it('renders decision table with inputs, outputs, and rules', async () => {
    const model = {
      id: 'm1',
      version: 1,
      graph: {
        nodes: [
          {
            id: 'node-1',
            type: 'decisionTableNode',
            content: {
              hitPolicy: 'first',
              inputs: [
                { id: 'in1', name: 'Age', field: 'age' },
              ],
              outputs: [
                { id: 'out1', name: 'Eligible', field: 'eligible' },
              ],
              rules: [
                { _id: 'r1', in1: '>= 18', out1: 'true', _description: 'Adult check' },
              ],
            },
          },
        ],
      },
    };

    await act(async () => {
      root.render(
        <DecisionTableTab
          model={model}
          onUpdateModel={vi.fn()}
          onEvaluate={vi.fn()}
          onSaveToDb={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain('Age');
    expect(host.textContent).toContain('Eligible');
    expect(host.textContent).toContain('Adult check');
  });
});

describe('HtmlDeckViewer', () => {
  it('renders slides container, header and slide navigation controls', async () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Quarterly Review</title></head>
<body>
  <section class="slide" id="slide-1">
    <h1>Quarterly Review</h1>
    <p>Q3 Performance highlights</p>
  </section>
  <section class="slide" id="slide-2">
    <h2>Financial Results</h2>
    <p>Revenue grew 15% year-over-year</p>
  </section>
</body>
</html>`;

    await act(async () => {
      root.render(
        <HtmlDeckViewer
          htmlContent={html}
          title="Quarterly Review"
          filename="review.html"
          sessionId="sess-123"
        />
      );
    });

    expect(host.textContent).toContain('Quarterly Review');
    expect(host.querySelector('iframe')).not.toBeNull();
  });

  it('renders presentation incomplete warning when html content is below readiness threshold', async () => {
    const incompleteDeck = `<!DOCTYPE html><html><body><section class="slide"><h1>Short</h1></section></body></html>`;
    await act(async () => {
      root.render(<HtmlDeckViewer htmlContent={incompleteDeck} filename="deck.html" />);
    });

    expect(host.textContent).toContain('Presentation Generation Incomplete');
  });
});

describe('ChatView', () => {
  const baseChatProps = {
    messages: [],
    isStreaming: false,
    activeMode: 'chat',
    slideCount: 3,
    onSlideCountChange: vi.fn(),
    activeAgent: 'default',
    modes: [{ id: 'chat', label: 'Chat', icon: 'chat' }],
    skills: [],
    agents: [],
    templates: [],
    selectedTemplateId: 'default',
    onSendMessage: vi.fn(),
    onApprovalDecision: vi.fn().mockResolvedValue(undefined),
    onUploadFile: vi.fn().mockResolvedValue({ id: 'f1', name: 'test.png', size: 123 } as any),
    onStop: vi.fn(),
    onOpenTemplateModal: vi.fn(),
  };

  it('renders empty chat state when message list is empty', async () => {
    await act(async () => {
      root.render(<ChatView {...baseChatProps} />);
    });

    const textarea = host.querySelector('textarea');
    expect(textarea).not.toBeNull();
  });

  it('renders user and assistant messages with markdown content', async () => {
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: 'Explain system architecture',
      },
      {
        id: 'msg-2',
        role: 'assistant' as const,
        content: 'Here is the **system architecture** overview with robust security.',
      },
    ];

    await act(async () => {
      root.render(<ChatView {...baseChatProps} messages={messages} />);
    });

    expect(host.textContent).toContain('Explain system architecture');
    expect(host.textContent).toContain('system architecture');
    const strongs = Array.from(host.querySelectorAll('strong')).map(s => s.textContent);
    expect(strongs).toContain('system architecture');
  });

  it('allows typing into the composer and triggering send', async () => {
    const onSendMessage = vi.fn();
    await act(async () => {
      root.render(<ChatView {...baseChatProps} onSendMessage={onSendMessage} />);
    });

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      valueSetter?.call(textarea, 'New question for Bob');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const form = host.querySelector('form.composer') as HTMLFormElement;
    expect(form).not.toBeNull();

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSendMessage).toHaveBeenCalledWith('New question for Bob', undefined, undefined, undefined, undefined);
  });
});
