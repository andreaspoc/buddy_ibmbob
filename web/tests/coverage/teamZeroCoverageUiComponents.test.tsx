// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Target Components
import { AnalysisWorkspace } from '../../src/components/AnalysisWorkspace';
import { SkillsManager } from '../../src/components/SkillsManager';
import { ClarificationCard } from '../../src/components/ClarificationCard';
import { ProjectModal } from '../../src/components/ProjectModal';
import { AppDialog, appConfirm, appAlert } from '../../src/components/AppDialog';
import { ProductivityWorkspace } from '../../src/components/ProductivityWorkspace';
import { ConversationDocumentViewer } from '../../src/components/ConversationDocumentViewer';
import { OfficeFilePopup } from '../../src/components/OfficeFilePopup';
import { OfficeChatReferences, OfficeReferenceChips } from '../../src/components/OfficeChatReferences';
import { InteractiveAction } from '../../src/components/InteractiveAction';
import { DocumentComparison } from '../../src/components/DocumentComparison';
import { QuizResultsCard } from '../../src/components/QuizResultsCard';
import { SkillEditModal } from '../../src/components/SkillEditModal';
import { AnswerSteps } from '../../src/components/AnswerSteps';
import { ProjectMemoryPanel } from '../../src/components/ProjectMemoryPanel';
import { SaveToOfficeButton } from '../../src/components/SaveToOfficeButton';
import { MCPManager } from '../../src/components/MCPManager';
import { BulkUserEditor } from '../../src/components/BulkUserEditor';
import { EmailNote } from '../../src/components/EmailNote';
import { ManagedUserEditor } from '../../src/components/ManagedUserEditor';
import { DocmostPanel } from '../../src/components/DocmostPanel';
import { LiveHtmlSlides } from '../../src/components/LiveHtmlSlides';
import { DeckFormatChoiceModal } from '../../src/components/DeckFormatChoiceModal';
import { ProjectPublishModal } from '../../src/components/ProjectPublishModal';

// Target Libs
import { syncPresentationDocument } from '../../src/lib/presentationDom';
import { startWorkspaceUpdates } from '../../src/lib/workspaceUpdates';
import { trackInputModality } from '../../src/lib/inputModality';
import { waitForBackgroundSave } from '../../src/lib/backgroundSave';
import { createRequestId } from '../../src/lib/requestId';

// APIs & Types
import * as api from '../../src/api';
import { navigateOffice } from '../../src/lib/officeUrl';
import type { QuizResult } from '../../src/lib/quiz';
import type { MCPServer, ManagedUser, Skill, ChatMessage } from '../../src/types';

// Mocks
vi.mock('../../src/api', () => ({
  createProjectGit: vi.fn(),
  uploadProjectZip: vi.fn(),
  uploadProjectFolder: vi.fn(),
  publishProject: vi.fn(),
  fetchSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  fetchSkills: vi.fn(),
}));

vi.mock('../../src/lib/officeUrl', () => ({
  navigateOffice: vi.fn(),
}));

vi.mock('../../src/components/MarkdownView', () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="markdown-view">{content}</div>,
}));

vi.mock('../../src/components/MCPCatalog', () => ({
  MCPCatalog: ({ isAdmin, onChanged }: any) => (
    <div data-testid="mock-mcp-catalog" data-admin={String(isAdmin)}>
      <button type="button" onClick={() => onChanged?.()}>Mock Catalog Changed</button>
    </div>
  ),
}));

vi.mock('../../src/components/MCPConnectionCard', () => ({
  MCPConnectionCard: ({ server, isAdmin, onRefresh, onConfigure, onDelete }: any) => (
    <div data-testid={`mock-mcp-card-${server.name}`}>
      <span>{server.name}</span>
      <button type="button" onClick={() => onRefresh?.()}>Refresh {server.name}</button>
      {onConfigure && <button type="button" onClick={() => onConfigure(server.name)}>Configure {server.name}</button>}
      {onDelete && <button type="button" onClick={() => onDelete(server.name)}>Delete {server.name}</button>}
    </div>
  ),
}));

let host: HTMLDivElement;
let root: Root;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeInputValue(el: HTMLElement, value: string) {
  if (el instanceof HTMLSelectElement) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    (el as any).value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const res = handler(url, init);
    if (res instanceof Promise) return res;
    if (res && typeof res.status === 'number') {
      return Promise.resolve({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.body,
        text: async () => typeof res.body === 'string' ? res.body : JSON.stringify(res.body),
      } as any);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => res,
      text: async () => typeof res === 'string' ? res : JSON.stringify(res),
    } as any);
  });
}

describe('teamZeroCoverageUiComponents - Full Suite', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.show = vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    });

    if (!HTMLElement.prototype.showPopover) {
      HTMLElement.prototype.showPopover = vi.fn();
    }
    if (!HTMLElement.prototype.hidePopover) {
      HTMLElement.prototype.hidePopover = vi.fn();
    }

    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    }

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get() {
        return {
          postMessage: vi.fn(),
        };
      },
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  // ==========================================
  // 1. Lib: requestId.ts
  // ==========================================
  describe('createRequestId', () => {
    it('generates standard UUID using native crypto.randomUUID when available', () => {
      const orig = crypto.randomUUID;
      try {
        crypto.randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
        const id = createRequestId();
        expect(id).toBe('11111111-2222-4333-8444-555555555555');
        expect(crypto.randomUUID).toHaveBeenCalled();
      } finally {
        crypto.randomUUID = orig;
      }
    });

    it('falls back to crypto.getRandomValues when randomUUID is not a function', () => {
      const orig = crypto.randomUUID;
      try {
        (crypto as any).randomUUID = undefined;
        const id = createRequestId();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      } finally {
        crypto.randomUUID = orig;
      }
    });
  });

  // ==========================================
  // 2. Lib: backgroundSave.ts
  // ==========================================
  describe('waitForBackgroundSave', () => {
    it('returns immediately when status is ready', async () => {
      const read = vi.fn().mockResolvedValue({ status: 'completed', data: 42 });
      const signal = new AbortController().signal;
      const res = await waitForBackgroundSave('job-1', read, signal);
      expect(res.status).toBe('completed');
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('polls while running/queued and pauses between checks', async () => {
      let callCount = 0;
      const read = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { status: 'queued' };
        if (callCount === 2) return { status: 'running' };
        return { status: 'succeeded' };
      });
      const pause = vi.fn().mockResolvedValue(undefined);
      const signal = new AbortController().signal;
      const res = await waitForBackgroundSave('job-2', read, signal, pause);
      expect(res.status).toBe('succeeded');
      expect(callCount).toBe(3);
      expect(pause).toHaveBeenCalledTimes(2);
    });

    it('throws when abort signal is triggered', async () => {
      const controller = new AbortController();
      controller.abort();
      const read = vi.fn();
      await expect(waitForBackgroundSave('job-3', read, controller.signal)).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // 3. Lib: inputModality.ts
  // ==========================================
  describe('trackInputModality', () => {
    it('tracks pointer and keyboard transitions and restores on cleanup', () => {
      const rootEl = document.documentElement;
      delete rootEl.dataset.inputModality;

      const stop = trackInputModality();
      expect(rootEl.dataset.inputModality).toBe('keyboard');

      document.dispatchEvent(new PointerEvent('pointerdown'));
      expect(rootEl.dataset.inputModality).toBe('pointer');

      // non-Tab key does not switch to keyboard
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(rootEl.dataset.inputModality).toBe('pointer');

      // Tab key switches to keyboard
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      expect(rootEl.dataset.inputModality).toBe('keyboard');

      stop();
      expect(rootEl.dataset.inputModality).toBeUndefined();
    });

    it('restores previous inputModality value if it existed before', () => {
      const rootEl = document.documentElement;
      rootEl.dataset.inputModality = 'custom-modality';

      const stop = trackInputModality();
      expect(rootEl.dataset.inputModality).toBe('keyboard');

      stop();
      expect(rootEl.dataset.inputModality).toBe('custom-modality');
      delete rootEl.dataset.inputModality;
    });
  });

  // ==========================================
  // 4. Lib: workspaceUpdates.ts
  // ==========================================
  describe('startWorkspaceUpdates', () => {
    it('forwards local window events to broadcast channel and receives remote events', () => {
      const postMessageSpy = vi.fn();
      const closeSpy = vi.fn();
      let messageHandler: ((e: any) => void) | null = null;

      class MockBroadcastChannel {
        name: string;
        constructor(name: string) {
          this.name = name;
        }
        postMessage = postMessageSpy;
        close = closeSpy;
        set onmessage(fn: any) {
          messageHandler = fn;
        }
      }
      (window as any).BroadcastChannel = MockBroadcastChannel;

      const cleanup = startWorkspaceUpdates();
      expect(window.BroadcastChannel).toBeDefined();

      // Trigger local window events
      window.dispatchEvent(new Event('buddy-notes-changed'));
      expect(postMessageSpy).toHaveBeenCalledWith('buddy-notes-changed');

      window.dispatchEvent(new Event('buddy-office-changed'));
      expect(postMessageSpy).toHaveBeenCalledWith('buddy-office-changed');

      // Simulate receiving remote messages on channel
      const localListener = vi.fn();
      window.addEventListener('buddy-notes-changed', localListener);

      messageHandler?.({ data: 'buddy-notes-changed' });
      expect(localListener).toHaveBeenCalled();

      // Unknown message data is ignored
      const unknownListener = vi.fn();
      window.addEventListener('unknown-event' as any, unknownListener);
      messageHandler?.({ data: 'unknown-event' });
      expect(unknownListener).not.toHaveBeenCalled();

      window.removeEventListener('buddy-notes-changed', localListener);
      window.removeEventListener('unknown-event' as any, unknownListener);
      cleanup();
      expect(closeSpy).toHaveBeenCalled();
    });

    it('gracefully handles missing BroadcastChannel in environment', () => {
      const orig = (window as any).BroadcastChannel;
      try {
        (window as any).BroadcastChannel = undefined;
        const cleanup = startWorkspaceUpdates();
        expect(() => {
          window.dispatchEvent(new Event('buddy-notes-changed'));
        }).not.toThrow();
        cleanup();
      } finally {
        (window as any).BroadcastChannel = orig;
      }
    });
  });

  // ==========================================
  // 5. Lib: presentationDom.ts
  // ==========================================
  describe('syncPresentationDocument', () => {
    it('patches text nodes, attributes, and adds/removes elements', () => {
      const doc = document.implementation.createHTMLDocument('Test');
      doc.body.innerHTML = '<div id="container" class="old"><span id="txt">Hello</span><p id="rem">Remove me</p></div>';

      const nextHtml = '<!doctype html><html><head></head><body><div id="container" class="new" data-test="true"><span id="txt">World</span><b>Added</b></div></body></html>';
      syncPresentationDocument(doc, nextHtml);

      const container = doc.getElementById('container');
      expect(container?.getAttribute('class')).toBe('new');
      expect(container?.getAttribute('data-test')).toBe('true');
      expect(doc.getElementById('txt')?.textContent).toBe('World');
      expect(doc.getElementById('rem')).toBeNull();
      expect(doc.querySelector('b')?.textContent).toBe('Added');
    });

    it('preserves canvas width, height, and style attributes', () => {
      const doc = document.implementation.createHTMLDocument('Test Canvas');
      doc.body.innerHTML = '<div><canvas id="c1" width="400" height="300" style="color:red" data-custom="old"></canvas></div>';

      // Next html omits width, height, style, but updates data-custom
      const nextHtml = '<!doctype html><html><body><div><canvas id="c1" data-custom="new"></canvas></div></body></html>';
      syncPresentationDocument(doc, nextHtml);

      const canvas = doc.getElementById('c1') as HTMLCanvasElement;
      expect(canvas.getAttribute('width')).toBe('400');
      expect(canvas.getAttribute('height')).toBe('300');
      expect(canvas.getAttribute('style')).toBe('color:red');
      expect(canvas.getAttribute('data-custom')).toBe('new');
    });

    it('preserves runtime helper elements and queues executable scripts', async () => {
      const doc = document.implementation.createHTMLDocument('Test Helpers');
      doc.body.innerHTML = '<div><div id="bob-nav-fix-style">Keep</div><span id="old-child">Remove</span></div>';

      const nextHtml = '<!doctype html><html><body><div><script id="new-script">window.testRun = 1;</script></div></body></html>';
      syncPresentationDocument(doc, nextHtml);

      expect(doc.getElementById('bob-nav-fix-style')).not.toBeNull();
      expect(doc.getElementById('old-child')).toBeNull();
      const scriptQueue = (doc as any).bobScriptQueue;
      expect(scriptQueue).toBeDefined();
      await scriptQueue;
    });

    it('restores element and window scroll positions', () => {
      const doc = document.implementation.createHTMLDocument('Scroll Test');
      const win = doc.defaultView as any;
      if (win) {
        win.scrollY = 50;
        win.scrollX = 20;
        win.scrollTo = vi.fn();
      }
      doc.body.innerHTML = '<div id="scroller" style="overflow:auto">Content</div>';
      const scroller = doc.getElementById('scroller')!;
      scroller.scrollTop = 120;
      scroller.scrollLeft = 40;

      const nextHtml = '<!doctype html><html><body><div id="scroller" style="overflow:auto">Updated Content</div></body></html>';
      syncPresentationDocument(doc, nextHtml);

      expect(scroller.scrollTop).toBe(120);
      expect(scroller.scrollLeft).toBe(40);
    });
  });

  // ==========================================
  // 6. Component: ClarificationCard.tsx
  // ==========================================
  describe('ClarificationCard', () => {
    const questions = [
      {
        question: 'What is the primary target group?',
        context: 'Customer care vs Engineering',
        options: ['Tier 1 Agents', 'Network Engineers', 'All Staff'],
      },
      {
        question: 'What is the priority level?',
        options: ['Standard', 'Urgent'],
      },
    ];

    it('renders questions and handles predefined option selection and submission', async () => {
      const onReply = vi.fn();
      await render(
        <ClarificationCard questions={questions} disabled={false} answered={false} onReply={onReply} />
      );

      expect(host.querySelector('.clarification-title')?.textContent).toContain('Follow-up questions');
      expect(host.querySelector('.clarification-status')?.textContent).toBe('0 of 2 answered');
      expect(host.querySelector('.clarification-context-pill')?.textContent).toBe('Customer care vs Engineering');

      const submitBtn = host.querySelector('.clarification-submit-btn') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);

      // Select option 1 for Q1
      const radioQ1 = host.querySelectorAll('input[type="radio"]')[0] as HTMLInputElement;
      await act(async () => {
        radioQ1.click();
      });
      expect(host.querySelector('.clarification-status')?.textContent).toBe('1 of 2 answered');

      // Select option 1 for Q2 (Standard)
      // options for Q1: 3 + 1(custom) = 4 radios. Q2 starts at index 4
      const radioQ2 = host.querySelectorAll('input[type="radio"]')[4] as HTMLInputElement;
      await act(async () => {
        radioQ2.click();
      });

      expect(host.querySelector('.clarification-status')?.textContent).toBe('2 of 2 answered');
      expect(submitBtn.disabled).toBe(false);

      // Submit form
      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(onReply).toHaveBeenCalledTimes(1);
      expect(onReply.mock.calls[0][0]).toContain('Tier 1 Agents');
      expect(onReply.mock.calls[0][0]).toContain('Standard');
    });

    it('allows writing custom answer and submits via Ctrl+Enter', async () => {
      const onReply = vi.fn();
      await render(
        <ClarificationCard questions={[questions[0]]} disabled={false} answered={false} onReply={onReply} />
      );

      // Select "Write my own answer"
      const customRadio = host.querySelectorAll('input[type="radio"]')[3] as HTMLInputElement;
      await act(async () => {
        customRadio.click();
      });

      const textarea = host.querySelector('.clarification-custom-textarea') as HTMLTextAreaElement;
      expect(textarea).not.toBeNull();

      await act(async () => {
        setNativeInputValue(textarea, 'Custom Department Team');
      });

      // Press Ctrl+Enter to submit
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      });

      expect(onReply).toHaveBeenCalledWith(expect.stringContaining('Custom Department Team'));
    });

    it('handles cancellation and answered state rendering', async () => {
      const onReply = vi.fn();
      await render(
        <ClarificationCard questions={questions} disabled={false} answered={false} onReply={onReply} />
      );

      const cancelBtn = host.querySelector('.clarification-cancel-btn') as HTMLButtonElement;
      await act(async () => {
        cancelBtn.click();
      });
      expect(onReply).toHaveBeenCalledWith(expect.stringContaining('cancel'));

      // Re-render as cancelled
      await render(
        <ClarificationCard questions={questions} disabled={false} answered={false} cancelled={true} onReply={onReply} />
      );
      expect(host.querySelector('.clarification-card.is-cancelled')).not.toBeNull();
      expect(host.querySelector('.clarification-status')?.textContent).toBe('Form cancelled');
      expect(host.querySelector('.clarification-actions-bar')).toBeNull();

      // Re-render as answered
      await render(
        <ClarificationCard questions={questions} disabled={false} answered={true} onReply={onReply} />
      );
      expect(host.querySelector('.clarification-card.is-answered')).not.toBeNull();
      expect(host.querySelector('.clarification-status')?.textContent).toBe('Reply sent');
    });
  });

  // ==========================================
  // 7. Component: InteractiveAction.tsx
  // ==========================================
  describe('InteractiveAction', () => {
    it('renders save_note and submits successfully to api', async () => {
      mockFetch((url, init) => {
        if (url === '/api/interactive/actions' && init?.method === 'POST') {
          return { message: 'Note draft saved successfully.' };
        }
        return { status: 404 };
      });

      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      await render(
        <InteractiveAction
          title="Project Proposal"
          body="## Background\nScope details."
          operation="save_note"
          sessionId="sess-123"
        />
      );

      expect(host.querySelector('.ia-action-title')?.textContent).toBe('Save Draft to My Notes');
      expect(host.querySelector('.ia-action-session-tag')?.textContent).toContain('Active Session');

      const titleInput = host.querySelector('.ia-text-input') as HTMLInputElement;
      expect(titleInput.value).toBe('Project Proposal');

      const submitBtn = host.querySelector('.ia-submit-btn') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(host.querySelector('.cds--inline-notification--success')?.textContent).toContain('Note draft saved successfully.');
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'buddy-notes-changed' }));
    });

    it('renders email_note and handles recipient validation and error', async () => {
      mockFetch(() => ({ status: 500, body: { detail: 'Mail server unreachable.' } }));

      await render(
        <InteractiveAction
          title="Deployment Summary"
          body="Status: Done."
          operation="email_note"
          sessionId="sess-999"
        />
      );

      expect(host.querySelector('.ia-action-title')?.textContent).toBe('Send Markdown Note via Email');
      const emailInput = host.querySelectorAll('.ia-text-input')[1] as HTMLInputElement;
      expect(emailInput.type).toBe('email');

      await act(async () => {
        setNativeInputValue(emailInput, 'architect@example.com');
      });

      const submitBtn = host.querySelector('.ia-submit-btn') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(host.querySelector('.cds--inline-notification--error')?.textContent).toContain('Mail server unreachable.');
    });

    it('shows warning notification when sessionId is missing', async () => {
      await render(
        <InteractiveAction
          title="Standalone Draft"
          body="Content."
          operation="save_note"
        />
      );

      expect(host.querySelector('.cds--inline-notification--info')?.textContent).toContain('Open this conversation in active chat');
      const submitBtn = host.querySelector('.ia-submit-btn') as HTMLButtonElement;
      expect(submitBtn.disabled).toBe(true);
    });
  });

  // ==========================================
  // 8. Component: QuizResultsCard.tsx
  // ==========================================
  describe('QuizResultsCard', () => {
    const mockResult: QuizResult = {
      quiz_key: 'quiz-opt-1',
      title: 'Fiber Optics Fundamentals',
      total_points: 3.5,
      eligible_questions: 4,
      percentage: 88,
      reading_status: 'Read recommended documentation to solidify concepts.',
      questions: [
        {
          id: 'q1',
          question: 'What is single mode core size?',
          submitted_answer: '9 microns',
          correct_answer: '9 microns',
          score: 1,
          explanation: 'Single mode fiber typically has an 8 to 10 micron core.',
          resources: [],
        },
        {
          id: 'q2',
          question: 'Which waveband is O-band?',
          submitted_answer: '1550 nm',
          correct_answer: '1260 - 1360 nm',
          score: 0,
          explanation: 'O-band stands for Original Band.',
          source: 'ITU-T G.692',
          study_topic: 'Wavelength bands',
          resources: [
            {
              title: 'ITU-T Optical Bands Guide',
              url: 'https://example.com/itu-bands',
              why: 'Covers spectral bands O through U.',
            },
          ],
        },
        {
          id: 'q3',
          question: 'Select optical connectors with angle polish.',
          submitted_answer: ['SC/APC', 'LC/UPC'],
          correct_answer: ['SC/APC', 'FC/APC'],
          score: 0.5,
          explanation: 'APC indicates Angled Physical Contact.',
          resources: [],
        },
        {
          id: 'q4',
          question: 'Explain dispersion compensation.',
          submitted_answer: 'Using DCF fibers.',
          correct_answer: 'Dispersion compensating fibers or Bragg gratings.',
          score: null,
          explanation: 'Needs human instructor grading.',
          review_reason: 'Subjective written evaluation required.',
          resources: [],
        },
      ],
    };

    it('renders result breakdown, filters questions, toggles explanations, and marks resources read', async () => {
      const onPractice = vi.fn();
      await render(
        <QuizResultsCard result={mockResult} sessionId="sess-quiz" disabled={false} onPractice={onPractice} />
      );

      expect(host.querySelector('.quiz-header h3')?.textContent).toContain('Fiber Optics Fundamentals');
      expect(host.querySelector('.quiz-score')?.textContent).toContain('3.5/4 · 88%');
      expect(host.querySelector('.quiz-instructions')?.textContent).toContain('1 correct · 1 partially correct · 1 incorrect · 1 need review');

      // Filter by 'missed'
      const filterBtns = host.querySelectorAll('.quiz-review-toolbar button');
      await act(async () => {
        (filterBtns[1] as HTMLButtonElement).click(); // 'Missed questions'
      });
      const missedArticles = host.querySelectorAll('.quiz-review-question');
      expect(missedArticles.length).toBe(2); // q2 (score 0) and q3 (score 0.5)

      // Toggle explanation on question 2
      const expBtn = missedArticles[0].querySelector('.quiz-explanation-toggle') as HTMLButtonElement;
      await act(async () => {
        expBtn.click();
      });
      expect(missedArticles[0].textContent).toContain('ITU-T Optical Bands Guide');

      // Mark resource as read
      const readCheckbox = missedArticles[0].querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(readCheckbox.checked).toBe(false);
      await act(async () => {
        readCheckbox.click();
      });
      expect(readCheckbox.checked).toBe(true);

      // Expand all explanations
      await act(async () => {
        (filterBtns[4] as HTMLButtonElement).click(); // 'Expand explanations'
      });

      // Practice missed topics button
      const practiceBtn = host.querySelector('.quiz-actions button') as HTMLButtonElement;
      await act(async () => {
        practiceBtn.click();
      });
      expect(onPractice).toHaveBeenCalledWith(expect.stringContaining('Wavelength bands'));
    });
  });

  // ==========================================
  // 9. Component: AnswerSteps.tsx
  // ==========================================
  describe('AnswerSteps', () => {
    it('returns null when there are no stages, activities, or progress summary', async () => {
      const answer: ChatMessage = {
        id: 'msg-empty',
        role: 'assistant',
        content: '',
      };
      await render(<AnswerSteps answer={answer} progressSummary="" />);
      expect(host.innerHTML).toBe('');
    });

    it('renders journey stages, progress summary, and workLog activities', async () => {
      const answer: ChatMessage = {
        id: 'msg-full',
        role: 'assistant',
        content: 'Completed task.',
        deliveryState: 'completed',
        answerReadyAt: 1700000010000,
        createdAt: '2026-10-30T10:00:00Z',
        workLog: [
          { text: 'Queried vector index', state: 'completed' },
          { text: 'Synthesizing response', state: 'running' },
        ],
      };

      await render(<AnswerSteps answer={answer} progressSummary="Processing 2 data sources..." />);

      expect(host.querySelector('.answer-journey-heading h3')?.textContent).toBe('Steps');
      expect(host.querySelector('.answer-progress-summary')?.textContent).toBe('Processing 2 data sources...');
      const activityItems = host.querySelectorAll('.answer-activity-list li');
      expect(activityItems.length).toBe(2);
      expect(activityItems[0].textContent).toContain('Queried vector index');
    });
  });

  // ==========================================
  // 10. Component: SaveToOfficeButton.tsx
  // ==========================================
  describe('SaveToOfficeButton', () => {
    it('renders nothing for unsupported file extensions', async () => {
      await render(<SaveToOfficeButton sessionId="sess-1" path="archive.unknown" />);
      expect(host.innerHTML).toBe('');
    });

    it('opens dialog, loads folders, and saves copy to office suite', async () => {
      mockFetch((url, init) => {
        if (url === '/api/office/chat-capabilities') {
          return { version: 1 };
        }
        if (url === '/api/office/folders') {
          return { items: [{ id: 'f-1', name: 'Strategic Reports', parent_id: null }] };
        }
        if (url === '/api/office/import-conversation' && init?.method === 'POST') {
          return { id: 'office-doc-99' };
        }
        return { status: 404 };
      });

      await render(<SaveToOfficeButton sessionId="sess-1" path="/output/Q3_Audit.docx" />);

      const triggerBtn = host.querySelector('button') as HTMLButtonElement;
      expect(triggerBtn.textContent).toContain('Save a copy to Office Suite');

      await act(async () => {
        triggerBtn.click();
      });

      expect(host.querySelector('.save-office-dialog')).not.toBeNull();
      expect(host.querySelector('.save-office-header strong')?.textContent).toBe('Q3_Audit.docx');

      const saveBtn = host.querySelector('.save-office-dialog button[type="button"]:not([autofocus])') as HTMLButtonElement;
      await act(async () => {
        saveBtn.click();
      });

      expect(host.querySelector('[role="status"]')?.textContent).toContain('Copy saved to Office Suite.');

      const openBtn = host.querySelector('.save-office-dialog button:first-of-type') as HTMLButtonElement;
      await act(async () => {
        openBtn.click();
      });
      expect(navigateOffice).toHaveBeenCalledWith('/office/files/office-doc-99');
    });
  });

  // ==========================================
  // 11. Component: EmailNote.tsx
  // ==========================================
  describe('EmailNote', () => {
    it('renders modal dialog, submits recipient email, and displays confirmation', async () => {
      mockFetch((url, init) => {
        if (url === '/api/notes/42/email' && init?.method === 'POST') {
          return { message: 'Note sent to user@domain.com' };
        }
        return { status: 404 };
      });

      const onClose = vi.fn();
      await render(<EmailNote note={{ id: 42, title: 'Network Maintenance Plan' }} onClose={onClose} />);

      expect(host.querySelector('#email-note-title')?.textContent).toBe('Send note as email');
      const emailInput = host.querySelector('input[type="email"]') as HTMLInputElement;

      await act(async () => {
        setNativeInputValue(emailInput, 'user@domain.com');
      });

      const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      expect(host.querySelector('[role="status"]')?.textContent).toBe('Note sent to user@domain.com');

      const closeBtn = host.querySelector('.notes-revision-actions button') as HTMLButtonElement;
      await act(async () => {
        closeBtn.click();
      });
      expect(onClose).toHaveBeenCalled();
    });

    it('handles email delivery failure error', async () => {
      mockFetch(() => ({ status: 400, body: { detail: 'Invalid recipient address' } }));

      const onClose = vi.fn();
      await render(<EmailNote note={{ id: 42, title: 'Note 42' }} onClose={onClose} />);

      const emailInput = host.querySelector('input[type="email"]') as HTMLInputElement;
      await act(async () => {
        setNativeInputValue(emailInput, 'invalid');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Invalid recipient address');
    });
  });

  // ==========================================
  // 12. Component: DeckFormatChoiceModal.tsx
  // ==========================================
  describe('DeckFormatChoiceModal', () => {
    it('returns null when isOpen is false', async () => {
      await render(
        <DeckFormatChoiceModal
          isOpen={false}
          slideCount={5}
          onSlideCountChange={vi.fn()}
          onClose={vi.fn()}
          onChoosePptx={vi.fn()}
          onChooseHtml={vi.fn()}
        />
      );
      expect(host.innerHTML).toBe('');
    });

    it('renders options, changes slide count, and triggers format selection callbacks', async () => {
      const onSlideCountChange = vi.fn();
      const onClose = vi.fn();
      const onChoosePptx = vi.fn();
      const onChooseHtml = vi.fn();

      await render(
        <DeckFormatChoiceModal
          isOpen={true}
          slideCount={8}
          onSlideCountChange={onSlideCountChange}
          onClose={onClose}
          onChoosePptx={onChoosePptx}
          onChooseHtml={onChooseHtml}
        />
      );

      expect(host.querySelector('.format-choice-card')).not.toBeNull();

      // Change slide count
      const selectEl = host.querySelector('.slide-count-picker select') as HTMLSelectElement;
      await act(async () => {
        setNativeInputValue(selectEl, '12');
      });
      expect(onSlideCountChange).toHaveBeenCalledWith(12);

      // Choose PPTX with Space key
      const pptxCard = host.querySelector('.format-card-pptx') as HTMLElement;
      await act(async () => {
        pptxCard.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      });
      expect(onChoosePptx).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      // Choose HTML with Space key
      const htmlCard = host.querySelector('.format-card-html') as HTMLElement;
      await act(async () => {
        htmlCard.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      });
      expect(onChooseHtml).toHaveBeenCalledTimes(1);

      // Click Close button
      const closeBtn = host.querySelector('.dialog-close') as HTMLButtonElement;
      await act(async () => {
        closeBtn.click();
      });
      expect(onClose).toHaveBeenCalled();

      // Click Backdrop button
      const backdropBtn = host.querySelector('.agent-edit-backdrop') as HTMLButtonElement;
      await act(async () => {
        backdropBtn.click();
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ==========================================
  // 13. Component: AppDialog.tsx
  // ==========================================
  describe('AppDialog', () => {
    it('manages confirmation queue with confirm and cancel flows', async () => {
      await render(<AppDialog />);

      let confirmPromise: Promise<boolean>;
      act(() => {
        confirmPromise = appConfirm('Delete this document permanently?');
      });

      expect(host.querySelector('#app-dialog-message')?.textContent).toBe('Delete this document permanently?');

      // Click Confirm
      const confirmBtn = host.querySelector('.app-dialog-primary') as HTMLButtonElement;
      await act(async () => {
        confirmBtn.click();
      });

      const res = await confirmPromise!;
      expect(res).toBe(true);

      // Test cancel flow
      let cancelPromise: Promise<boolean>;
      act(() => {
        cancelPromise = appConfirm('Discard unsaved edits?');
      });
      const cancelBtn = host.querySelector('.app-dialog-actions button') as HTMLButtonElement;
      await act(async () => {
        cancelBtn.click();
      });
      const resCancel = await cancelPromise!;
      expect(resCancel).toBe(false);
    });

    it('renders notices via appAlert and auto-dismisses', async () => {
      vi.useFakeTimers();
      await render(<AppDialog />);

      await act(async () => {
        void appAlert('Operation finished successfully.', 'success');
        void appAlert('Database connection failed.', 'error');
      });

      const notices = document.querySelectorAll('.feedback-notice');
      expect(notices.length).toBe(2);

      // Fast-forward past reading timeout
      await act(async () => {
        vi.advanceTimersByTime(9000);
      });

      // Error notice stays, success notice is dismissed
      const remainingNotices = document.querySelectorAll('.feedback-notice');
      expect(remainingNotices.length).toBe(1);

      vi.useRealTimers();
    });
  });

  // ==========================================
  // 14. Component: ProjectPublishModal.tsx
  // ==========================================
  describe('ProjectPublishModal', () => {
    it('submits repository publish form and displays success link', async () => {
      vi.mocked(api.publishProject).mockResolvedValue({ url: 'https://github.com/buddy/core-telemetry' });
      const onClose = vi.fn();

      await render(<ProjectPublishModal projectId="proj-1" onClose={onClose} />);

      const inputs = host.querySelectorAll('input');
      await act(async () => {
        setNativeInputValue(inputs[0], 'https://github.com/buddy/core-telemetry');
        setNativeInputValue(inputs[1], 'release-1.0');
        setNativeInputValue(inputs[2], 'ghp_secretToken123');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(api.publishProject).toHaveBeenCalledWith('proj-1', 'https://github.com/buddy/core-telemetry', 'release-1.0', 'ghp_secretToken123');
      expect(host.querySelector('[role="status"] a')?.getAttribute('href')).toBe('https://github.com/buddy/core-telemetry');
    });

    it('displays error message on publish failure', async () => {
      vi.mocked(api.publishProject).mockRejectedValue(new Error('Authentication failed for repository.'));
      const onClose = vi.fn();

      await render(<ProjectPublishModal projectId="proj-2" onClose={onClose} />);

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(host.querySelector('.form-error')?.textContent).toBe('Authentication failed for repository.');
    });
  });

  // ==========================================
  // 15. Component: ProjectModal.tsx
  // ==========================================
  describe('ProjectModal', () => {
    it('handles git import with branch and token', async () => {
      const mockProject = { id: 'p-git', name: 'Repo Project', created_at: '2026-10-30' };
      vi.mocked(api.createProjectGit).mockResolvedValue(mockProject as any);
      const onClose = vi.fn();
      const onSuccess = vi.fn();

      await render(<ProjectModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      const nameInput = host.querySelector('input[type="text"]') as HTMLInputElement;
      const urlInput = host.querySelector('input[type="url"]') as HTMLInputElement;
      await act(async () => {
        setNativeInputValue(nameInput, 'Repo Project');
        setNativeInputValue(urlInput, 'https://github.com/org/repo');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(api.createProjectGit).toHaveBeenCalledWith('Repo Project', 'https://github.com/org/repo', '', '');
      expect(onSuccess).toHaveBeenCalledWith(mockProject);
      expect(onClose).toHaveBeenCalled();
    });

    it('handles empty project source creation', async () => {
      const mockProject = { id: 'p-empty', name: 'Empty Canvas', created_at: '2026-10-30' };
      vi.mocked(api.createProjectGit).mockResolvedValue(mockProject as any);
      const onClose = vi.fn();
      const onSuccess = vi.fn();

      await render(<ProjectModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      const sourceSelect = host.querySelector('select') as HTMLSelectElement;
      const nameInput = host.querySelector('input[type="text"]') as HTMLInputElement;

      await act(async () => {
        setNativeInputValue(nameInput, 'Empty Canvas');
        setNativeInputValue(sourceSelect, 'empty');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(api.createProjectGit).toHaveBeenCalledWith('Empty Canvas', '');
      expect(onSuccess).toHaveBeenCalledWith(mockProject);
    });

    it('validates zip archive requirement and file size limit', async () => {
      const onClose = vi.fn();
      const onSuccess = vi.fn();

      await render(<ProjectModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      const sourceSelect = host.querySelector('select') as HTMLSelectElement;
      const nameInput = host.querySelector('input[type="text"]') as HTMLInputElement;

      await act(async () => {
        setNativeInputValue(nameInput, 'Zip Project');
        setNativeInputValue(sourceSelect, 'zip');
      });

      // Submit without selecting zip
      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(host.querySelector('.form-error')?.textContent).toContain('Please select a ZIP file');

      // Oversized zip (> 50 MB)
      const oversizedFile = new File([new ArrayBuffer(100)], 'huge.zip', { type: 'application/zip' });
      Object.defineProperty(oversizedFile, 'size', { value: 60 * 1024 * 1024 });

      const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [oversizedFile] });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(host.querySelector('.form-error')?.textContent).toContain('ZIP archive must not exceed 50 MB');
    });
  });

  // ==========================================
  // 16. Component: SkillEditModal.tsx
  // ==========================================
  describe('SkillEditModal', () => {
    it('loads skill, allows updating description and instructions, and saves changes', async () => {
      vi.mocked(api.fetchSkill).mockResolvedValue({
        name: 'network-triage',
        description: 'Analyzes optical telemetry alarms',
        instructions: 'Check latency values and signal power.',
      });
      vi.mocked(api.updateSkill).mockResolvedValue({} as any);

      const onClose = vi.fn();
      const onSaved = vi.fn().mockResolvedValue(undefined);
      const onDeleted = vi.fn();

      await render(
        <SkillEditModal
          name="network-triage"
          onClose={onClose}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      );

      expect(api.fetchSkill).toHaveBeenCalledWith('network-triage', expect.any(AbortSignal));
      const descInput = host.querySelector('input[maxlength="400"]') as HTMLInputElement;
      const instructionsTextarea = host.querySelector('textarea') as HTMLTextAreaElement;

      expect(descInput.value).toBe('Analyzes optical telemetry alarms');
      expect(instructionsTextarea.value).toBe('Check latency values and signal power.');

      await act(async () => {
        setNativeInputValue(descInput, 'Updated alarm analysis');
        setNativeInputValue(instructionsTextarea, 'Updated step-by-step instructions.');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(api.updateSkill).toHaveBeenCalledWith('network-triage', {
        description: 'Updated alarm analysis',
        instructions: 'Updated step-by-step instructions.',
      });
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('handles skill deletion confirmation and execution', async () => {
      vi.mocked(api.fetchSkill).mockResolvedValue({
        name: 'legacy-skill',
        description: 'Old skill',
        instructions: 'Old instructions',
      });
      vi.mocked(api.deleteSkill).mockResolvedValue(undefined);

      const onClose = vi.fn();
      const onSaved = vi.fn();
      const onDeleted = vi.fn().mockResolvedValue(undefined);

      await render(
        <SkillEditModal
          name="legacy-skill"
          startDelete={true}
          onClose={onClose}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      );

      expect(host.querySelector('.skill-delete-confirm')).not.toBeNull();
      const confirmDeleteBtn = host.querySelector('.skill-delete-confirm') as HTMLButtonElement;

      await act(async () => {
        confirmDeleteBtn.click();
      });

      expect(api.deleteSkill).toHaveBeenCalledWith('legacy-skill');
      expect(onDeleted).toHaveBeenCalledWith('legacy-skill');
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ==========================================
  // 17. Component: BulkUserEditor.tsx
  // ==========================================
  describe('BulkUserEditor', () => {
    const mockUsers: ManagedUser[] = [
      { username: 'user1', display_name: 'User One', email: 'u1@domain.com', groups: [{ id: 'g1', name: 'Engineering' }], is_admin: false },
      { username: 'user2', display_name: 'User Two', email: 'u2@domain.com', groups: [], is_admin: true },
    ];

    it('renders selected users and applies bulk assignment changes', async () => {
      const onSave = vi.fn().mockResolvedValue(true);
      const onClose = vi.fn();

      await render(
        <BulkUserEditor
          users={mockUsers}
          administrators={2}
          busy={false}
          error=""
          onClose={onClose}
          onSave={onSave}
        />
      );

      expect(host.querySelector('.bulk-user-editor')).not.toBeNull();
      const selects = host.querySelectorAll('select');
      expect(selects.length).toBe(1); // role only: groups are managed under Administration

      await act(async () => {
        setNativeInputValue(selects[0], 'admin');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(onSave).toHaveBeenCalledWith({ is_admin: true });
      expect(onClose).toHaveBeenCalled();
    });

    it('prevents demoting all workspace administrators', async () => {
      const onSave = vi.fn();
      const onClose = vi.fn();

      await render(
        <BulkUserEditor
          users={[mockUsers[1]]} // user2 is admin
          administrators={1} // Only 1 administrator exists total
          busy={false}
          error=""
          onClose={onClose}
          onSave={onSave}
        />
      );

      expect(host.textContent).toContain('At least one administrator must remain.');
      const roleSelect = host.querySelectorAll('select')[0];
      const memberOption = roleSelect.querySelector('option[value="member"]') as HTMLOptionElement;
      expect(memberOption.disabled).toBe(true);
    });
  });

  // ==========================================
  // 18. Component: ManagedUserEditor.tsx
  // ==========================================
  describe('ManagedUserEditor', () => {
    const mockUser: ManagedUser = {
      username: 'jdoe',
      display_name: 'John Doe',
      email: 'jdoe@example.com',
      groups: [{ id: 'g1', name: 'Engineering' }],
      is_admin: true,
    };

    it('edits user settings and saves changes when form is dirty', async () => {
      const onSave = vi.fn().mockResolvedValue(true);
      const onClose = vi.fn();

      await render(
        <ManagedUserEditor
          user={mockUser}
          currentUsername="admin_user"
          lastAdministrator={false}
          busy={false}
          error=""
          onClose={onClose}
          onSave={onSave}
        />
      );

      const checkboxes = host.querySelectorAll('input[type="checkbox"]');
      const adminCheckbox = checkboxes[0] as HTMLInputElement;

      await act(async () => {
        adminCheckbox.click();
      });

      const saveBtn = host.querySelector('.directory-primary') as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(false);

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(onSave).toHaveBeenCalledWith({
        ...mockUser,
        is_admin: false,
      });
      expect(onClose).toHaveBeenCalled();
    });

    it('disables admin checkbox when user is the last administrator', async () => {
      await render(
        <ManagedUserEditor
          user={mockUser}
          currentUsername="jdoe"
          lastAdministrator={true}
          busy={false}
          error=""
          onClose={vi.fn()}
          onSave={vi.fn()}
        />
      );

      expect(host.textContent).toContain('Your account');
      expect(host.textContent).toContain('This is the last administrator.');
      const adminCheckbox = host.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement;
      expect(adminCheckbox.disabled).toBe(true);
    });
  });

  // ==========================================
  // 19. Component: OfficeChatReferences.tsx
  // ==========================================
  describe('OfficeChatReferences and OfficeReferenceChips', () => {
    const selectedFiles = [
      { id: 'f1', name: 'Topology.docx', extension: 'docx' },
      { id: 'f2', name: 'Capacity.xlsx', extension: 'xlsx' },
    ];

    it('renders chips and handles navigation and file removal', async () => {
      const onChange = vi.fn();
      await render(<OfficeReferenceChips selected={selectedFiles} onChange={onChange} disabled={false} />);

      const chips = host.querySelectorAll('.office-reference-chip');
      expect(chips.length).toBe(2);

      // Open file
      const openBtn = chips[0].querySelector('button:first-of-type') as HTMLButtonElement;
      await act(async () => {
        openBtn.click();
      });
      expect(navigateOffice).toHaveBeenCalledWith('/office/files/f1');

      // Remove file
      const removeBtn = chips[0].querySelector('button:last-of-type') as HTMLButtonElement;
      await act(async () => {
        removeBtn.click();
      });
      expect(onChange).toHaveBeenCalledWith([selectedFiles[1]]);
    });

    it('opens office files picker dialog, searches and toggles selection', async () => {
      mockFetch((url) => {
        if (url === '/api/office/files') {
          return {
            items: [
              { id: 'f1', name: 'Topology.docx', extension: 'docx', is_owner: true },
              { id: 'f3', name: 'Core_Map.pptx', extension: 'pptx', is_owner: false },
            ],
          };
        }
        return { status: 404 };
      });

      const onChange = vi.fn();
      await render(<OfficeChatReferences selected={[]} onChange={onChange} disabled={false} />);

      const triggerBtn = host.querySelector('button') as HTMLButtonElement;
      await act(async () => {
        triggerBtn.click();
      });

      expect(host.querySelector('.office-reference-picker')).not.toBeNull();
      const searchInput = host.querySelector('.office-reference-picker input') as HTMLInputElement;

      await act(async () => {
        setNativeInputValue(searchInput, 'Topology');
      });

      const checkbox = host.querySelector('.office-reference-results input[type="checkbox"]') as HTMLInputElement;
      await act(async () => {
        checkbox.click();
      });

      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'f1', name: 'Topology.docx' }),
      ]);
    });
  });

  // ==========================================
  // 20. Component: OfficeFilePopup.tsx
  // ==========================================
  describe('OfficeFilePopup', () => {
    it('renders view for html files without invoking DocsAPI', async () => {
      const onClose = vi.fn();
      await render(<OfficeFilePopup file={{ id: 'preview-1', name: 'Report.html' }} onClose={onClose} />);

      expect(host.querySelector('.office-file-popup')).not.toBeNull();
      expect(host.textContent).toContain('Open this HTML file in Office Suite to preview it.');

      const closeBtn = host.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
      await act(async () => {
        closeBtn.click();
      });
      expect(onClose).toHaveBeenCalled();
    });

    it('initializes DocEditor for office documents and handles document ready event', async () => {
      const destroyEditorSpy = vi.fn();
      (window as any).DocsAPI = {
        DocEditor: vi.fn(function (this: any, id: string, config: any) {
          this.destroyEditor = destroyEditorSpy;
          setTimeout(() => {
            config.events?.onDocumentReady?.();
          }, 0);
        }),
      };

      mockFetch((url) => {
        if (url.includes('/api/office/files/doc-1/editor')) {
          return {
            script_url: '/web-apps/apps/api/documents/api.js',
            config: { document: { fileType: 'docx' }, editorConfig: {} },
          };
        }
        return { status: 404 };
      });

      const onClose = vi.fn();
      await render(<OfficeFilePopup file={{ id: 'doc-1', name: 'Spec.docx' }} onClose={onClose} />);

      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });

      expect((window as any).DocsAPI.DocEditor).toHaveBeenCalled();

      // Minimize and expand
      const minBtn = host.querySelector('button[aria-controls$="-body"]') as HTMLButtonElement;
      await act(async () => {
        minBtn.click();
      });
      expect(host.querySelector('.office-file-popup.is-minimized')).not.toBeNull();
    });
  });

  // ==========================================
  // 21. Component: ConversationDocumentViewer.tsx
  // ==========================================
  describe('ConversationDocumentViewer', () => {
    it('fetches and renders markdown preview and handles question asking', async () => {
      mockFetch((url) => {
        if (url.includes('/documents/preview')) {
          return {
            status: 'ready',
            filename: 'Executive_Brief.md',
            text: '# Executive Brief\nAll targets reached.',
          };
        }
        return { status: 404 };
      });

      const onAsk = vi.fn();
      const onClose = vi.fn();

      await render(
        <ConversationDocumentViewer
          sessionId="sess-doc"
          path="/docs/Executive_Brief.md"
          onClose={onClose}
          onAsk={onAsk}
        />
      );

      expect(host.querySelector('.conversation-document-header strong')?.textContent).toBe('Executive_Brief.md');
      expect(host.querySelector('[data-testid="markdown-view"]')?.textContent).toContain('Executive Brief');

      // Submit specific question
      const questionInput = host.querySelector('#document-question') as HTMLInputElement;
      await act(async () => {
        setNativeInputValue(questionInput, 'What are the main risks?');
      });

      const askForm = host.querySelector('.conversation-document-ask')!;
      await act(async () => {
        askForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('What are the main risks?'));

      // Click preset summarize button
      const summarizeBtn = host.querySelectorAll('.conversation-document-ask button')[1] as HTMLButtonElement;
      await act(async () => {
        summarizeBtn.click();
      });
      expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('Summarize this document'));
    });

    it('renders pdf iframe and extracted text collapsible details', async () => {
      mockFetch((url) => {
        if (url.includes('/documents/preview')) {
          return {
            status: 'ready',
            filename: 'Spec.pdf',
            text: 'Extracted PDF text data',
          };
        }
        return { status: 404 };
      });

      await render(
        <ConversationDocumentViewer
          sessionId="sess-pdf"
          path="/docs/Spec.pdf"
          onClose={vi.fn()}
        />
      );

      expect(host.querySelector('iframe')).not.toBeNull();
      expect(host.querySelector('.conversation-document-extracted')).not.toBeNull();
    });

    it('handles document preparation failure and allows retrying', async () => {
      let prepared = false;
      mockFetch((url, init) => {
        if (url.includes('/documents/preview')) {
          return prepared
            ? { status: 'ready', text: 'Ready text' }
            : { status: 'failed', error: 'Extraction service timed out.' };
        }
        if (url.includes('/documents/prepare') && init?.method === 'POST') {
          prepared = true;
          return { ok: true };
        }
        return { status: 404 };
      });

      await render(
        <ConversationDocumentViewer
          sessionId="sess-retry"
          path="/docs/Failed.docx"
          onClose={vi.fn()}
        />
      );

      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Extraction service timed out.');

      const retryBtn = host.querySelector('[role="alert"] button') as HTMLButtonElement;
      await act(async () => {
        retryBtn.click();
      });

      expect(host.querySelector('[data-testid="markdown-view"]')?.textContent).toBe('Ready text');
    });
  });

  // ==========================================
  // 22. Component: DocumentComparison.tsx
  // ==========================================
  describe('DocumentComparison', () => {
    it('uploads documents for comparison, displays diff summary, and allows asking Buddy', async () => {
      mockFetch((url, init) => {
        if (url === '/documents/compare' && init?.method === 'POST') {
          return {
            before_name: 'Original.docx',
            after_name: 'Revised.docx',
            method: 'text_diff',
            summary: { added_lines: 4, removed_lines: 2, unchanged_lines: 50 },
            changes: [
              {
                kind: 'Modified paragraph',
                before: [{ text: 'Old contract term', source: 'Original.docx', location: 'Page 2', line: 12 }],
                after: [{ text: 'New contract term with liability cap', source: 'Revised.docx', location: 'Page 2', line: 12 }],
              },
            ],
          };
        }
        return { status: 404 };
      });

      const onAsk = vi.fn();
      const onClose = vi.fn();

      await render(<DocumentComparison onClose={onClose} onAsk={onAsk} />);

      const fileInputs = host.querySelectorAll('input[type="file"]');
      const file1 = new File(['v1'], 'Original.docx', { type: 'text/plain' });
      const file2 = new File(['v2'], 'Revised.docx', { type: 'text/plain' });

      await act(async () => {
        Object.defineProperty(fileInputs[0], 'files', { value: [file1] });
        Object.defineProperty(fileInputs[1], 'files', { value: [file2] });
        fileInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        fileInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(host.querySelector('.comparison-output')).not.toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toContain('4 added lines · 2 removed lines · 50 unchanged lines');

      const askBtn = host.querySelector('.comparison-output button') as HTMLButtonElement;
      await act(async () => {
        askBtn.click();
      });

      expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('Explain the following document changes'));
    });

    it('validates file size limit (> 25MB)', async () => {
      await render(<DocumentComparison onClose={vi.fn()} />);

      const fileInputs = host.querySelectorAll('input[type="file"]');
      const bigFile = new File(['data'], 'Big.pdf', { type: 'application/pdf' });
      Object.defineProperty(bigFile, 'size', { value: 30 * 1024 * 1024 });

      await act(async () => {
        Object.defineProperty(fileInputs[0], 'files', { value: [bigFile] });
        Object.defineProperty(fileInputs[1], 'files', { value: [bigFile] });
        fileInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        fileInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(host.querySelector('.form-error')?.textContent).toContain('Each document must be 25 MB or smaller.');
    });
  });

  // ==========================================
  // 23. Component: ProjectMemoryPanel.tsx
  // ==========================================
  describe('ProjectMemoryPanel', () => {
    it('loads project memory, updates brief, and saves changes', async () => {
      let savedBrief = 'Goals:\nAutomate optical network testing.';
      mockFetch((url, init) => {
        if (url === '/projects/proj-mem/memory') {
          if (init?.method === 'PUT') {
            const body = JSON.parse(init.body as string);
            savedBrief = body.brief;
            return { brief: savedBrief, revision: 2, expires_at: '2026-12-01T00:00:00Z' };
          }
          return {
            brief: savedBrief,
            revision: 1,
            expires_at: '2026-11-30T00:00:00Z',
            needs_renewal: false,
          };
        }
        return { status: 404 };
      });

      await render(<ProjectMemoryPanel projectId="proj-mem" />);

      const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Goals:\nAutomate optical network testing.');

      await act(async () => {
        setNativeInputValue(textarea, 'Goals:\nAutomate optical network testing.\nDecisions:\nAdopt Python 3.12.');
      });

      expect(host.textContent).toContain('Unsaved changes');

      const saveBtn = host.querySelector('.feature-primary') as HTMLButtonElement;
      await act(async () => {
        saveBtn.click();
      });

      expect(savedBrief).toContain('Adopt Python 3.12.');
      expect(host.textContent).not.toContain('Unsaved changes');
    });

    it('renders renewal prompt and expired message', async () => {
      mockFetch(() => ({
        brief: 'Old Brief',
        revision: 4,
        needs_renewal: true,
        expired: true,
      }));

      await render(<ProjectMemoryPanel projectId="proj-expired" />);

      expect(host.textContent).toContain('Review and save this brief to renew it');
      expect(host.textContent).toContain('This brief expired and its content was removed.');
    });
  });

  // ==========================================
  // 24. Component: DocmostPanel.tsx
  // ==========================================
  describe('DocmostPanel', () => {
    it('returns null when config is disabled or url is missing', async () => {
      await render(<DocmostPanel config={{ enabled: false }} onClose={vi.fn()} />);
      expect(host.innerHTML).toBe('');

      await render(<DocmostPanel config={{ enabled: true }} onClose={vi.fn()} />);
      expect(host.innerHTML).toBe('');
    });

    it('renders embedded iframe when embed is true, handles tab key cycling and closes', async () => {
      const onClose = vi.fn();
      await render(
        <DocmostPanel
          config={{ enabled: true, url: 'https://docs.intranet.buddy/kb', embed: true }}
          onClose={onClose}
        />
      );

      expect(host.querySelector('.docmost-panel')).not.toBeNull();
      const iframe = host.querySelector('iframe');
      expect(iframe?.src).toBe('https://docs.intranet.buddy/kb');

      const panel = host.querySelector('.docmost-panel')!;
      const controls = panel.querySelectorAll('button, a[href], iframe');
      const first = controls[0] as HTMLElement;
      const last = controls[controls.length - 1] as HTMLElement;

      // Tab on last element cycles to first
      last.focus();
      await act(async () => {
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true }));
      });

      // Shift+Tab on first element cycles to last
      first.focus();
      await act(async () => {
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      });

      // Escape key closes
      await act(async () => {
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      // Close button closes
      const closeBtn = panel.querySelector('button:last-of-type') as HTMLButtonElement;
      await act(async () => {
        closeBtn.click();
      });
      expect(onClose).toHaveBeenCalledTimes(2);

      // Backdrop button closes
      const backdropBtn = host.querySelector('.agent-edit-backdrop') as HTMLButtonElement;
      await act(async () => {
        backdropBtn.click();
      });
      expect(onClose).toHaveBeenCalledTimes(3);
    });

    it('renders external link when embed is false', async () => {
      const onClose = vi.fn();
      await render(
        <DocmostPanel
          config={{ enabled: true, url: 'https://docs.intranet.buddy/kb', embed: false }}
          onClose={onClose}
        />
      );

      expect(host.querySelector('.docmost-external a')?.getAttribute('href')).toBe('https://docs.intranet.buddy/kb');
    });
  });

  // ==========================================
  // 25. Component: LiveHtmlSlides.tsx
  // ==========================================
  describe('LiveHtmlSlides', () => {
    const sampleHtml = `
      <!doctype html>
      <html><body>
        <section class="slide"><h1>Welcome to Architecture Review</h1><p>Intro</p></section>
        <section class="slide"><h2>High-level Topology</h2><p>Diagram</p></section>
        <section class="slide"><h3>Capacity Projections</h3><p>Numbers</p></section>
      </body></html>
    `;

    it('parses slides from HTML, navigates slides, and posts update message to iframe', async () => {
      await render(<LiveHtmlSlides html={sampleHtml} />);

      expect(host.querySelector('.live-slide-controls')?.textContent).toContain('Slide 3 of 3 written');
      expect(host.querySelector('.live-slide-title')?.textContent).toContain('Capacity Projections');

      // Click previous slide button
      const prevBtn = host.querySelectorAll('.live-slide-controls button')[0] as HTMLButtonElement;
      await act(async () => {
        prevBtn.click();
      });

      expect(host.querySelector('.live-slide-controls')?.textContent).toContain('Slide 2 of 3 written');
      expect(host.querySelector('.live-slide-title')?.textContent).toContain('High-level Topology');

      // Toggle follow checkbox
      const followCheckbox = host.querySelector('.live-slide-controls input[type="checkbox"]') as HTMLInputElement;
      expect(followCheckbox.checked).toBe(false);
      await act(async () => {
        followCheckbox.click();
      });
      expect(followCheckbox.checked).toBe(true);
    });
  });

  // ==========================================
  // 26. Component: SkillsManager.tsx
  // ==========================================
  describe('SkillsManager', () => {
    const mockSkills: Skill[] = [
      { name: 'skill-incident-triage', description: 'Triages operational incidents' },
      { name: 'skill-doc-summarizer', description: 'Summarizes long pdf files' },
    ];

    it('renders skill list, filters with search, and adds a new skill', async () => {
      vi.mocked(api.createSkill).mockResolvedValue({ name: 'skill-sql-builder', description: 'Generates queries' });
      const onChanged = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();

      await render(
        <SkillsManager skills={mockSkills} onClose={onClose} onChanged={onChanged} />
      );

      expect(host.querySelector('#skills-manager-title')?.textContent).toBe('Manage skills');
      expect(host.querySelectorAll('.skills-manager-list li').length).toBe(2);

      // Search filter
      const searchInput = host.querySelector('.skills-manager-tools input') as HTMLInputElement;
      await act(async () => {
        setNativeInputValue(searchInput, 'summarizer');
      });
      expect(host.querySelectorAll('.skills-manager-list li').length).toBe(1);

      // Click "Add skill"
      const addBtn = host.querySelector('.skills-manager-primary') as HTMLButtonElement;
      await act(async () => {
        addBtn.click();
      });

      expect(host.querySelector('#skills-manager-title')?.textContent).toBe('Add a skill');
      const nameInput = host.querySelector('form input') as HTMLInputElement;
      const descTextarea = host.querySelectorAll('form textarea')[0] as HTMLTextAreaElement;
      const instTextarea = host.querySelectorAll('form textarea')[1] as HTMLTextAreaElement;

      await act(async () => {
        setNativeInputValue(nameInput, 'sql-builder');
        setNativeInputValue(descTextarea, 'Generates optimized SQL queries');
        setNativeInputValue(instTextarea, 'Given schema, generate ANSI SQL statements.');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(api.createSkill).toHaveBeenCalledWith({
        name: 'sql-builder-buddy',
        description: 'Generates optimized SQL queries',
        instructions: 'Given schema, generate ANSI SQL statements.',
      });
      expect(onChanged).toHaveBeenCalled();
    });

    it('handles skill deletion from list view', async () => {
      vi.mocked(api.deleteSkill).mockResolvedValue(undefined);
      const onChanged = vi.fn().mockResolvedValue(undefined);

      await render(
        <SkillsManager skills={mockSkills} onClose={vi.fn()} onChanged={onChanged} />
      );

      const deleteBtn = host.querySelector('.skills-manager-delete-link') as HTMLButtonElement;
      await act(async () => {
        deleteBtn.click();
      });

      expect(host.querySelector('#skills-manager-title')?.textContent).toBe('Delete skill?');
      const confirmDeleteBtn = host.querySelector('.skills-manager-danger') as HTMLButtonElement;
      await act(async () => {
        confirmDeleteBtn.click();
      });

      expect(api.deleteSkill).toHaveBeenCalledWith('skill-incident-triage');
      expect(onChanged).toHaveBeenCalled();
    });

    it('validates invalid skill name and allows editing existing skill', async () => {
      vi.mocked(api.fetchSkill).mockResolvedValue({
        name: 'skill-incident-triage',
        description: 'Triages operational incidents',
        instructions: 'Check priority and assign owner.',
      });
      vi.mocked(api.updateSkill).mockResolvedValue({} as any);
      const onChanged = vi.fn().mockResolvedValue(undefined);

      await render(
        <SkillsManager skills={mockSkills} startCreate={true} onClose={vi.fn()} onChanged={onChanged} />
      );

      // Invalid name starting with number
      const nameInput = host.querySelector('form input') as HTMLInputElement;
      const descTextarea = host.querySelectorAll('form textarea')[0] as HTMLTextAreaElement;
      const instTextarea = host.querySelectorAll('form textarea')[1] as HTMLTextAreaElement;

      await act(async () => {
        setNativeInputValue(nameInput, '123-invalid');
        setNativeInputValue(descTextarea, 'Valid description');
        setNativeInputValue(instTextarea, 'Valid instructions');
      });

      const form = host.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      expect(host.querySelector('.skills-manager-error')?.textContent).toContain('Use a name starting with a letter');

      // Click Back to skills
      const backBtn = host.querySelector('.skills-manager-footer button') as HTMLButtonElement;
      await act(async () => {
        backBtn.click();
      });

      // Edit skill
      const editBtn = host.querySelector('.skills-manager-row-actions button') as HTMLButtonElement;
      await act(async () => {
        editBtn.click();
      });
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });

      expect(api.fetchSkill).toHaveBeenCalledWith('skill-incident-triage', expect.any(AbortSignal));
      const editInstructions = host.querySelectorAll('form textarea')[1] as HTMLTextAreaElement;
      await act(async () => {
        setNativeInputValue(editInstructions, 'Updated triage steps.');
      });

      const submitBtn = host.querySelector('form button[type="submit"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });

      expect(api.updateSkill).toHaveBeenCalledWith('skill-incident-triage', {
        description: 'Triages operational incidents',
        instructions: 'Updated triage steps.',
      });
      expect(onChanged).toHaveBeenCalled();
    });
  });

  // ==========================================
  // 27. Component: MCPManager.tsx
  // ==========================================
  describe('MCPManager', () => {
    const mockServers: MCPServer[] = [
      { name: 'gitlab-mcp', transport: 'http', target: 'http://localhost:8080', enabled: true },
    ];

    it('renders server list and allows administrator to define server and refresh connections', async () => {
      const onAdd = vi.fn();
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const onDelete = vi.fn().mockResolvedValue(undefined);
      const onConfigure = vi.fn();
      const onClose = vi.fn();

      await render(
        <MCPManager
          servers={mockServers}
          isAdmin={true}
          onAdd={onAdd}
          onRefresh={onRefresh}
          onDelete={onDelete}
          onConfigure={onConfigure}
          onClose={onClose}
        />
      );

      expect(host.querySelector('.mcp-manager')).not.toBeNull();
      expect(host.querySelector('[data-testid="mock-mcp-card-gitlab-mcp"]')).not.toBeNull();

      // Click Add server
      const addBtn = host.querySelector('.mcp-manager-actions .feature-primary') as HTMLButtonElement;
      await act(async () => {
        addBtn.click();
      });
      expect(onAdd).toHaveBeenCalled();

      // Click Refresh connections
      const refreshBtn = host.querySelectorAll('.mcp-manager-actions button')[1] as HTMLButtonElement;
      await act(async () => {
        refreshBtn.click();
      });
      expect(onRefresh).toHaveBeenCalled();

      // Trigger card configure
      const configureBtn = host.querySelector('[data-testid="mock-mcp-card-gitlab-mcp"] button:nth-of-type(2)') as HTMLButtonElement;
      await act(async () => {
        configureBtn.click();
      });
      expect(onConfigure).toHaveBeenCalledWith('gitlab-mcp');

      // Trigger card delete
      const deleteBtn = host.querySelector('[data-testid="mock-mcp-card-gitlab-mcp"] button:nth-of-type(3)') as HTMLButtonElement;
      await act(async () => {
        deleteBtn.click();
      });
      expect(onDelete).toHaveBeenCalledWith('gitlab-mcp');

      // Keydown Escape
      const managerDialog = host.querySelector('.mcp-manager') as HTMLElement;
      await act(async () => {
        managerDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      // Keydown Tab cycle
      const focusables = managerDialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];

      lastEl.focus();
      await act(async () => {
        managerDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true }));
      });

      firstEl.focus();
      await act(async () => {
        managerDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      });
    });

    it('handles refresh failure error and empty states for admin vs non-admin', async () => {
      const onRefresh = vi.fn().mockRejectedValue(new Error('Connection timeout'));
      await render(
        <MCPManager
          servers={[]}
          isAdmin={true}
          onAdd={vi.fn()}
          onRefresh={onRefresh}
          onDelete={vi.fn()}
          onConfigure={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(host.textContent).toContain('No MCP connections configured.');

      const refreshBtn = host.querySelectorAll('.mcp-manager-actions button')[1] as HTMLButtonElement;
      await act(async () => {
        refreshBtn.click();
      });

      expect(host.querySelector('.form-error')?.textContent).toContain('Could not refresh connections.');

      // Render as non-admin with empty servers
      await render(
        <MCPManager
          servers={[]}
          isAdmin={false}
          onAdd={vi.fn()}
          onRefresh={vi.fn()}
          onDelete={vi.fn()}
          onConfigure={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(host.textContent).toContain('No MCP connections are available for your groups.');
    });
  });

  // ==========================================
  // 28. Component: ProductivityWorkspace.tsx
  // ==========================================
  describe('ProductivityWorkspace', () => {
    it('manages meeting tab: transcript extraction and task handoff launch', async () => {
      const onClose = vi.fn();
      const onLaunch = vi.fn();

      await render(<ProductivityWorkspace onClose={onClose} onLaunch={onLaunch} />);

      const transcriptTextarea = host.querySelector('textarea') as HTMLTextAreaElement;
      await act(async () => {
        setNativeInputValue(transcriptTextarea, 'Speaker 1: We decided to deploy telemetry agents by Nov 15.');
      });

      const extractBtn = host.querySelectorAll('section > button')[0] as HTMLButtonElement;
      await act(async () => {
        extractBtn.click();
      });

      expect(onLaunch).toHaveBeenCalledWith(expect.stringContaining('TRANSCRIPT:'), undefined);
      expect(onClose).toHaveBeenCalled();

      // Test handoff flow with actions
      const onLaunchHandoff = vi.fn();
      const onCloseHandoff = vi.fn();
      await render(<ProductivityWorkspace onClose={onCloseHandoff} onLaunch={onLaunchHandoff} />);

      const decisionsTextarea = host.querySelectorAll('textarea')[1] as HTMLTextAreaElement;
      await act(async () => {
        setNativeInputValue(decisionsTextarea, 'Confirmed upgrade schedule.');
      });

      // Add action
      const addActionBtn = host.querySelector('button:not(:disabled):nth-of-type(4)') as HTMLButtonElement;
      const addBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Add action') as HTMLButtonElement;
      await act(async () => {
        addBtn.click();
      });

      const actionInputs = host.querySelectorAll('.feature-row input');
      await act(async () => {
        setNativeInputValue(actionInputs[0] as HTMLInputElement, 'Deploy edge proxies');
        setNativeInputValue(actionInputs[1] as HTMLInputElement, 'Alice');
        setNativeInputValue(actionInputs[2] as HTMLInputElement, '2026-11-20');
      });

      // Remove an action
      const removeBtn = host.querySelector('.feature-row button') as HTMLButtonElement;
      await act(async () => {
        removeBtn.click();
      });

      // Prepare handoff in chat
      const handoffBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Prepare handoff in chat') as HTMLButtonElement;
      await act(async () => {
        handoffBtn.click();
      });

      expect(onLaunchHandoff).toHaveBeenCalledWith(expect.stringContaining('Prepare a proposed Monday task handoff'), undefined);
      expect(onCloseHandoff).toHaveBeenCalled();
    });

    it('manages recipes tab: loads, copies, runs, and deletes recipes', async () => {
      mockFetch((url, init) => {
        if (url === '/productivity/recipes') {
          if (init?.method === 'POST') {
            return { ok: true };
          }
          return [
            { id: 'r1', name: 'Executive Brief Recipe', instructions: 'Generate 3 bullets', sources: 'Doc', output: 'report' },
          ];
        }
        if (url.includes('/productivity/recipes/r1') && init?.method === 'DELETE') {
          return { ok: true };
        }
        return { status: 404 };
      });

      const onClose = vi.fn();
      const onLaunch = vi.fn();

      await render(<ProductivityWorkspace onClose={onClose} onLaunch={onLaunch} />);

      // Switch to 'recipes' tab
      const navButtons = host.querySelectorAll('nav button');
      await act(async () => {
        (navButtons[2] as HTMLButtonElement).click();
      });

      expect(host.textContent).toContain('Executive Brief Recipe');

      // Copy to edit
      const copyBtn = host.querySelectorAll('.feature-row button')[1] as HTMLButtonElement;
      await act(async () => {
        copyBtn.click();
      });

      // Delete recipe
      const deleteBtn = host.querySelectorAll('.feature-row button')[2] as HTMLButtonElement;
      await act(async () => {
        deleteBtn.click();
      });

      // Submit new recipe form
      const recipeNameInput = host.querySelector('form input') as HTMLInputElement;
      const recipeTextareas = host.querySelectorAll('form textarea');
      await act(async () => {
        setNativeInputValue(recipeNameInput, 'New Audit Recipe');
        setNativeInputValue(recipeTextareas[0] as HTMLTextAreaElement, 'Audit network rules');
        setNativeInputValue(recipeTextareas[1] as HTMLTextAreaElement, 'Policy docs');
      });

      const recipeForm = host.querySelector('form')!;
      await act(async () => {
        recipeForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      // Click Run recipe
      const runBtn = host.querySelector('.feature-row button:first-of-type') as HTMLButtonElement;
      await act(async () => {
        runBtn.click();
      });

      expect(onLaunch).toHaveBeenCalledWith(expect.stringContaining('Generate 3 bullets'), 'report');
      expect(onClose).toHaveBeenCalled();
    });

    it('manages data tab: explores csv, applies calculations, and exports datasets', async () => {
      mockFetch((url, init) => {
        if (url === '/productivity/csv/explore' && init?.method === 'POST') {
          return {
            headers: ['Node', 'Latency', 'Loss'],
            rows: [['Router-A', '12', '0.01'], ['Router-B', '18', '0.05']],
            total_rows: 2,
            matched_rows: 2,
            stats: { column: 'Latency', count: 2, excluded: 0, sum: 30, mean: 15, min: 12, max: 18 },
            provenance: { filter: '', method: 'direct', source: 'test.csv' },
          };
        }
        if (url.includes('/productivity/spreadsheet/import') && init?.method === 'POST') {
          return {
            content: 'Node,Latency\nA,10',
            exploration: {
              headers: ['Node', 'Latency'],
              rows: [['A', '10']],
              total_rows: 1,
              matched_rows: 1,
              stats: { column: 'Latency', count: 1, excluded: 0, sum: 10, mean: 10, min: 10, max: 10 },
              provenance: { filter: '', method: 'excel', source: 'test.xlsx' },
            },
            sheets: ['Sheet1', 'Sheet2'],
            sheet: 'Sheet1',
          };
        }
        return { status: 404 };
      });

      await render(<ProductivityWorkspace onClose={vi.fn()} onLaunch={vi.fn()} />);

      // Switch to 'data' tab
      const navButtons = host.querySelectorAll('nav button');
      await act(async () => {
        (navButtons[1] as HTMLButtonElement).click();
      });

      // Upload CSV
      const file = new File(['Node,Latency,Loss\nRouter-A,12,0.01\nRouter-B,18,0.05'], 'test.csv', { type: 'text/csv' });
      const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement;

      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(host.textContent).toContain('test.csv: 2 of 2 rows');
      expect(host.textContent).toContain('Sum: 30; mean: 15');

      // Apply filter and column
      const filterInput = host.querySelector('form input') as HTMLInputElement;
      const columnSelect = host.querySelector('form select') as HTMLSelectElement;
      await act(async () => {
        setNativeInputValue(filterInput, 'Router');
        setNativeInputValue(columnSelect, '1');
      });

      const calcForm = host.querySelector('form')!;
      await act(async () => {
        calcForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

      // Export buttons
      const exportCsvBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Export filtered CSV') as HTMLButtonElement;
      await act(async () => {
        exportCsvBtn.click();
      });

      const exportProvBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Export calculations and provenance') as HTMLButtonElement;
      await act(async () => {
        exportProvBtn.click();
      });

      // Upload XLSX
      const xlsxFile = new File(['binary'], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      await act(async () => {
        Object.defineProperty(fileInput, 'files', { value: [xlsxFile], configurable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(host.textContent).toContain('Sheet1');
      const sheetSelect = host.querySelector('label select') as HTMLSelectElement;
      await act(async () => {
        setNativeInputValue(sheetSelect, 'Sheet2');
      });
      expect(sheetSelect).not.toBeNull();
    });
  });

  // ==========================================
  // 29. Component: AnalysisWorkspace.tsx
  // ==========================================
  describe('AnalysisWorkspace', () => {
    const validData = {
      title: 'Quarterly Bandwidth Utilization',
      headers: ['Region', 'Usage (Gbps)', 'Capacity (Gbps)'],
      rows: [
        ['EMEA', 450, 800],
        ['APAC', 320, 600],
        ['Americas', 610, 1000],
      ],
      source: 'Internal Telemetry Data Mart',
    };

    it('renders interactive analysis table and handles expand dialog and followup prompt', async () => {
      const onPrompt = vi.fn();
      const onFiltersChange = vi.fn();

      await render(
        <AnalysisWorkspace
          {...validData}
          onPrompt={onPrompt}
          onFiltersChange={onFiltersChange}
        />
      );

      expect(host.querySelector('.analysis-workspace h3')?.textContent).toBe('Quarterly Bandwidth Utilization');
      expect(host.querySelector('.analysis-source')?.textContent).toContain('Internal Telemetry Data Mart');
      expect(host.querySelector('.interactive-table-panel')).not.toBeNull();

      // Open expanded dialog
      const expandBtn = host.querySelector('.chart-maximize-button') as HTMLButtonElement;
      await act(async () => {
        expandBtn.click();
      });

      const dialog = host.querySelector('dialog.chart-maximized-dialog') as HTMLDialogElement;
      expect(dialog.open).toBe(true);

      // Close dialog
      const closeDialogBtn = dialog.querySelector('.chart-maximize-button') as HTMLButtonElement;
      await act(async () => {
        closeDialogBtn.click();
      });
      expect(dialog.open).toBe(false);

      // Click "Analyze whole dataset"
      const promptBtn = host.querySelector('.analysis-followup') as HTMLButtonElement;
      await act(async () => {
        promptBtn.click();
      });

      expect(onPrompt).toHaveBeenCalledWith(expect.stringContaining('Analyze the supplied dataset “Quarterly Bandwidth Utilization”'));
    });

    it('handles incomplete datasets with missing or nonnumeric values gracefully', async () => {
      const incompleteData = {
        title: 'Incomplete Audit Data',
        headers: ['Metric', 'Score'],
        rows: [
          ['Availability', 99.9],
          ['Throughput', null], // incomplete
        ],
      };

      await render(<AnalysisWorkspace {...incompleteData} />);

      expect(host.querySelector('[role="note"]')?.textContent).toContain('Missing or nonnumeric measurements remain unchanged.');
    });

    it('shows error state when analysis data is invalid or empty', async () => {
      await render(<AnalysisWorkspace title="Empty Dataset" headers={[]} rows={[]} />);

      expect(host.querySelector('[role="status"]')?.textContent).toContain('Analysis data is unavailable or invalid.');
    });
  });
});
